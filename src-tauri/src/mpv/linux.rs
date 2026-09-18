// Linux (GTK3) native video surface for the mpv-embed engine.
//
// THE ACTUAL WIDGET TREE (verified against tauri-runtime-wry 2.11.4 + wry
// 0.55.1 sources, which build the main webview via `build_gtk(vbox)` where
// `vbox` is tao's window-default vertical GtkBox):
//
//   gtk::ApplicationWindow            (tao)
//   └─ gtk::Box (vertical)            (tao's default_vbox)
//      └─ webkit2gtk::WebView         (wry, pack_start'ed, expand+fill)
//
// The reparent (all on the GTK main thread, once, at engine init) — the
// video sits ABOVE the page, not under it:
//   1. create a GtkOverlay and make the WebView its BASE child (the page,
//      fully OPAQUE — the app never punches a transparency hole again),
//   2. add ONE full-size GtkFixed as the overlay's only overlay child, and
//      place every engine's GtkEventBox (own GdkWindow, wrapping the
//      GtkGLArea mpv renders into) inside that Fixed via put()/move_().
//      GtkFixed is THE positioning container here, chosen against the
//      overlay's own child placement after reading gtkoverlay.c:
//      gtk_overlay_child_allocate() calls gdk_window_move_resize() on each
//      visible child's per-child GdkWindow on EVERY allocation pass,
//      re-defaulting it to the computed halign/valign spot — a correction
//      hook only survives that if the child's size-allocate re-emits, which
//      gtk skips for unchanged allocations. With several equal-sized video
//      quadrants that stranded bottom-row surfaces at the default (0,0)
//      spot (the "tiles render in the top row" round). GtkFixed instead
//      positions children THROUGH their allocation (gtk_fixed_size_allocate
//      → gtk_widget_size_allocate at (child.x, child.y)) — the allocation
//      IS the position, nothing ever re-defaults the window, and an
//      unchanged allocation short-circuit leaves the window exactly where
//      it already is. The Fixed itself is parented into the overlay's
//      per-child GdkWindow (created at overlay realize, re-shown ⇒ RAISED
//      above the webview on every pass) which spans the placed children;
//      input shapes make that full-size window click-through (see below).
//      (The original "no GtkFixed" objection — it swallowed every click —
//      predates the 1px-corner input shapes; with them the Fixed's window
//      is pointer-transparent exactly like the video windows.)
//   3. REPLACE THE WINDOW'S CHILD: window.remove(vbox), window.add(overlay).
// Step 3 is load-bearing — the overlay must be the window's direct GtkBin
// child: tauri's undecorated-resize handler walks `webview.parent().parent()`
// and unwraps a gtk::Window downcast of the grandparent in a C callback that
// cannot unwind. webview(base) → overlay → window satisfies it; packing the
// overlay inside tao's vbox does NOT (grandparent = GtkBox → SIGABRT on the
// first click — this shipped once). tao's now-unparented vbox stays alive
// via tao's own reference and is never re-read after startup except by the
// unused webview-reparenting feature.
//
// WHY ABOVE (no transparency anywhere): WebKitGTK cannot render
// transparent regions correctly on this stack — its webview surface NEVER
// CLEARS between frames (observed three ways: stale-opaque-pixel smears
// that clear only on a ~20 s incidental flush; a 2/255 fold tint that
// ACCUMULATED to solid black; and a GL-free vanilla transparent window
// whose hole lagged seconds behind). Every working web-UI-over-mpv app
// (Stremio, iptvnator) uses Chromium. So this design uses NO transparency:
// the page stays opaque, the video surface sits on top of it, and every
// GdkWindow on the video side (the overlay's per-child window, the
// EventBox's own, the GLArea's) carries a 1px-corner input shape so every
// pointer event over the video falls through to the page beneath — the
// existing HTML click/wheel/dblclick handlers on the (invisible,
// hit-testable) <video> keep working, and the HTML controls render in a
// strip BELOW the video instead of over it.
//
// mpv renders through the render API into the GLArea's framebuffer on the
// GLArea's `render` signal: GTK binds the area's own FBO before emitting it,
// so the draw-FBO binding is read via glGetIntegerv and handed to mpv
// together with the pixel size (allocation × scale factor) and flip_y=true
// (GL renders Y-up, video is Y-down). mpv's update callback marshals to the
// main thread and calls queue_render(); GTK/GL is never touched from mpv's
// threads.
//
// PAGE UI ABOVE THE VIDEO (the "layers" question): the app's dialogs,
// dropdowns, tooltips and toasts are webview pixels and the webview sits
// UNDER the video — GTK cannot raise PART of a webview, and making the
// whole page transparent is the design WebKitGTK disproved (see the
// post-mortem above). Instead the engine re-draws their PIXELS over the
// video: `webkit_web_view_get_snapshot` rasterizes the page, the crop over
// the overlapping UI is composited through the same overlay-add path as
// the OSD's avatar/thumbnail bitmaps, and pointer input already falls
// through the video's input shapes onto the real elements underneath — so
// the overlaid UI is visible AND interactive (see `page_snapshot`).
//
// GL symbols are resolved through a dlopened libGL.so.1 / libOpenGL.so.0 —
// on GLVND systems (every modern distro) both export the RAW gl* entry
// points as real FUNC symbols that dispatch on the current context, which
// is exactly the loader mpv's render API needs. Deliberately NOT libepoxy:
// Debian's 1.5.10 has no generic epoxy_get_proc_address at all, and its
// per-function exports are lazy 8-byte pointer CELLS (OBJECT symbols in
// .data), not callable symbols — unusable as mpv's loader without ABI
// games. (This bit the first shipped build as "libepoxy.so.0 is missing
// epoxy_get_proc_address".)

