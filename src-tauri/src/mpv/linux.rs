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
// video sits BELOW the page:
//   1. create a GtkOverlay; its BASE child is an opaque black DrawingArea
//      (the "floor") that guarantees the window stays compositor-opaque
//      everywhere — no desktop-through transparency exists at any layer,
//   2. add ONE full-size GtkFixed as the overlay's first overlay child —
//      the video layer — and place every engine's GtkEventBox (own
//      GdkWindow, wrapping the GtkGLArea mpv renders into) inside that
//      Fixed via put()/move_(). GtkFixed is THE positioning container
//      here, chosen against the overlay's own child placement after
//      reading gtkoverlay.c: gtk_overlay_child_allocate() calls
//      gdk_window_move_resize() on each visible child's per-child
//      GdkWindow on EVERY allocation pass, re-defaulting it to the
//      computed halign/valign spot — a correction hook only survives that
//      if the child's size-allocate re-emits, which gtk skips for
//      unchanged allocations. With several equal-sized video quadrants
//      that stranded bottom-row surfaces at the default (0,0) spot (the
//      "tiles render in the top row" round). GtkFixed instead positions
//      children THROUGH their allocation (gtk_fixed_size_allocate →
//      gtk_widget_size_allocate at (child.x, child.y)) — the allocation IS
//      the position, nothing ever re-defaults the window, and an unchanged
//      allocation short-circuit leaves the window exactly where it already
//      is.
//   3. add tao's VBOX (the webview's own parent — the webview widget itself
//      is NEVER unparented) as the overlay's SECOND overlay child on top of
//      the video Fixed, expanding to fill the overlay. The webview's
//      background color is set to RGBA(0,0,0,0) at runtime (its backing
//      layer is the only transparent thing in the stack). Detaching the
//      webview from the vbox instead — reparenting the webview widget
//      itself — drags WebKitGTK through its own hierarchy-changed path and
//      the rebuilt accelerated surface comes up OPAQUE (measured 2026-10-17:
//      audio + pointer forwarding fine, the page's aperture painted the
//      black floor over the video); moving the passive vbox keeps the
//      webview's own widget state untouched.
//   4. REPLACE THE WINDOW'S CHILD: window.remove(vbox) BEFORE the
//      overlay.add_overlay(vbox) above (a container refuses a widget that
//      still has a parent), then window.add(overlay), and give the GTK
//      window itself an opaque black CSS background so a resize's newly
//      exposed area can never flash the desktop (belt and suspenders under
//      the floor).
// tauri's undecorated-resize handler walks `webview.parent().parent()` and
// downcasts the grandparent to a gtk::Window — but it does so EXACTLY ONCE,
// at webview creation time (tauri-runtime-wry attaches the handler while the
// tree is still webview → vbox → window), so this later reparent cannot
// affect it; nothing re-resolves the grandparent afterwards.
//
// WHY BELOW works now (and the old above-page design existed at all): the
// pre-2026-10 attempts at web-UI-over-video tried DESKTOP-through
// transparency (transparent OS window + transparent page) — that is the
// path WebKitGTK cannot do on this stack (never-clearing smears,
// accumulating tint). The intra-window layout above never shows the
// desktop: the floor is opaque, the webview composites its page over its
// own alpha-0 backing, and wherever the PAGE does not paint (the
// "aperture" the frontend carves around the video rect), the video
// sibling underneath shows through. The frontend owns the aperture: it
// keeps the page's painted chrome opaque right up to the video edge
// (backdrop panels cut around the rect, see src/lib/native-aperture) so
// the app is pixel-identical to the hls.js engine outside the video. The
// same mechanism Stremio ships (GTK4/WebKitGTK 6) and the tauri-plugin-video
// project validated on this exact stack (2026-10).
//
// Because the webview is the TOPMOST child, ALL pointer input reaches the
// page natively — no input shapes, no pass-through, and the existing HTML
// click/wheel/dblclick handlers work exactly as on the hls.js path. Page
// UI (dialogs, dropdowns, tooltips, toasts) renders above the video by
// DOM order alone; the legacy page-snapshot compositing path is dormant.
//
// mpv renders through the render API into the GLArea's framebuffer on the
// GLArea's `render` signal: GTK binds the area's own FBO before emitting it,
// so the draw-FBO binding is read via glGetIntegerv and handed to mpv
// together with the pixel size (allocation × scale factor) and flip_y=true
// (GL renders Y-up, video is Y-down). mpv's update callback marshals to the
// main thread and calls queue_render(); GTK/GL is never touched from mpv's
// threads.
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
            // SAFETY: lookups only, against the leaked library.
            let has =
                |sym: &[u8]| -> bool { unsafe { lib.get::<unsafe extern "C" fn()>(sym) }.is_ok() };
            // Both entry points the engine itself resolves must be present:
            // glGetString is mpv's loader probe, glGetIntegerv feeds the
            // render callbacks. A library missing either is not usable.
            if has(b"glGetString") && has(b"glGetIntegerv") {
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

// The GL entry points the scroll-fold presentation path needs (offscreen
// FBO + blit; see the render closure). Resolved once at surface init like
// GL_GET_INTEGERV, same thread rules.
type GlGenFn = unsafe extern "C" fn(c_int, *mut u32);
type GlDeleteFn = unsafe extern "C" fn(c_int, *const u32);
type GlBindTextureFn = unsafe extern "C" fn(u32, u32);
type GlTexImage2DFn =
    unsafe extern "C" fn(u32, c_int, c_int, c_int, c_int, c_int, u32, u32, *const c_void);
type GlBindFramebufferFn = unsafe extern "C" fn(u32, u32);
type GlFramebufferTexture2DFn = unsafe extern "C" fn(u32, u32, u32, u32, c_int);
type GlCheckFramebufferStatusFn = unsafe extern "C" fn(u32) -> u32;
type GlBlitFramebufferFn =
    unsafe extern "C" fn(c_int, c_int, c_int, c_int, c_int, c_int, c_int, c_int, u32, u32);
type GlDisableFn = unsafe extern "C" fn(u32);

struct GlFold {
    gen_textures: GlGenFn,
    delete_textures: GlDeleteFn,
    bind_texture: GlBindTextureFn,
    tex_image_2d: GlTexImage2DFn,
    gen_framebuffers: GlGenFn,
    delete_framebuffers: GlDeleteFn,
    bind_framebuffer: GlBindFramebufferFn,
    framebuffer_texture_2d: GlFramebufferTexture2DFn,
    check_framebuffer_status: GlCheckFramebufferStatusFn,
    blit_framebuffer: GlBlitFramebufferFn,
    disable: GlDisableFn,
}

static GL_FOLD: std::sync::OnceLock<GlFold> = std::sync::OnceLock::new();

const GL_TEXTURE_2D: u32 = 0x0DE1;
const GL_RGBA8: u32 = 0x8058;
const GL_RGBA: u32 = 0x1908;
const GL_UNSIGNED_BYTE: u32 = 0x1401;
const GL_FRAMEBUFFER: u32 = 0x8D40;
const GL_READ_FRAMEBUFFER: u32 = 0x8CA8;
const GL_DRAW_FRAMEBUFFER: u32 = 0x8CA9;
const GL_COLOR_ATTACHMENT0: u32 = 0x8CE0;
const GL_FRAMEBUFFER_COMPLETE: u32 = 0x8CD5;
const GL_COLOR_BUFFER_BIT: u32 = 0x4000;
const GL_NEAREST: u32 = 0x2600;
const GL_SCISSOR_TEST: u32 = 0x0C11;

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
/// thread. RE-VALIDATED AT 4K (view 3840x1972):
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
    /// Last rect pushed by the frontend (see `RectWithFold` = no rect yet).
    /// The frontend pushes the rect on every coalesced scroll/resize/zoom
    /// tick; applying an identical rect would queue a pointless relayout
    /// each time, so identical pushes are dropped in set_rect. The FOLD is
    /// part of the dedup key: the same visible rect can arrive with a
    /// different fold (scrolling back up past the fold start), and deduping
    /// on the rect alone would strand the stale fold.
    last_rect: std::sync::Arc<std::sync::Mutex<RectWithFold>>,
    /// Rows of the composition hidden above the fold line, logical px.
    /// Written by set_rect's main-thread dispatch, read by the render
    /// closure (same thread) to size the offscreen + blit band.
    fold: std::sync::Arc<std::sync::atomic::AtomicI32>,
    /// Whether the video surface is currently shown. Guards the show path:
    /// the event thread reveals the surface on EVERY PlaybackRestart (seek,
    /// unpause, …), and each show dispatches to the GTK main thread — the
    /// flag collapses the repeats to one dispatch per reveal. Written only
    /// by the dispatch closures at EXECUTION time, so it always mirrors the
    /// box's actual state even when dispatches land out of order.
    shown: std::sync::Arc<std::sync::atomic::AtomicBool>,
    /// The WANTED visibility, written at DECISION time (both decision sites
    /// hold the engines lock) and re-read inside the dispatch closures. A
    /// show/hide pair dispatched out of decision order then self-corrects:
    /// the staler closure sees the newer decision's flag and skips, so the
    /// video can never end up shown over an open modal (or hidden after its
    /// dismissal) because two dispatches raced.
    want_visible: std::sync::Arc<std::sync::atomic::AtomicBool>,
}

/// (x, y, w, h, fold_top) — the surface rect plus the rows folded above it.
type RectWithFold = (i32, i32, i32, i32, i32);

/// mpv's private render target: the FULL (unfolded) composition. Reallocated
/// only when the full size genuinely changes — NEVER while the scroll-fold
/// slides (the window shrinks and the fold grows by the same amount, so the
/// sum stays constant), which means mpv's render target — and with it its
/// picture fit — is untouched by scrolling. The visible band is clipped at
/// presentation time by the blit in the render closure, on the same frame
/// the window resized: no mpv property, no reconfig, and structurally no
/// mis-fitted transitional frame. (The video-crop approach this replaces
/// could not guarantee that: crop updates are consumed several renders
/// AFTER the surface resize lands — measured against libmpv 0.40 with the
/// software render API, where a freshly set crop took 5+ renders to appear,
/// sometimes not settling within 8 — leaving every scroll tick briefly
/// showing the old picture fitted into the new window size: the
/// shrink-then-snap-back shimmer.) Owned by the GLArea's render closure
/// (main thread only).
struct OffscreenTarget {
    fbo: u32,
    tex: u32,
    w: i32,
    h: i32,
}

impl OffscreenTarget {
    fn new() -> Self {
        OffscreenTarget {
            fbo: 0,
            tex: 0,
            w: 0,
            h: 0,
        }
    }