use std::ffi::{c_int, c_void};
use std::sync::mpsc;
use std::time::{Duration, Instant};

use gtk::prelude::*;
use libmpv2::render::{OpenGLInitParams, RenderParam, RenderParamApiType};
use libmpv2::Mpv;
use tauri::{AppHandle, Manager};

use super::VideoSurface;

// GL_DRAW_FRAMEBUFFER_BINDING (== GL_FRAMEBUFFER_BINDING, 0x8CA6): the FBO
// GTK bound for this GLArea's render pass.
const GL_DRAW_FRAMEBUFFER_BINDING: i32 = 0x8CA6;

// ---------------------------------------------------------------------------
// GL symbol resolution (GLVND libGL / libOpenGL)

/// A dlopened GL provider, leaked for the process lifetime. Only `libGL.so.1`
/// and `libOpenGL.so.0` are tried, in that order; the first whose raw `gl*`
/// ABI checks out wins (a stub or unexpectedly minimal library must not
/// become mpv's GL loader). Shared by EVERY engine surface (one dlopen);
/// cloned per render context (it is just the leaked library reference).
#[derive(Clone)]
pub(super) struct GlLib {
    lib: &'static libloading::Library,
}

impl GlLib {
    fn load() -> Result<Self, String> {
        let mut errors: Vec<String> = Vec::new();
        for name in ["libGL.so.1", "libOpenGL.so.0"] {
            // SAFETY: dlopen of a system library; single call at engine init.
            let lib = match unsafe { libloading::Library::new(name) } {
                Ok(lib) => Box::leak(Box::new(lib)),
                Err(e) => {
                    errors.push(format!("{name}: {e}"));
                    continue;
                }
            };
            // SAFETY: the library is leaked and never unloaded.
            let probe: Result<libloading::Symbol<unsafe extern "C" fn()>, _> =
                unsafe { lib.get(b"glGetString") };
            if probe.is_ok() {
                return Ok(GlLib { lib });
            }
            errors.push(format!("{name}: exports no raw gl* entry points"));
        }
        Err(format!("no usable GL library ({})", errors.join("; ")))
    }

    fn get(&self, name: &str) -> *mut c_void {
        // A plain dlsym: GLVND's gl* trampolines dispatch on the CURRENT
        // context, so the same lookup serves both mpv's loader and our own
        // glGetIntegerv. Unknown names resolve to null (mpv handles that).
        // SAFETY: lookups only, against the leaked library.
        unsafe { self.lib.get::<unsafe extern "C" fn()>(name.as_bytes()) }
            .map(|f| *f as *mut c_void)
            .unwrap_or(std::ptr::null_mut())
    }
}

/// mpv's GL loader — called for every GL symbol the renderer needs.
fn mpv_get_proc_address(ctx: &GlLib, name: &str) -> *mut c_void {
    ctx.get(name)
}

type GlGetIntegervFn = unsafe extern "C" fn(c_int, *mut c_int);

/// The GL calls the render path needs (read the bound draw FBO), resolved
/// once at the first surface init and only ever called on the main thread
/// from a GLArea render callback. `None` until then.
static GL_GET_INTEGERV: std::sync::OnceLock<GlGetIntegervFn> = std::sync::OnceLock::new();

/// The shared GLVND provider (see `GlLib`). Every engine's render context
/// resolves its symbols through this one dlopen.
static GL_LIB: std::sync::OnceLock<GlLib> = std::sync::OnceLock::new();

fn gl_lib() -> Result<&'static GlLib, String> {
    if let Some(gl) = GL_LIB.get() {
        return Ok(gl);
    }
    let gl = GlLib::load()?;
    let _ = GL_LIB.set(gl);
    Ok(GL_LIB.get().expect("GL provider just set"))
}

/// Page-snapshot coalescing window, PER ENGINE: each snapshot re-renders
/// the whole page, so requests for the SAME engine inside the window are
/// skipped. 70 ms ≈ the measured p95 of the WebKit composite itself
/// (measured on hardware 2026-09-18: cb-latency p50 48 ms
/// / p95 66 ms; the full-viewport snapshot dominates — every later stage
/// is ≤1.6 ms at p95, and crop size is irrelevant next to it) — set to
/// roughly that p95, never below, so a fresh composite starts only after
/// the previous one has very likely finished on this same GTK-main/video
/// thread. RE-VALIDATED AT 4K (view 3840x1972, same day, mpvfix63):
/// cb p50 34 ms / p95 67 ms / max 98 ms — the composite's cost is
/// resolution-insensitive in this range, so the window holds at 4K too. A coalesced request now resolves Ok(false) so the frontend
/// can retry it once the window expires. A TIMESTAMP, deliberately not
/// an in-flight flag — if WebKit ever failed to invoke the completion, a
/// flag would wedge the path for the whole session while the window
/// simply expires.
///
/// Per-ENGINE, not global, on purpose: page UI overlapping TWO tiles (a
/// favorites tooltip across the grid seam) must snapshot on BOTH — a
/// global window swallowed the second engine's request (and every
/// settle-burst retry behind the first engine's), truncating the tooltip
/// to the first tile's fragment.
static PAGE_SNAPSHOT_LAST: std::sync::OnceLock<
    std::sync::Mutex<std::collections::HashMap<u32, Instant>>,
> = std::sync::OnceLock::new();

/// The coalesce window length (see PAGE_SNAPSHOT_LAST's doc for the
/// measured rationale). The frontend's drop-retry delay must stay
/// comfortably above this.
const SNAPSHOT_COALESCE_MS: u64 = 70;

// ---------------------------------------------------------------------------
// Widget handles across threads

/// A GTK widget reference made Send. GTK is single-threaded; these handles
/// only ever travel INTO a main-thread dispatch (run_on_main_thread /
/// glib invoke), where — and only where — `with` unwraps them. Unwrapping on
/// any other thread would be UB.
struct MainThread<T>(T);
unsafe impl<T> Send for MainThread<T> {}
unsafe impl<T> Sync for MainThread<T> {}
impl<T: Clone> Clone for MainThread<T> {
    fn clone(&self) -> Self {
        // For GTK widgets this is the gtk-rs refcount bump (atomic), safe on
        // any thread — the wrapper's Send/Sync claims cover exactly this.
        MainThread(self.0.clone())
    }
}

impl<T> MainThread<T> {
    /// Unwrap ON the dispatch thread. A method call on the whole value also
    /// defeats edition-2021 precise closure capture (a bare `wrapper.0` use
    /// would capture the raw widget and strip the Send wrapper).
    fn with<R>(self, f: impl FnOnce(T) -> R) -> R {
        f(self.0)
    }
}

/// The one-time widget-tree bootstrap (see the module header): the
/// GtkOverlay the webview was reparented into, plus the ONE full-size
/// GtkFixed carrying every engine's EventBox (the positioning container).
/// Created by the FIRST engine's surface init; every later engine
/// (multi-view tiles) only puts its EventBox into the SAME Fixed — the
/// reparent itself must run exactly once or the second
/// `window.remove(vbox)` would misfire.
struct OverlayBootstrap {
    overlay: MainThread<gtk::Overlay>,
    fixed: MainThread<gtk::Fixed>,
}
static OVERLAY_BOOTSTRAP: std::sync::OnceLock<OverlayBootstrap> = std::sync::OnceLock::new();

// ---------------------------------------------------------------------------
// The surface

pub(super) struct LinuxSurface {
    app: AppHandle,
    fixed: MainThread<gtk::Fixed>,
    video_box: MainThread<gtk::EventBox>,
    gl_area: MainThread<gtk::GLArea>,
    /// Last rect pushed by the frontend (-1 = none yet). The frontend
    /// pushes the rect on every coalesced scroll/resize/zoom tick;
    /// applying an identical rect would queue a pointless relayout each
    /// time, so identical pushes are dropped in set_rect.
    last_rect: std::sync::Arc<std::sync::Mutex<(i32, i32, i32, i32)>>,
    /// Whether the video surface is currently shown. Guards the show path:
    /// the event thread reveals the surface on EVERY PlaybackRestart (seek,
    /// unpause, …), and each show dispatches to the GTK main thread — the
    /// flag collapses the repeats to one dispatch per reveal.
    shown: std::sync::atomic::AtomicBool,
}

impl VideoSurface for LinuxSurface {
    fn show(&self) {
        if self.shown.swap(true, std::sync::atomic::Ordering::AcqRel) {
            return;
        }
        let video_box = MainThread(self.video_box.0.clone());
        let area = MainThread(self.gl_area.0.clone());
        let rect = self.last_rect.clone();
        let _ = self.app.run_on_main_thread(move || {
            video_box.with(|video_box| {
                area.with(|area| {
                    // show_all: also reveals the GLArea inside (it stays
                    // hidden until the first frame presents). Showing the
                    // EventBox queues a Fixed relayout, which allocates it
                    // at its stored (x, y) — and if a rect is already
                    // known, the box's own window is ALSO moved directly so
                    // the reveal lands in place without waiting for the
                    // queued relayout (see set_rect).
                    video_box.show_all();
                    let (x, y, w, h) = *rect.lock().expect("mpv rect lock poisoned");
                    if x >= 0 && video_box.is_mapped() {
                        if let Some(win) = video_box.window() {
                            if win.parent().is_some() {
                                win.move_resize(x, y, w.max(1), h.max(1));
                            }
                        }
                    }
                    area.queue_render();
                });
            });
        });
    }

    fn hide(&self) {
        self.shown
            .store(false, std::sync::atomic::Ordering::Release);
        let video_box = MainThread(self.video_box.0.clone());
        let _ = self.app.run_on_main_thread(move || {
            video_box.with(|video_box| video_box.hide());
        });
    }