    /// (Re)create the texture+FBO at (w, h). No-op when the size already
    /// matches. Leaves GL bindings dirty on purpose — the caller rebinds
    /// for the mpv render / blit right after. Failure keeps fbo == 0 and
    /// the render closure falls back to rendering straight into the window.
    fn ensure(&mut self, gl: &GlFold, w: i32, h: i32) {
        if self.fbo != 0 && self.w == w && self.h == h {
            return;
        }
        unsafe {
            if self.fbo != 0 {
                (gl.delete_framebuffers)(1, &self.fbo);
                self.fbo = 0;
            }
            if self.tex != 0 {
                (gl.delete_textures)(1, &self.tex);
                self.tex = 0;
            }
            let mut tex: u32 = 0;
            (gl.gen_textures)(1, &mut tex);
            if tex == 0 {
                return;
            }
            (gl.bind_texture)(GL_TEXTURE_2D, tex);
            (gl.tex_image_2d)(
                GL_TEXTURE_2D,
                0,
                GL_RGBA8 as c_int,
                w,
                h,
                0,
                GL_RGBA,
                GL_UNSIGNED_BYTE,
                std::ptr::null(),
            );
            let mut fbo: u32 = 0;
            (gl.gen_framebuffers)(1, &mut fbo);
            if fbo == 0 {
                (gl.delete_textures)(1, &tex);
                return;
            }
            (gl.bind_framebuffer)(GL_FRAMEBUFFER, fbo);
            (gl.framebuffer_texture_2d)(
                GL_FRAMEBUFFER,
                GL_COLOR_ATTACHMENT0,
                GL_TEXTURE_2D,
                tex,
                0,
            );
            // An INCOMPLETE framebuffer must fail the whole ensure, not sail
            // through: rendering into one presents garbage/nothing, while
            // fbo == 0 makes the render closure take its straight-to-window
            // fallback (still a correct picture, just without the fold). The
            // size is deliberately NOT cached on failure so a later frame
            // re-attempts the allocation (transient OOM can clear).
            let status = (gl.check_framebuffer_status)(GL_FRAMEBUFFER);
            if status != GL_FRAMEBUFFER_COMPLETE {
                (gl.bind_framebuffer)(GL_FRAMEBUFFER, 0);
                (gl.delete_framebuffers)(1, &fbo);
                (gl.delete_textures)(1, &tex);
                return;
            }
            (gl.bind_framebuffer)(GL_FRAMEBUFFER, 0);
            self.fbo = fbo;
            self.tex = tex;
            self.w = w;
            self.h = h;
        }
    }
}