    fn set_rect(&self, x: i32, y: i32, w: i32, h: i32) {
        {
            let mut last = self.last_rect.lock().expect("mpv rect lock poisoned");
            if *last == (x, y, w, h) {
                return;
            }
            *last = (x, y, w, h);
        }
        let fixed = MainThread(self.fixed.0.clone());
        let video_box = MainThread(self.video_box.0.clone());
        let area = MainThread(self.gl_area.0.clone());
        let _ = self.app.run_on_main_thread(move || {
            fixed.with(|fixed| {
                video_box.with(|video_box| {
                    area.with(|area| {
                        // GtkFixed IS the positioning container: move_
                        // stores (x, y) and queues a relayout that
                        // allocates the EventBox there. The size request
                        // drives the allocation SIZE (and with it the
                        // GLArea → FBO). Both take effect whether the box
                        // is hidden (stored, applied when shown) or
                        // already mapped. NEGATIVE x/y are valid and
                        // load-bearing: the page can scroll the video rect
                        // past the window edge (down to the channel-content
                        // page), and the surface must slide out WITH it —
                        // the GdkWindow is simply clipped by its parent.
                        // Clamping to 0 here pinned the video at the
                        // window border, covering the content the user
                        // scrolled to. Only the SIZE is clamped (a 0-size
                        // GLArea would break the FBO path).
                        fixed.move_(&video_box, x, y);
                        video_box.set_size_request(w.max(1), h.max(1));
                        // Belt and suspenders: a MAPPED box's own GdkWindow
                        // is also moved DIRECTLY, so the new position lands
                        // even if the queued relayout would not re-emit
                        // size-allocate for it (unchanged allocation). The
                        // Fixed's own allocation path agrees with this
                        // position — the two never fight, they assert the
                        // same rect.
                        if video_box.is_mapped() {
                            if let Some(win) = video_box.window() {
                                if win.parent().is_some() {
                                    win.move_resize(x, y, w.max(1), h.max(1));
                                }
                            }
                        }
                        video_box.queue_resize();
                        area.queue_render();
                    });
                });
            });
        });
    }
}

/// Build one engine's surface. The FIRST call performs the one-time widget
/// reparent (webview → GtkOverlay as the window's direct child); every call
/// (including the first) then adds a per-engine EventBox+GLArea overlay
/// child, wires the GLArea render signal to a render context created on that
/// area's own GL context, and hands back a handle. Runs its GTK work inside
/// `with_webview` (main thread) and blocks on the result.
pub(super) fn create(
    app: &AppHandle,
    mpv: &'static Mpv,
    _id: u32,
) -> Result<Box<dyn VideoSurface>, String> {
    let window = app
        .get_webview_window(crate::tray::MAIN_WINDOW)
        .ok_or("main window not found")?;
    let (tx, rx) = mpsc::channel();
    let app_handle = app.clone();
    window
        .with_webview(move |webview| {
            let result = init_on_main_thread(webview.inner(), mpv, app_handle);
            let _ = tx.send(result);
        })
        .map_err(|e| format!("with_webview dispatch failed: {e}"))?;
    let surface = rx
        .recv_timeout(Duration::from_secs(10))
        .map_err(|_| "surface init timed out (GTK main thread stuck?)".to_string())??;
    Ok(Box::new(surface))
}

/// One engine's surface bootstrap, executed on the GTK main thread.
fn init_on_main_thread(
    webview: webkit2gtk::WebView,
    mpv: &'static Mpv,
    app: AppHandle,
) -> Result<LinuxSurface, String> {
    let gl = gl_lib()?;

    // ---- one-time reparent (first engine only; see OVERLAY_BOOTSTRAP) ----
    let (_overlay, fixed) = if let Some(bootstrap) = OVERLAY_BOOTSTRAP.get() {
        (
            bootstrap.overlay.clone().with(|overlay| overlay),
            bootstrap.fixed.clone().with(|fixed| fixed),
        )
    } else {
        // The tree MUST match what tao/wry build today (see the module
        // header). A dynamic check keeps a future layout change a clear
        // error instead of silent breakage.
        let parent = webview
            .parent()
            .ok_or("webview has no parent widget (tao/wry layout changed?)")?;
        let vbox = parent
            .downcast_ref::<gtk::Box>()
            .ok_or("webview parent is not the expected GtkBox (tao/wry layout changed?)")?
            .clone();

        // The GtkWindow owning tao's vbox — its GtkBin child slot is what the
        // overlay takes over below.
        let window = vbox
            .parent()
            .and_then(|w| w.downcast_ref::<gtk::Window>().cloned())
            .ok_or("tao vbox's parent is not a GtkWindow (tao/wry layout changed?)")?;

        let overlay = gtk::Overlay::new();
        // Detach the webview from tao's vbox FIRST — gtk_container_add
        // refuses a widget that still has a parent (just a warning + no-op,
        // but the webview would end up parentless and the window blank; this
        // exact mis-order shipped once).
        #[allow(deprecated)]
        vbox.remove(&webview);
        // The webview becomes the overlay's BASE child — the fully opaque
        // page.
        #[allow(deprecated)]
        overlay.add(&webview);
        // The overlay must become the WINDOW's direct child — not be packed
        // into tao's vbox. Load-bearing: tauri's undecorated-resize handler
        // (tauri-runtime-wry undecorated_resizing.rs, attached to this
        // webview for the borderless window) walks `webview.parent().parent()`
        // and UNWRAPS a gtk::Window downcast of the grandparent, in a C
        // callback that cannot unwind — any other shape aborts the app on the
        // first click (an earlier version packed the overlay into the vbox,
        // making the grandparent the GtkBox; exactly that shipped and
        // crashed). With the overlay as the window's bin child the chain is
        // webview(base) → overlay → window and both tauri handlers keep
        // working. tao's vbox itself is only ever re-read by the (unused
        // here) webview-reparenting feature, so leaving it unparented — still
        // referenced by tao — is safe.
        #[allow(deprecated)]
        window.remove(&vbox);
        #[allow(deprecated)]
        window.add(&overlay);
        // The ONE positioning container for every engine's EventBox (see
        // the module header): added as the overlay's only overlay child,
        // full-size via its natural child extents, never positioned
        // anywhere but (0,0) — per-engine placement is the Fixed's job.
        // Added BEFORE realize so the overlay's realize pass creates its
        // per-child GdkWindow; shown (⇒ raised above the webview) once the
        // overlay is realized. Windowless (GTK3 Fixed default): the
        // EventBoxes' GdkWindows are parented straight into the Fixed's
        // overlay per-child window.
        let fixed = gtk::Fixed::new();
        fixed.set_can_focus(false);
        #[allow(deprecated)]
        overlay.add_overlay(&fixed);
        // show_all would un-hide the video box — show exactly the widgets
        // that should be visible. Realizing/mapping the overlay also creates
        // its per-child GdkWindow for every overlay child (hidden along with
        // the still-hidden Fixed).
        overlay.show();
        overlay.realize();
        fixed.show();
        let _ = OVERLAY_BOOTSTRAP.set(OverlayBootstrap {
            overlay: MainThread(overlay.clone()),
            fixed: MainThread(fixed.clone()),
        });
        (overlay, fixed)
    };

    // ---- per-engine surface: one EventBox + GLArea, placed in the Fixed ----
    // GL area: hidden until the first frame presents (see mod.rs — the
    // surface is revealed on PlaybackRestart so the page's loading/error
    // overlays aren't covered by a black box during load). It never needs
    // focus: every video-side GdkWindow is input-shaped, so pointer events
    // go to the webview below.
    let gl_area = gtk::GLArea::new();
    gl_area.set_visible(false);
    gl_area.set_can_focus(false);
    // The EventBox gives the video its own GdkWindow inside the Fixed's
    // overlay per-child window; the Fixed allocates it at the (x, y) the
    // last set_rect moved it to, sized to its size request.
    let video_box = gtk::EventBox::new();
    #[allow(deprecated)] // gtk3 Container::add — the gtk4-style API is not in gtk 0.18
    video_box.add(&gl_area);
    video_box.set_visible(false);
    video_box.set_can_focus(false);

    // Dedupe state for set_rect; (-1, -1, -1, -1) = no rect pushed yet.
    let last_rect = std::sync::Arc::new(std::sync::Mutex::new((-1, -1, -1, -1)));

    // Parked at (0,0) until the first set_rect moves it (a hidden Fixed
    // child is simply not allocated — gtk_fixed_size_allocate skips
    // invisible children — so the parked position is invisible too).
    fixed.put(&video_box, 0, 0);

    // Resolve glGetIntegerv once (through the GL provider) for the render
    // callbacks.
    let get_integerv: GlGetIntegervFn = unsafe { std::mem::transmute(gl.get("glGetIntegerv")) };
    let _ = GL_GET_INTEGERV.set(get_integerv);

    // mpv's render context initializes its GL renderer AT CREATION (it does
    // not just resolve symbols — it issues GL calls to probe the context), so
    // a GL context must be current on this thread right now. A GtkGLArea
    // only owns one once realized (its GdkGLContext is created on realize)
    // and the area stays hidden until the first frame, so realize it
    // explicitly and bind the context here. This is the SAME context GTK
    // makes current again inside every ::render pass — the only context the
    // render context may ever be used with.
    // Realize top-down: gtk_widget_realize needs every ancestor realized
    // before the GLArea can create its GdkWindow + GL context (the overlay
    // was realized during the bootstrap above).
    video_box.realize();
    gl_area.realize();
    // INPUT PASS-THROUGH, the whole point of the EventBox: a 1px-corner
    // input region on every GdkWindow the video owns or rides in makes
    // every pointer event over the video fall through to the webview
    // window below — the page keeps its click / wheel / dblclick handling
    // on the (invisible, hit-testable) <video>, exactly like the hls.js
    // path. Shaped AFTER realize (all windows exist) and re-applied by the
    // size-allocate hook (the overlay DESTROYS + recreates the per-child
    // window on unrealize/realize cycles, and a fresh window starts
    // unshaped). See apply_input_passthrough for why a 1px corner, not an
    // empty region.
    apply_input_passthrough(&video_box, &gl_area);
    if let Some(err) = gl_area.error() {
        return Err(format!("GtkGLArea context error: {}", err.message()));
    }
    gl_area.make_current();
    if gdk::GLContext::current().is_none() {
        return Err(format!(
            "no GL context current after GLArea realize/make_current (realized: {}, context: {})",
            gl_area.is_realized(),
            gl_area.context().is_some(),
        ));
    }

    // mpv render context: resolves every GL symbol it needs through the
    // same GLVND provider. Owned EXCLUSIVELY by this GLArea's render
    // closure below — one render context per engine, on that engine's own
    // GL context (never a shared slot: two engines would race their
    // contexts through it).
    let mut render = mpv
        .create_render_context(vec![
            RenderParam::ApiType(RenderParamApiType::OpenGl),
            RenderParam::InitParams(OpenGLInitParams {
                get_proc_address: mpv_get_proc_address,
                ctx: gl.clone(),
            }),
        ])
        .map_err(|e| format!("mpv render context failed: {e}"))?;

    {
        let area = MainThread(gl_area.clone());
        render.set_update_callback(move || {
            // Called from an mpv internal thread: only marshal, never touch
            // GTK here. The clone is the wrapper's refcount bump.
            let area = area.clone();
            glib::MainContext::default().invoke(move || {
                area.with(|area| area.queue_render());
            });
        });
    }

    gl_area.connect_render(move |area, _ctx| {
        let Some(get_integerv) = GL_GET_INTEGERV.get() else {
            return glib::Propagation::Proceed;
        };
        // Pixel size = allocation × scale factor (the FBO mpv must fill
        // is in physical pixels).
        let scale = area.scale_factor();
        let alloc = area.allocation();
        let w = (alloc.width() * scale).max(1);
        let h = (alloc.height() * scale).max(1);
        let mut fbo: c_int = 0;
        unsafe { get_integerv(GL_DRAW_FRAMEBUFFER_BINDING, &mut fbo) };
        // flip_y: GL renders Y-up, video is Y-down.
        let _ = render.render::<GlLib>(fbo, w, h, true);
        glib::Propagation::Stop
    });

    // PASS-THROUGH HOOK: re-applies the input shapes after every
    // allocation (the overlay DESTROYS + recreates the Fixed's per-child
    // window on unrealize/realize cycles, and a fresh window starts
    // unshaped). POSITIONING needs no hook anymore — the Fixed allocates
    // the EventBox at its stored (x, y), and nothing ever moves the
    // window except that allocation.
    {
        let video_box_hook = video_box.clone();
        let gl_area_hook = gl_area.clone();
        video_box.connect_size_allocate(move |_w, _alloc| {
            apply_input_passthrough(&video_box_hook, &gl_area_hook);
        });
    }

    Ok(LinuxSurface {
        app,
        fixed: MainThread(fixed),
        video_box: MainThread(video_box),
        gl_area: MainThread(gl_area),
        last_rect,
        shown: std::sync::atomic::AtomicBool::new(false),
    })
}