impl VideoSurface for LinuxSurface {
    fn show(&self) {
        self.want_visible
            .store(true, std::sync::atomic::Ordering::Release);
        if self.shown.load(std::sync::atomic::Ordering::Acquire) {
            return;
        }
        let video_box = MainThread(self.video_box.0.clone());
        let area = MainThread(self.gl_area.0.clone());
        let rect = self.last_rect.clone();
        let want = self.want_visible.clone();
        let shown = self.shown.clone();
        let _ = self.app.run_on_main_thread(move || {
            // Superseded before this dispatch ran: a later hide decision
            // flipped the flag — applying this show would put the video
            // over an open modal.
            if !want.load(std::sync::atomic::Ordering::Acquire) {
                return;
            }
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
                    let (x, y, w, h, _fold) = *super::lock_or_recover(&rect);
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
            shown.store(true, std::sync::atomic::Ordering::Release);
        });
    }

    fn hide(&self) {
        self.want_visible
            .store(false, std::sync::atomic::Ordering::Release);
        let video_box = MainThread(self.video_box.0.clone());
        let want = self.want_visible.clone();
        let shown = self.shown.clone();
        let _ = self.app.run_on_main_thread(move || {
            // Superseded before this dispatch ran: a later show decision
            // flipped the flag — hiding would leave the video black after
            // its modal closed.
            if want.load(std::sync::atomic::Ordering::Acquire) {
                return;
            }
            video_box.with(|video_box| video_box.hide());
            shown.store(false, std::sync::atomic::Ordering::Release);
        });
    }