// ---------------------------------------------------------------------------
// Page-UI overlay snapshots + input pass-through helpers

/// Rasterize the page and stage the crop over the overlapping UI as the
/// "page" bitmap (mpv_page_snapshot) for ONE engine (`id` — each engine
/// composites its own page overlay). Runs its WebKitGTK work inside
/// `with_webview` (main thread); the async completion converts + stores the
/// crop and re-issues the overlay from the engine's last known geometry.
/// Snapshots are coalesced by a 70 ms window (see PAGE_SNAPSHOT_LAST) —
/// a self-expiring guard, deliberately NOT an in-flight flag: if WebKit
/// ever failed to call back, a flag would wedge the path forever.
/// Coalesced requests resolve Ok(false) — the value is the frontend's
/// retry signal (dropped requests must not strand a stale overlay: the
/// 2026-09-18 hardware round measured 34% of requests coalesced during
/// pointer movement).
pub(super) fn page_snapshot(
    app: &AppHandle,
    id: u32,
    x: i32,
    y: i32,
    w: i32,
    h: i32,
    keep: Vec<i32>,
) -> Result<bool, String> {
    use webkit2gtk::WebViewExt;

    if !super::engines()
        .lock()
        .expect("mpv engines lock poisoned")
        .contains_key(&id)
    {
        return Err("no engine".to_string());
    }
    {
        let mut last = PAGE_SNAPSHOT_LAST
            .get_or_init(|| std::sync::Mutex::new(std::collections::HashMap::new()))
            .lock()
            .expect("mpv snapshot guard lock poisoned");
        let fresh = match last.get(&id) {
            Some(t) => t.elapsed() >= Duration::from_millis(SNAPSHOT_COALESCE_MS),
            None => true,
        };
        if !fresh {
            // Coalesced, NOT lost: Ok(false) tells the frontend to retry
            // after the window expires — a dropped FINAL request of a move
            // would otherwise strand the overlay on stale geometry (the
            // backstop poll dedupes on an unchanged key and never resends;
            // the 2026-09-18 hardware round measured 34% of requests
            // coalesced during pointer movement, so this is load-bearing).
            return Ok(false);
        }
        last.insert(id, Instant::now());
    }
    let window = app
        .get_webview_window(crate::tray::MAIN_WINDOW)
        .ok_or_else(|| "main window not found".to_string())?;
    window
        .with_webview(move |wv| {
            let view = wv.inner();
            // The webview's GTK allocation (logical px) is the CSS-px space
            // the frontend's crop rect lives in; the snapshot itself comes
            // back at DEVICE scale — the ratio maps between them.
            let meta = SnapshotMeta {
                id,
                alloc: (
                    view.allocated_width().max(1),
                    view.allocated_height().max(1),
                ),
                rect: (x, y, w, h),
                keep,
            };
            view.snapshot(
                webkit2gtk::SnapshotRegion::Visible,
                webkit2gtk::SnapshotOptions::NONE,
                None::<&gio::Cancellable>,
                move |res| finish_page_snapshot(res, meta),
            );
        })
        .map(|_| true)
        .map_err(|e| format!("with_webview dispatch failed: {e}"))
}

/// Everything the snapshot completion needs: the target engine id, the
/// webview's LOGICAL px allocation (the CSS-px space the crop rect arrives
/// in), the crop rect itself, and the keep rects (flat x,y,w,h CSS px) to
/// mask the bitmap to.
struct SnapshotMeta {
    id: u32,
    alloc: (i32, i32),
    rect: (i32, i32, i32, i32),
    keep: Vec<i32>,
}

/// The crop handed from the GTK main thread to the store worker: the raw
/// PREMULTIPLIED ARGB32 pixels (plus stride) of a crop-sized owned surface,
/// the target engine id, the engine sequence number allocated at snapshot
/// time, and the keep rects (BITMAP px) to mask to.
struct PageCrop {
    raw: Vec<u8>,
    stride: usize,
    w: u32,
    h: u32,
    keep: Vec<(usize, usize, usize, usize)>,
    id: u32,
    seq: u64,
}

/// The snapshot completion (GTK main thread): blit ONLY the crop region off
/// WebKit's snapshot onto a privately-owned ARGB32 surface and hand the
/// pixels to a worker thread for everything expensive (un-premultiply,
/// resample, temp-file write, mpv upload). This thread is the same one
/// that scrolls the page, so its per-snapshot budget is one crop-sized
/// blit plus one memcpy — a full-page owned copy here is what makes
/// scrolling inside overlaid dialogs janky. Failures are silent: the
/// frontend keeps polling and the next snapshot replaces this one.
fn finish_page_snapshot(res: Result<cairo::Surface, glib::Error>, meta: SnapshotMeta) {
    let SnapshotMeta {
        id,
        alloc: (alloc_w, alloc_h),
        rect: (x, y, w, h),
        keep,
    } = meta;
    let surf = match res {
        Ok(surf) => surf,
        Err(_) => return,
    };
    if surf.status().is_err() {
        return;
    }
    // WebKit hands out an ARGB32 image surface, but cairo-rs refuses to
    // lend its pixel slice while the reference count is > 1 — and the
    // surface arrives shared with WebKit's own machinery. Copying onto a
    // surface we exclusively own sidesteps the borrow; placing the source
    // at a negative offset makes the blit crop-sized (cairo clips the
    // paint to the destination extent), so the copy is by construction
    // ARGB32, borrowable, and never page-sized.
    let img = match cairo::ImageSurface::try_from(surf) {
        Ok(img) => img,
        Err(_) => return,
    };
    let (sw, sh) = (img.width().max(1) as usize, img.height().max(1) as usize);
    let scale_x = sw as f64 / f64::from(alloc_w);
    let scale_y = sh as f64 / f64::from(alloc_h);
    let clamp = |v: f64, max: usize| -> usize { (v.floor() as i64).clamp(0, max as i64) as usize };
    let x1 = clamp(f64::from(x) * scale_x, sw);
    let y1 = clamp(f64::from(y) * scale_y, sh);
    let x2 = clamp(f64::from(x + w) * scale_x, sw);
    let y2 = clamp(f64::from(y + h) * scale_y, sh);
    let (cw, ch) = (x2.saturating_sub(x1), y2.saturating_sub(y1));
    if cw == 0 || ch == 0 {
        return;
    }
    let mut owned = match cairo::ImageSurface::create(
        cairo::Format::ARgb32,
        i32::try_from(cw).unwrap_or(i32::MAX),
        i32::try_from(ch).unwrap_or(i32::MAX),
    ) {
        Ok(c) => c,
        Err(_) => return,
    };
    {
        let Ok(ctx) = cairo::Context::new(&owned) else {
            return;
        };
        if ctx
            .set_source_surface(&img, -(x1 as f64), -(y1 as f64))
            .is_err()
        {
            return;
        }
        if ctx.paint().is_err() {
            return;
        }
    }
    let stride = owned.stride().max(1) as usize;
    let raw = {
        let Ok(data) = owned.data() else {
            return;
        };
        data.to_vec()
    };
    drop(owned);
    // Map the keep rects (CSS px) into bitmap px (relative to the crop
    // origin, clamped into the bitmap) — anything outside every keep gets
    // masked transparent by the worker.
    let keep_px = keep
        .chunks_exact(4)
        .filter_map(|r| {
            let a1 = clamp(f64::from(r[0]) * scale_x, sw);
            let a2 = clamp(f64::from(r[0].saturating_add(r[2])) * scale_x, sw);
            let b1 = clamp(f64::from(r[1]) * scale_y, sh);
            let b2 = clamp(f64::from(r[1].saturating_add(r[3])) * scale_y, sh);
            let kx = a1.saturating_sub(x1).min(cw);
            let ky = b1.saturating_sub(y1).min(ch);
            let kw = a2.saturating_sub(x1).min(cw).saturating_sub(kx);
            let kh = b2.saturating_sub(y1).min(ch).saturating_sub(ky);
            if kw == 0 || kh == 0 {
                None
            } else {
                Some((kx, ky, kw, kh))
            }
        })
        .collect::<Vec<_>>();
    // Allocate the sequence number under the engine lock so request order
    // is what the worker compares against, and spawn the heavy half. If the
    // engine died in between, the worker simply finds nothing.
    let seq = super::engines()
        .lock()
        .expect("mpv engines lock poisoned")
        .get_mut(&id)
        .map(|e| {
            e.page_seq += 1;
            e.page_seq
        })
        .unwrap_or(0);
    std::thread::spawn(move || {
        store_page_snapshot(PageCrop {
            raw,
            stride,
            w: cw as u32,
            h: ch as u32,
            keep: keep_px,
            id,
            seq,
        })
    });
}