    fn set_rect(&self, x: i32, y: i32, w: i32, h: i32, fold_top: i32) {
        {
            let mut last = super::lock_or_recover(&self.last_rect);
            if *last == (x, y, w, h, fold_top) {
                return;
            }
            *last = (x, y, w, h, fold_top);
        }
        let fixed = MainThread(self.fixed.0.clone());
        let video_box = MainThread(self.video_box.0.clone());
        let area = MainThread(self.gl_area.0.clone());
        let fold = self.fold.clone();
        let _ = self.app.run_on_main_thread(move || {
            fold.store(fold_top.max(0), std::sync::atomic::Ordering::Release);
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
    // The webview's backing layer must composite with alpha for the video
    // beneath to show through the page's aperture. WebKitGTK derives its
    // accelerated surface's format from the background it sees, so this is
    // the Tauri-level call (webview base color AND the window's own
    // background) dispatched BEFORE the reparent below — the message queue
    // processes it ahead of the with_webview dispatch.
    window
        .set_background_color(Some(tauri::webview::Color(0, 0, 0, 0)))
        .map_err(|e| format!("webview background color failed: {e}"))?;
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
    use webkit2gtk::WebViewExt;
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
        overlay.set_hexpand(true);
        overlay.set_vexpand(true);
        // The opaque floor: the overlay's BASE child, painting solid black
        // and stopping propagation so GTK's default DrawingArea draw cannot
        // clear the paint back to transparent on some Wayland compositors.
        // This is what keeps the window compositor-opaque everywhere —
        // transparency only ever exists BETWEEN the floor and the page.
        let floor = gtk::DrawingArea::new();
        floor.set_hexpand(true);
        floor.set_vexpand(true);
        floor.connect_draw(|_, context| {
            context.set_source_rgb(0.0, 0.0, 0.0);
            let _ = context.paint();
            gtk::glib::Propagation::Stop
        });

        // The ONE positioning container for every engine's EventBox (see
        // the module header): the overlay's first overlay child = the video
        // layer, BELOW the webview added next. Expands to the overlay's full
        // size — the per-child GdkWindow GtkOverlay gives it is sized by its
        // allocation, and a small Fixed would clip every engine's video
        // window to that extent. Never positioned anywhere but (0,0);
        // per-engine placement is the Fixed's job. Added BEFORE realize so
        // the overlay's realize pass creates its per-child GdkWindow.
        let fixed = gtk::Fixed::new();
        fixed.set_hexpand(true);
        fixed.set_vexpand(true);
        fixed.set_can_focus(false);

        // The whole "HTML above mpv" mechanism in one call: the webview's
        // own backing layer becomes transparent, so wherever the page does
        // not paint (the frontend's aperture) the video Fixed beneath shows
        // through. The OS window never becomes transparent — the floor and
        // the page's painted chrome keep it opaque.
        webview.set_background_color(&gdk::RGBA::new(0.0, 0.0, 0.0, 0.0));
        // Detach tao's vbox from the window FIRST — gtk_container_add
        // refuses a widget that still has a parent (just a warning + no-op;
        // this exact mis-order shipped once). The VBOX moves under the
        // overlay as one unit: the webview widget itself is never unparented
        // (see the module header — reparenting the webview directly leaves
        // the rebuilt accelerated surface opaque). As an overlay child it
        // must EXPAND to fill the overlay (the window-child slot did that
        // implicitly).
        #[allow(deprecated)]
        window.remove(&vbox);
        vbox.set_hexpand(true);
        vbox.set_vexpand(true);
        #[allow(deprecated)]
        overlay.add(&floor);
        #[allow(deprecated)]
        overlay.add_overlay(&fixed);
        #[allow(deprecated)]
        overlay.add_overlay(&vbox);

        // The overlay must become the WINDOW's direct child — not stay
        // detached. tauri's undecorated-resize handler resolved the
        // webview's grandparent window ONCE at webview creation (before any
        // of this), so the re-shape cannot break it.
        #[allow(deprecated)]
        window.add(&overlay);
        // The window's own GTK background: opaque black, so a resize's
        // newly exposed area (before the floor reallocates) can never show
        // the desktop or the theme default through the transparent webview.
        let background = gtk::CssProvider::new();
        background
            .load_from_data(b".ks-native-video-window { background-color: #000; }")
            .map_err(|e| format!("window background css failed: {e}"))?;
        window.style_context().add_class("ks-native-video-window");
        window
            .style_context()
            .add_provider(&background, gtk::STYLE_PROVIDER_PRIORITY_APPLICATION);
        // show_all is safe here: the only widgets in the tree are the floor,
        // the (still empty) Fixed and the webview — per-engine EventBoxes
        // are added later and stay hidden until their first frame.
        window.show_all();
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
    // focus, and input needs no plumbing at all: the webview is the TOPMOST
    // overlay child, so every pointer event reaches the page natively.
    let gl_area = gtk::GLArea::new();
    gl_area.set_visible(false);
    gl_area.set_can_focus(false);
    // The EventBox gives the video its own GdkWindow inside the Fixed's
    // overlay per-child window; the Fixed allocates it at the (x, y) the
    // last set_rect moved it to, sized to its size request. (Historically
    // the EventBox existed to carry the input pass-through shapes; it stays
    // because the per-engine GdkWindow structure keeps allocation stable.)
    let video_box = gtk::EventBox::new();
    #[allow(deprecated)] // gtk3 Container::add — the gtk4-style API is not in gtk 0.18
    video_box.add(&gl_area);
    video_box.set_visible(false);
    video_box.set_can_focus(false);

    // Dedupe state for set_rect; (-1, -1, -1, -1, -1) = no rect pushed yet.
    let last_rect = std::sync::Arc::new(std::sync::Mutex::new((-1, -1, -1, -1, -1)));
    let fold = std::sync::Arc::new(std::sync::atomic::AtomicI32::new(0));

    // Parked at (0,0) until the first set_rect moves it (a hidden Fixed
    // child is simply not allocated — gtk_fixed_size_allocate skips
    // invisible children — so the parked position is invisible too).
    fixed.put(&video_box, 0, 0);

    // Resolve glGetIntegerv once (through the GL provider) for the render
    // callbacks. A null symbol must never be transmuted to a fn pointer —
    // merely creating (let alone calling) one is UB — so a missing symbol
    // fails surface init: the engine reports unavailable and the frontend
    // falls back to hls.js.
    let get_integerv_ptr = gl.get("glGetIntegerv");
    if get_integerv_ptr.is_null() {
        return Err("GL provider exports no glGetIntegerv".to_string());
    }
    // SAFETY: non-null dlsym result for the documented signature.
    let get_integerv: GlGetIntegervFn = unsafe { std::mem::transmute(get_integerv_ptr) };
    let _ = GL_GET_INTEGERV.set(get_integerv);

    // Same resolution discipline for the fold path's entry points: a null
    // symbol must never become a fn pointer (see above). All of these are
    // core GL 3.0 / GLES 3.0 entry points, present on every context that
    // could run the renderer at all.
    let resolve = |name: &str| -> Result<*mut c_void, String> {
        let p = gl.get(name);
        if p.is_null() {
            Err(format!("GL provider exports no {name}"))
        } else {
            Ok(p)
        }
    };
    // SAFETY: each non-null dlsym result is transmuted to its documented
    // signature.
    let gl_fold = unsafe {
        GlFold {
            gen_textures: std::mem::transmute::<*mut c_void, GlGenFn>(resolve("glGenTextures")?),
            delete_textures: std::mem::transmute::<*mut c_void, GlDeleteFn>(resolve(
                "glDeleteTextures",
            )?),
            bind_texture: std::mem::transmute::<*mut c_void, GlBindTextureFn>(resolve(
                "glBindTexture",
            )?),
            tex_image_2d: std::mem::transmute::<*mut c_void, GlTexImage2DFn>(resolve(
                "glTexImage2D",
            )?),
            gen_framebuffers: std::mem::transmute::<*mut c_void, GlGenFn>(resolve(
                "glGenFramebuffers",
            )?),
            delete_framebuffers: std::mem::transmute::<*mut c_void, GlDeleteFn>(resolve(
                "glDeleteFramebuffers",
            )?),
            bind_framebuffer: std::mem::transmute::<*mut c_void, GlBindFramebufferFn>(resolve(
                "glBindFramebuffer",
            )?),
            framebuffer_texture_2d: std::mem::transmute::<*mut c_void, GlFramebufferTexture2DFn>(
                resolve("glFramebufferTexture2D")?,
            ),
            check_framebuffer_status: std::mem::transmute::<*mut c_void, GlCheckFramebufferStatusFn>(
                resolve("glCheckFramebufferStatus")?,
            ),
            blit_framebuffer: std::mem::transmute::<*mut c_void, GlBlitFramebufferFn>(resolve(
                "glBlitFramebuffer",
            )?),
            disable: std::mem::transmute::<*mut c_void, GlDisableFn>(resolve("glDisable")?),
        }
    };
    let _ = GL_FOLD.set(gl_fold);

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
    // was realized during the bootstrap above — show_all realized it).
    video_box.realize();
    gl_area.realize();
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

    // The offscreen mpv renders into + the fold it is clipped by. Both are
    // read/written only on the GTK main thread (the render closure below
    // and set_rect's dispatch), so RefCell/Atomics are sufficient.
    let offscreen = std::rc::Rc::new(std::cell::RefCell::new(OffscreenTarget::new()));
    let render_fold = fold.clone();

    gl_area.connect_render(move |area, _ctx| {
        let Some(get_integerv) = GL_GET_INTEGERV.get() else {
            return glib::Propagation::Proceed;
        };
        let Some(gl_fold) = GL_FOLD.get() else {
            return glib::Propagation::Proceed;
        };
        // Pixel size = allocation × scale factor (the FBO mpv must fill
        // is in physical pixels).
        let scale = area.scale_factor();
        let alloc = area.allocation();
        let w = (alloc.width() * scale).max(1);
        let h = (alloc.height() * scale).max(1);
        // The scroll-fold: rows hidden above the fold line, logical →
        // physical. mpv always renders the FULL unclipped composition into
        // the offscreen (its size is constant while the fold slides — see
        // OffscreenTarget), and the blit below presents only the visible
        // band, so the clip and the window resize land on the SAME frame.
        let fold_px = render_fold
            .load(std::sync::atomic::Ordering::Acquire)
            .max(0)
            .saturating_mul(scale);
        let full_h = h.saturating_add(fold_px);
        let mut window_fbo: c_int = 0;
        unsafe { get_integerv(GL_DRAW_FRAMEBUFFER_BINDING, &mut window_fbo) };
        if fold_px == 0 {
            // No fold: the offscreen path would be a 1:1 through-copy of the
            // window (full_h == h, identity blit). Render straight into the
            // window FBO — same picture, one full-frame copy saved per frame.
            let _ = render.render::<GlLib>(window_fbo, w, h, true);
            return glib::Propagation::Stop;
        }
        let mut off = offscreen.borrow_mut();
        off.ensure(gl_fold, w, full_h);
        if off.fbo == 0 {
            // No offscreen (allocation failed — not expected past init):
            // render straight into the window FBO, folded rows and all,
            // rather than showing nothing.
            let _ = render.render::<GlLib>(window_fbo, w, h, true);
            return glib::Propagation::Stop;
        }
        // flip_y: GL renders Y-up, video is Y-down. With the flip, the
        // offscreen's GL y ∈ [0, h) holds exactly the BOTTOM h rows of the
        // picture — the part NOT folded under the bar.
        let _ = render.render::<GlLib>(off.fbo as c_int, w, full_h, true);
        // Present the visible band into the GLArea's own framebuffer: 1:1
        // blit, no scaling. Scissor off in case mpv left one armed (the
        // blit would otherwise be clipped to mpv's last scissor rect); the
        // read binding is restored afterwards, the draw binding is left on
        // the window FBO it had on entry.
        unsafe {
            (gl_fold.disable)(GL_SCISSOR_TEST);
            (gl_fold.bind_framebuffer)(GL_READ_FRAMEBUFFER, off.fbo);
            (gl_fold.bind_framebuffer)(GL_DRAW_FRAMEBUFFER, window_fbo as u32);
            (gl_fold.blit_framebuffer)(0, 0, w, h, 0, 0, w, h, GL_COLOR_BUFFER_BIT, GL_NEAREST);
            (gl_fold.bind_framebuffer)(GL_READ_FRAMEBUFFER, 0);
        }
        glib::Propagation::Stop
    });

    Ok(LinuxSurface {
        app,
        fixed: MainThread(fixed),
        video_box: MainThread(video_box),
        gl_area: MainThread(gl_area),
        last_rect,
        fold,
        shown: std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false)),
        want_visible: std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false)),
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

    if !super::lock_or_recover(super::engines()).contains_key(&id) {
        return Err("no engine".to_string());
    }
    {
        let mut last = super::lock_or_recover(
            PAGE_SNAPSHOT_LAST
                .get_or_init(|| std::sync::Mutex::new(std::collections::HashMap::new())),
        );
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
/// in), the crop rect itself, and the keep rects (flat
/// x,y,w,h,radius,corners CSS px — corners is a bitset of the element's
/// own, unclipped rounded corners) to mask the bitmap to.
struct SnapshotMeta {
    id: u32,
    alloc: (i32, i32),
    rect: (i32, i32, i32, i32),
    keep: Vec<i32>,
}

/// The crop handed from the GTK main thread to the store worker: the raw
/// PREMULTIPLIED ARGB32 pixels (plus stride) of a crop-sized owned surface,
/// the target engine id, the engine sequence number allocated at snapshot
/// time, and the keep rects (BITMAP px, with scaled radius + corner flags)
/// to mask to.
struct PageCrop {
    raw: Vec<u8>,
    stride: usize,
    w: u32,
    h: u32,
    keep: Vec<super::KeepPx>,
    id: u32,
    seq: u64,
}

/// The snapshot completion (GTK main thread): blit ONLY the crop region off
/// WebKit's snapshot onto a privately-owned ARGB32 surface and hand the
/// pixels to a worker thread for everything expensive (un-premultiply,
/// resample, mpv upload — all in memory, nothing touches disk). This thread
/// is the same one
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
    // Saturating, matching the keep-rect arithmetic above: an edge-riding
    // crop against an i32 overflow must clamp, not wrap negative.
    let x2 = clamp(f64::from(x.saturating_add(w)) * scale_x, sw);
    let y2 = clamp(f64::from(y.saturating_add(h)) * scale_y, sh);
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
    // masked transparent by the worker. Radius scales with the device
    // factor and is capped at half the clamped extent; corners is the
    // element's own-corner bitset, passed through verbatim.
    let keep_px = keep
        .as_chunks::<6>()
        .0
        .iter()
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
                let kr = clamp(f64::from(r[4].max(0)) * scale_x, cw.max(ch))
                    .min(kw / 2)
                    .min(kh / 2);
                Some(super::KeepPx {
                    x: kx,
                    y: ky,
                    w: kw,
                    h: kh,
                    r: kr,
                    corners: r[5].clamp(0, 15) as u8,
                })
            }
        })
        .collect::<Vec<_>>();
    // Allocate the sequence number under the engine lock so request order
    // is what the worker compares against, and spawn the heavy half. If the
    // engine died in between, the worker simply finds nothing.
    let seq = super::lock_or_recover(super::engines())
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
/// geometry re-issue a dedupe no-op: no resample, no mpv upload. The
/// resample + overlay-add themselves run OUTSIDE the lock (see OverlayCmd
/// in mod.rs).
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
    let bgra = std::sync::Arc::new(bgra);
    // The engine's overlay mutex spans the whole staging + re-issue unit so
    // the event thread's ks-overlay hides can neither prepare nor run
    // between this section's prepare and its overlay-add — a hide landing
    // there would be overwritten by the add and strand the stale page UI.
    // The registry lock still only ever guards cheap state: the resample
    // and the overlay-add run outside it, under the (much narrower) overlay
    // mutex.
    let (mpv, overlay_mu) = {
        let engines = super::lock_or_recover(super::engines());
        let Some(engine) = engines.get(&id) else {
            return;
        };
        (engine.mpv, std::sync::Arc::clone(&engine.overlay_mu))
    };
    let _overlay_guard = super::lock_or_recover(&overlay_mu);
    let issue = {
        let mut engines = super::lock_or_recover(super::engines());
        let Some(engine) = engines.get_mut(&id) else {
            return;
        };
        if seq < engine.page_seq {
            return; // a newer frame already stored
        }
        if let Some(prev) = engine.bitmaps.get("page") {
            if prev.w == w && prev.h == h && *prev.bgra == *bgra {
                return;
            }
        }
        engine.bitmap_gen += 1;
        let gen = engine.bitmap_gen;
        engine.bitmaps.insert(
            "page".to_string(),
            super::CachedBitmap {
                bgra: std::sync::Arc::clone(&bgra),
                w,
                h,
                grid: None,
            },
        );
        engine.prepare_page_reissue(gen)
    };
    if let Some(issue) = issue {
        match super::execute_overlay_issue(mpv, &issue) {
            Ok(entry) => super::record_overlay(id, issue.id, entry),
            Err(err) => eprintln!("[mpv] overlay-add: {err}"),
        }
    }
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