/// Worker half of the snapshot pipeline (own thread): un-premultiply, store
/// as the TARGET engine's "page" bitmap, and re-issue overlay-add for the
/// last geometry the OSD issued. Sequenced by the engine's `page_seq` — all
/// stores happen under the engines lock, so a slow older frame can never
/// overwrite a newer one. Identical pixels (an idle dialog's periodic
/// refresh) keep the cached bitmap and generation, which leaves the OSD's
/// geometry re-issue a dedupe no-op: no resample, no temp-file write, no
/// mpv upload.
fn store_page_snapshot(crop: PageCrop) {
    let PageCrop {
        raw,
        stride,
        w,
        h,
        keep,
        id,
        seq,
    } = crop;
    let mut bgra = super::argb32_crop_to_bgra(
        &raw,
        stride,
        w as usize,
        h as usize,
        (0, 0, w as usize, h as usize),
    );
    super::mask_keep_rects(&mut bgra, w as usize, h as usize, &keep);
    let mut engines = super::engines().lock().expect("mpv engines lock poisoned");
    let Some(engine) = engines.get_mut(&id) else {
        return;
    };
    if seq < engine.page_seq {
        return; // a newer frame already stored
    }
    if let Some(prev) = engine.bitmaps.get("page") {
        if prev.w == w && prev.h == h && prev.bgra == bgra {
            return;
        }
    }
    engine.bitmap_gen += 1;
    engine.bitmaps.insert(
        "page".to_string(),
        super::CachedBitmap {
            bgra,
            w,
            h,
            grid: None,
        },
    );
    if let Some((pos, dims)) = engine.page_geo {
        let _ = engine.show_bitmap(super::OVERLAY_PAGE, "page", 0, pos, dims);
    }
}

/// A 1×1 corner input region. NOT an empty region on purpose: empty is
/// ambiguous on some GDK/Wayland paths ("no shape set" ⇒ default FULL
/// input — which would swallow every click over the video), a 1px corner
/// has unambiguous pass-through semantics everywhere.
fn corner_input_region() -> cairo::Region {
    let region = cairo::Region::create();
    let corner = cairo::RectangleInt::new(0, 0, 1, 1);
    let _ = region.union_rectangle(&corner);
    region
}

/// Shape one GdkWindow for click-through. The `parent()` guard keeps the
/// TOPLEVEL GdkWindow (no parent) untouchable — shaping that would swallow
/// every event in the whole window. `None` (widget not realized yet, or a
/// windowless widget without a parent window) is skipped; the
/// size-allocate hook re-applies as windows appear.
fn shape_pass_through(win: Option<gdk::Window>) {
    if let Some(win) = win {
        if win.parent().is_some() {
            let region = corner_input_region();
            win.input_shape_combine_region(&region, 0, 0);
        }
    }
}

/// Pass-through for every GdkWindow on the video side: the overlay's
/// per-child GdkWindow wrapping the GtkFixed (it is the EventBox's parent
/// window — full-size, and an unshaped one would eat every click in the
/// whole window), the EventBox's own window, and the GLArea's window if it
/// has one (a windowless GLArea reports its parent's window, already
/// shaped).
fn apply_input_passthrough(video_box: &gtk::EventBox, gl_area: &gtk::GLArea) {
    shape_pass_through(video_box.parent_window());
    shape_pass_through(video_box.window());
    shape_pass_through(gl_area.window());
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The GL provider must load and resolve raw gl* entry points — pure
    /// dlopen/dlsym, no GL calls, no display needed. (The first shipped build
    /// died at exactly this step, on a libepoxy symbol that Debian's build
    /// never exports; this test pins the loader that replaced it.)
    #[test]
    fn gl_lib_resolves_core_entry_points() {
        let gl = GlLib::load().expect("a GL provider (libGL/libOpenGL) must load");
        assert!(!gl.get("glGetString").is_null());
        assert!(!gl.get("glGetIntegerv").is_null());
        // A bogus name must resolve to null, not panic — mpv probes names.
        assert!(gl.get("glNotARealEntryPoint1").is_null());
    }
}
