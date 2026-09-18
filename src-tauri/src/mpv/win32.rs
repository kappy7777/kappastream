// Windows (WebView2) native video surface for the mpv-embed engine.
//
// DESIGN — video ABOVE the (opaque) page, mirroring linux.rs: a plain
// "STATIC"-class child HWND of the Tauri window, z-ordered to the TOP of
// the sibling stack (above the WebView2 controller's own child windows —
// verified on hardware 2026-09-18: raised, the video renders and audio
// works), handed to mpv as `wid`. The page stays fully OPAQUE; the old
// below-the-webview design cannot work here because WebView2 composites
// through DirectComposition (the "Intermediate D3D Window" in the child
// stack) — a sibling HWND beneath it is unrevealable by page transparency.
//
// INPUT PASS-THROUGH, the Windows counterpart of linux.rs's 1px-corner
// input shapes: every window on the video side carries WS_EX_TRANSPARENT.
// The mechanism (Win32 docs + Chen): a window with that style is skipped
// by hit-testing like an HTTRANSPARENT result, and HTTRANSPARENT "will be
// sent to underlying windows in the same thread until one of them returns
// a code that is not HTTRANSPARENT" (WM_NCHITTEST docs, learn.microsoft
// .../inputdev/wm-nchittest; Chen: WindowFromPoint "defines transparent
// as returns HTTRANSPARENT in response to WM_NCHITTEST", the
// ChildWindowFromPoint family "as has the WS_EX_TRANSPARENT extended
// window style" — devblogs 2010/12/30). PAINTING is unaffected: the style
// only orders painting among same-process siblings ("should not be painted
// until siblings beneath … have been painted"; "not a just turn this on
// and you get transparent rendering" — Chen 2012/12/17) — mpv's D3D
// swapchain still paints fully opaque video. The style is deliberately
// NOT WS_EX_LAYERED: layered child windows interact badly with D3D/DComp
// swapchain children, and alpha-based hit-through is not wanted here.
//
// SAME-THREAD CAVEAT (the load-bearing one): HTTRANSPARENT propagation
// only hops to windows on the same thread. The Static is therefore CREATED
// ON THE MAIN/UI THREAD (also what Win32 demands for DestroyWindow in
// Drop), so the hop lands on the same-thread windows directly beneath it
// (tauri's drag-resize borders, wry's host) — the same chain the page's
// input already follows today into the WebView2 children. If hardware
// testing ever shows the propagation dying against the cross-process
// Chrome_* siblings, the fallback is forwarding WM_MOUSE* from the video
// window's own message loop — a separate task, not something to improvise
// here.
//
// CRITICAL (hardware-verified): extended window styles are NOT inherited.
// mpv (w32_common.c gui_thread) creates its OWN child inside the Static —
// class "mpv", WS_CHILD|WS_VISIBLE, ex-style only WS_EX_NOPARENTNOTIFY —
// once per VO INIT (not per loadfile; a VO re-init after uninit starts a
// fresh one). That child would swallow every pointer event over the
// video, so `apply_input_passthrough` enumerates the Static's DESCENDANTS
// (EnumChildWindows recurses — documented) and patches each — re-applied
// on every load (mod.rs FileLoaded) and on every show(), because a VO
// re-init can mint an unpatched window mid-session. This mirrors
// linux.rs's size-allocate re-shape hook.
//
// WS_EX_NOACTIVATE: insurance, not the mechanism — documented as "does
// not become the foreground window when the user clicks it" / not
// activated programmatically (extended-window-styles docs). With
// hit-through in place clicks never arrive at the video windows at all;
// this covers the gap before the first patch lands (a stray click on the
// fresh, unpatched mpv child must not steal focus from the webview) and
// has no painting or hit-test effect of its own.
//
// DPI: the frontend sends LOGICAL px (same as the GTK surface). Win32
// child window coordinates are physical when the process is per-monitor
// DPI aware (Tauri is), so set_rect multiplies by the window's scale
// factor on the UI thread before SetWindowPos.

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use tauri::{AppHandle, Manager};
use webview2_com::Microsoft::Web::WebView2::Win32::{
    ICoreWebView2CallDevToolsProtocolMethodCompletedHandler,
    ICoreWebView2CallDevToolsProtocolMethodCompletedHandler_Impl,
};
use windows::core::{w, HRESULT, PCWSTR};
use windows::Win32::Graphics::Imaging::{
    CLSID_WICImagingFactory, GUID_WICPixelFormat32bppBGRA, IWICFormatConverter, IWICImagingFactory,
    IWICStream, WICBitmapDitherTypeNone, WICBitmapPaletteTypeCustom,
    WICDecodeMetadataCacheOnDemand,
};
use windows::Win32::System::Com::{
    CoCreateInstance, CoInitializeEx, CoUninitialize, CLSCTX_INPROC_SERVER,
    COINIT_APARTMENTTHREADED,
};
use windows_sys::core::BOOL;
use windows_sys::Win32::Foundation::{HWND, LPARAM};
use windows_sys::Win32::System::LibraryLoader::GetModuleHandleW;
use windows_sys::Win32::UI::WindowsAndMessaging::{
    CreateWindowExW, DestroyWindow, EnumChildWindows, GetWindowLongPtrW, SetWindowLongPtrW,
    SetWindowPos, ShowWindow, GWL_EXSTYLE, HWND_TOP, SWP_FRAMECHANGED, SWP_NOACTIVATE, SWP_NOMOVE,
    SWP_NOSIZE, SWP_NOZORDER, SW_HIDE, SW_SHOWNA, WS_CHILD, WS_EX_NOACTIVATE, WS_EX_TRANSPARENT,
};

use super::VideoSurface;

/// A raw HWND. Win32 window handles are plain opaque values (documented safe
/// to hold and pass around from any thread — only the mutating calls are
/// marshalled to the UI thread here). The `raw()` method exists so closures
/// capture the WHOLE wrapper (Copy + Send) instead of the raw pointer field
/// — edition-2021 disjoint field capture would capture `*mut c_void`, which
/// is not Send and breaks run_on_main_thread.
#[derive(Clone, Copy)]
struct ChildHwnd(HWND);
unsafe impl Send for ChildHwnd {}
unsafe impl Sync for ChildHwnd {}

impl ChildHwnd {
    #[inline]
    fn raw(self) -> HWND {
        self.0
    }
}

/// The pass-through extended-style pair applied to every window on the video
/// side (see the module header for the mechanism and the citations).
const PASSTHROUGH_EX_STYLE: u32 = WS_EX_TRANSPARENT | WS_EX_NOACTIVATE;

pub(super) struct WindowsSurface {
    app: AppHandle,
    hwnd: ChildHwnd,
}

fn wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(std::iter::once(0)).collect()
}

/// Add the pass-through ex-styles to one window. Idempotent: an already
/// patched window short-circuits (no SetWindowLongPtrW write, no
/// SetWindowPos) so the per-load re-apply is free. Returns whether a style
/// write happened (diagnostics: distinguishes "already patched" from
/// "patched a fresh window").
fn add_passthrough_ex_style(hwnd: HWND) -> bool {
    unsafe {
        let style = GetWindowLongPtrW(hwnd, GWL_EXSTYLE);
        let mask = PASSTHROUGH_EX_STYLE as isize;
        if style & mask == mask {
            return false;
        }
        SetWindowLongPtrW(hwnd, GWL_EXSTYLE, style | mask);
        // SetWindowLongPtr docs: "Certain window data is cached, so changes
        // you make using SetWindowLongPtr will not take effect until you
        // call the SetWindowPos function" — with exactly this flag combo
        // (SWP_NOMOVE|SWP_NOSIZE|SWP_NOZORDER|SWP_FRAMECHANGED, per the
        // SetWindowPos remarks). NOACTIVATE: raising a style change must
        // never steal activation from the webview.
        SetWindowPos(
            hwnd,
            std::ptr::null_mut(),
            0,
            0,
            0,
            0,
            SWP_NOMOVE | SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE | SWP_FRAMECHANGED,
        );
        true
    }
}

/// Patch bookkeeping threaded through EnumChildWindows' LPARAM: how many
/// descendant windows exist vs how many needed a style write. A descendant
/// count that grows between calls = mpv minted a window since the last
/// patch (the (c) signature in the input investigation).
#[derive(Default)]
struct PatchStats {
    found: u32,
    written: u32,
}

/// EnumChildWindows callback: patch every descendant of the Static (the
/// documentation guarantees descendants are enumerated too, so mpv's
/// "mpv"-class child — and anything IT ever parents — is covered).
unsafe extern "system" fn patch_descendant(hwnd: HWND, lparam: LPARAM) -> BOOL {
    let stats = unsafe { &mut *(lparam as *mut PatchStats) };
    stats.found += 1;
    if add_passthrough_ex_style(hwnd) {
        stats.written += 1;
    }
    1 // keep enumerating
}

/// Re-assert TOP of the sibling stack without touching position/size.
fn raise_to_top(hwnd: HWND) {
    unsafe {
        SetWindowPos(
            hwnd,
            HWND_TOP,
            0,
            0,
            0,
            0,
            SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE,
        );
    }
}

/// Patch the Static itself and every descendant (mpv's video window). Must
/// run on the UI thread (same thread as the window's creator). Under
/// KAPPASTREAM_MPV_LOG, prints the found/written counts — the difference
/// between consecutive calls is what exposes an mpv window minted between
/// patches.
fn patch_surface_tree(hwnd: HWND) {
    let mut stats = PatchStats::default();
    if add_passthrough_ex_style(hwnd) {
        stats.written += 1;
    }
    unsafe {
        EnumChildWindows(
            hwnd,
            Some(patch_descendant),
            &mut stats as *mut PatchStats as LPARAM,
        );
    }
    if super::debug_log_enabled() {
        eprintln!(
            "[mpv-win32] input passthrough: {} descendant(s), {} style write(s) this pass",
            stats.found, stats.written
        );
    }
}

impl VideoSurface for WindowsSurface {
    fn show(&self) {
        let hwnd = self.hwnd;
        let _ = self.app.run_on_main_thread(move || unsafe {
            ShowWindow(hwnd.raw(), SW_SHOWNA);
            // Re-assert TOP on every reveal: nothing may sink the video
            // under the WebView2 stack (a later layout pass, a z-order
            // shuffle) without this catching it. Also re-apply the
            // pass-through styles — show() fires on every PlaybackRestart,
            // which always follows a (re-)load, so a VO re-init's fresh
            // child window gets patched even if its FileLoaded hook raced.
            raise_to_top(hwnd.raw());
            patch_surface_tree(hwnd.raw());
        });
    }

    fn hide(&self) {
        let hwnd = self.hwnd;
        let _ = self.app.run_on_main_thread(move || unsafe {
            ShowWindow(hwnd.raw(), SW_HIDE);
        });
    }

    fn set_rect(&self, x: i32, y: i32, w: i32, h: i32) {
        let hwnd = self.hwnd;
        let app = self.app.clone();
        let _ = self.app.run_on_main_thread(move || {
            let scale = app
                .get_webview_window(crate::tray::MAIN_WINDOW)
                .and_then(|win| win.scale_factor().ok())
                .unwrap_or(1.0);
            let px = |v: i32| (v as f64 * scale).round() as i32;
            unsafe {
                // HWND_TOP on every move: the child must stay ABOVE the
                // WebView2 sibling stack regardless of what else re-orders
                // it (one SetWindowPos call: move + size + z-order).
                SetWindowPos(
                    hwnd.raw(),
                    HWND_TOP,
                    px(x),
                    px(y),
                    px(w.max(1)),
                    px(h.max(1)),
                    SWP_NOACTIVATE,
                );
            }
        });
    }

    fn apply_input_passthrough(&self) {
        let hwnd = self.hwnd;
        let _ = self
            .app
            .run_on_main_thread(move || patch_surface_tree(hwnd.raw()));
    }
}

impl Drop for WindowsSurface {
    fn drop(&mut self) {
        let hwnd = self.hwnd;
        // Same thread that created the window (main/UI) — Win32 requires
        // the creator's thread to destroy it.
        let _ = self.app.run_on_main_thread(move || unsafe {
            DestroyWindow(hwnd.raw());
        });
    }
}

/// Build the surface: create the child HWND ABOVE the main window's WebView2
/// (main thread — see the header's same-thread note), then hand it to mpv
/// as `wid` (so mpv renders into it with its OWN vo — that is why this
/// platform has no render-context plumbing).
pub(super) fn create(
    app: &AppHandle,
    mpv: &libmpv2::Mpv,
    _id: u32,
) -> Result<Box<dyn VideoSurface>, String> {
    let window = app
        .get_webview_window(crate::tray::MAIN_WINDOW)
        .ok_or("main window not found")?;
    let parent = ChildHwnd(window.hwnd().map_err(|e| format!("no main HWND: {e}"))?.0);

    // Creation happens on the MAIN/UI thread (channel round-trip like
    // macos.rs): the HTTRANSPARENT propagation only hops same-thread
    // windows, and DestroyWindow in Drop must run on the creator's thread —
    // both pin the window to the thread that owns the main window, the wry
    // host, and tauri's drag-resize borders sitting directly beneath it.
    let (tx, rx) = std::sync::mpsc::channel();
    app.run_on_main_thread(move || {
        // A "STATIC"-class child window: a plain surface with the system's
        // default (no-op for painting) window procedure — mpv parents its
        // own "mpv"-class video child into it via wid. Hidden until a
        // stream loads. The pass-through ex-styles are set AT CREATION so
        // the window can never briefly swallow input; NOACTIVATE keeps a
        // stray pre-load click from stealing focus from the webview.
        let class = wide("STATIC");
        let module = unsafe { GetModuleHandleW(std::ptr::null()) };
        let hwnd = unsafe {
            CreateWindowExW(
                PASSTHROUGH_EX_STYLE, // dwExStyle
                class.as_ptr(),       // lpClassName
                std::ptr::null(),     // lpWindowName
                WS_CHILD,             // dwStyle (no WS_VISIBLE yet)
                0,                    // x
                0,                    // y
                1,                    // nWidth
                1,                    // nHeight
                parent.raw(),         // hWndParent
                std::ptr::null_mut(), // hMenu
                module,               // hInstance
                std::ptr::null(),     // lpParam
            )
        };
        if !hwnd.is_null() {
            // Top of the sibling stack = above the WebView2 controller's
            // HWND (raise once here; set_rect/show re-assert it).
            raise_to_top(hwnd);
        }
        let _ = tx.send(ChildHwnd(hwnd));
    })
    .map_err(|e| format!("main-thread dispatch failed: {e}"))?;

    let hwnd = rx
        .recv_timeout(std::time::Duration::from_secs(10))
        .map_err(|_| "surface init timed out")?;
    if hwnd.raw().is_null() {
        return Err("CreateWindowExW failed".to_string());
    }
    if super::debug_log_enabled() {
        eprintln!("[mpv-win32] surface created: static HWND {:p}", hwnd.raw());
    }

    // mpv owns this window from here on: `wid` pins its video output to the
    // child HWND (i64 form of the handle, per libmpv docs). mpv's own child
    // appears at VO init and is patched by apply_input_passthrough /
    // show() — see the module header.
    mpv.set_property("wid", hwnd.raw() as i64)
        .map_err(|e| format!("set wid: {e}"))?;

    Ok(Box::new(WindowsSurface {
        app: app.clone(),
        hwnd,
    }))
}

// ---------------------------------------------------------------------------
// Page-UI overlay snapshots (mpv_page_snapshot) — the Windows counterpart of
// linux.rs's webkit_web_view_get_snapshot pipeline.
//
// DESIGN (investigated 2026-09-18, owner-approved approach): the webview is
// UNDER the native video window, so small page strips (tooltips, toasts, the
// update banner, the notification menu, the search dropdown) must be
// re-drawn OVER the video as mpv overlays. WebView2's own CapturePreview is
// useless here (no crop, whole-page encode, fails before first paint), so
// the pixels come from CDP Page.captureScreenshot via
// ICoreWebView2::CallDevToolsProtocolMethod — reachable from tauri's
// `with_webview` (PlatformWebview::controller() → CoreWebView2()), with a
// `clip` viewport (CSS px == DIP == the space the frontend's union box and
// keep rects arrive in) for a NATIVE crop of just the overlapping UI.
// format=png + optimizeForSpeed (crops are small; text stays crisp; jpeg
// only if large crops ever churn). The Linux pipeline is NOT ported: no
// cairo, no GTK snapshot — decode happens through WIC (a system component;
// no new external crate) into straight-alpha BGRA, exactly what overlay-add
// composites (the Linux path has to un-premultiply cairo ARGB32 first —
// PNG gives straight alpha for free).
//
// ASYNC MODEL: CDP responses may be processed out of order (WebView2 docs),
// so every request allocates a sequence number under the engine lock and a
// late older frame can never overwrite a newer one (same guard as linux.rs)
// — no in-flight flag needed; the 120 ms per-engine coalescing bounds the
// request rate, and a response that never arrives (webview teardown) just
// leaves the previous bitmap in place. The Invoke callback runs on the UI
// thread and only copies the JSON out; WIC decode + masking + the overlay
// store/re-issue happen on a worker thread.

/// Per-engine snapshot coalescing window — mirrors linux.rs's
/// PAGE_SNAPSHOT_LAST (self-expiring guard, deliberately NOT an in-flight
/// flag; see the header).
static PAGE_SNAPSHOT_LAST: std::sync::OnceLock<Mutex<HashMap<u32, Instant>>> =
    std::sync::OnceLock::new();

// The CDP completion handler. webview2-com's own #[completed_callback]
// macro is CRATE-INTERNAL (its generated tokens resolve `crate::Result`,
// `crate::wait_with_pump`, …) — unusable from outside — so this is a plain
// `#[implement]` class against the interface's generated `_Impl` trait
// (same machinery wry uses for its handlers). Invoke carries
// (errorCode: HRESULT, resultObjectAsJson: PCWSTR) and runs exactly once,
// on the UI thread; the closure only copies the JSON out and moves the
// heavy half to a worker.
#[windows::core::implement(ICoreWebView2CallDevToolsProtocolMethodCompletedHandler)]
struct CdpCaptureCompleted {
    closure: std::cell::RefCell<Option<Box<dyn FnOnce(windows::core::Result<()>, String)>>>,
}

impl ICoreWebView2CallDevToolsProtocolMethodCompletedHandler_Impl for CdpCaptureCompleted_Impl {
    fn Invoke(&self, errorcode: HRESULT, result: &PCWSTR) -> windows::core::Result<()> {
        // SAFETY: `result` points at a NUL-terminated wide string owned by
        // the caller for the duration of Invoke; to_string copies it out
        // before anything else happens.
        let json = unsafe { result.to_string() }.unwrap_or_default();
        if let Some(closure) = self.closure.borrow_mut().take() {
            closure(errorcode.ok(), json);
        }
        Ok(())
    }
}

/// Everything the completion → worker chain needs. `crop` is the CSS-px size
/// the frontend requested (the PNG's actual size over it maps keep rects);
/// `seq` is the engine sequence allocated at request time (ordering guard —
/// see header).
struct CaptureMeta {
    id: u32,
    crop: (i32, i32),
    keep: Vec<i32>,
    seq: u64,
}

/// Snapshot the page and stage the crop over the overlapping UI as the
/// engine's "page" bitmap — same contract as linux.rs's `page_snapshot`.
pub(super) fn page_snapshot(
    app: &AppHandle,
    id: u32,
    x: i32,
    y: i32,
    w: i32,
    h: i32,
    keep: Vec<i32>,
) -> Result<(), String> {
    if !super::engines()
        .lock()
        .expect("mpv engines lock poisoned")
        .contains_key(&id)
    {
        return Err("no engine".to_string());
    }
    {
        let mut last = PAGE_SNAPSHOT_LAST
            .get_or_init(|| Mutex::new(HashMap::new()))
            .lock()
            .expect("mpv snapshot guard lock poisoned");
        let fresh = match last.get(&id) {
            Some(t) => t.elapsed() >= Duration::from_millis(120),
            None => true,
        };
        if !fresh {
            return Ok(()); // coalesced; the active snapshot's result lands first
        }
        last.insert(id, Instant::now());
    }
    // Sequence number under the engine lock, BEFORE the async request (the
    // worker compares against the engine's page_seq at store time).
    let seq = super::engines()
        .lock()
        .expect("mpv engines lock poisoned")
        .get_mut(&id)
        .map(|e| {
            e.page_seq += 1;
            e.page_seq
        })
        .unwrap_or(0);

    // clip coordinates are CSS px of the viewport — exactly the space the
    // frontend measured its union box in (getBoundingClientRect returns
    // visual px; documentElement zoom is inside the page, not the viewport).
    // scale:1 keeps the crop at DIP resolution; the decoded PNG's ACTUAL
    // size is what maps keep rects (never assume the DPR behavior).
    let params = format!(
        "{{\"format\":\"png\",\"optimizeForSpeed\":true,\"clip\":{{\"x\":{x},\"y\":{y},\"width\":{w},\"height\":{h},\"scale\":1}}}}"
    );
    let meta = CaptureMeta {
        id,
        crop: (w, h),
        keep,
        seq,
    };
    let window = app
        .get_webview_window(crate::tray::MAIN_WINDOW)
        .ok_or_else(|| "main window not found".to_string())?;
    window
        .with_webview(move |wv| {
            // with_webview's closure cannot return errors — failures past
            // this point are silent (the frontend keeps polling; a broken
            // snapshot is a visual no-op), logged under KAPPASTREAM_MPV_LOG.
            let controller = wv.controller();
            // SAFETY: the controller outlives this closure (owned by the
            // webview) and CoreWebView2() is a plain COM getter.
            let Ok(core) = (unsafe { controller.CoreWebView2() }) else {
                if super::debug_log_enabled() {
                    eprintln!("[mpv-win32] page snapshot: no CoreWebView2");
                }
                return;
            };
            let handler: ICoreWebView2CallDevToolsProtocolMethodCompletedHandler =
                CdpCaptureCompleted {
                    closure: std::cell::RefCell::new(Some(Box::new(
                        move |res: windows::core::Result<()>, json: String| {
                            if res.is_err() {
                                if super::debug_log_enabled() {
                                    eprintln!("[mpv-win32] page snapshot CDP error: {res:?}");
                                }
                                return;
                            }
                            std::thread::spawn(move || finish_page_snapshot(&json, meta));
                        },
                    ))),
                }
                .into();
            let call = unsafe {
                core.CallDevToolsProtocolMethod(
                    w!("Page.captureScreenshot"),
                    &windows::core::HSTRING::from(params),
                    &handler,
                )
            };
            if let Err(e) = call {
                if super::debug_log_enabled() {
                    eprintln!("[mpv-win32] page snapshot call failed: {e}");
                }
            }
        })
        .map_err(|e| format!("with_webview dispatch failed: {e}"))
}

/// Worker half (own thread): parse the CDP JSON, decode the PNG to BGRA via
/// WIC, map the keep rects from CSS px to actual bitmap px, mask, and store
/// as the engine's "page" bitmap with the seq/ordering + identical-pixel
/// dedupe + page_geo re-issue semantics of linux.rs's store_page_snapshot.
fn finish_page_snapshot(json: &str, meta: CaptureMeta) {
    let CaptureMeta {
        id,
        crop: (w, h),
        keep,
        seq,
    } = meta;
    let data = match serde_json::from_str::<serde_json::Value>(json)
        .ok()
        .and_then(|v| v.get("data").and_then(|d| d.as_str()).map(str::to_string))
    {
        Some(d) => d,
        None => return,
    };
    let png = match super::b64_decode(&data) {
        Ok(p) => p,
        Err(_) => return,
    };
    let (bgra, bw, bh) = match decode_png_bgra(&png) {
        Ok(ok) => ok,
        Err(e) => {
            if super::debug_log_enabled() {
                eprintln!("[mpv-win32] page snapshot decode failed: {e}");
            }
            return;
        }
    };
    if bw == 0 || bh == 0 {
        return;
    }
    // CSS px → actual bitmap px (the PNG's real size over the requested crop
    // size — robust whatever DPR/scale the capture applied).
    let scale_x = f64::from(bw) / f64::from(w);
    let scale_y = f64::from(bh) / f64::from(h);
    let clamp = |v: f64, max: u32| -> u32 { (v.floor() as i64).clamp(0, i64::from(max)) as u32 };
    let keep_px = keep
        .chunks_exact(4)
        .filter_map(|r| {
            let a1 = clamp(f64::from(r[0]) * scale_x, bw);
            let a2 = clamp(f64::from(r[0].saturating_add(r[2])) * scale_x, bw);
            let b1 = clamp(f64::from(r[1]) * scale_y, bh);
            let b2 = clamp(f64::from(r[1].saturating_add(r[3])) * scale_y, bh);
            let kx = a1.min(bw as u32);
            let ky = b1.min(bh as u32);
            let kw = a2.saturating_sub(kx).min(bw.saturating_sub(kx));
            let kh = b2.saturating_sub(ky).min(bh.saturating_sub(ky));
            if kw == 0 || kh == 0 {
                None
            } else {
                Some((kx as usize, ky as usize, kw as usize, kh as usize))
            }
        })
        .collect::<Vec<_>>();
    let mut bgra = bgra;
    super::mask_keep_rects(&mut bgra, bw as usize, bh as usize, &keep_px);
    let mut engines = super::engines().lock().expect("mpv engines lock poisoned");
    let Some(engine) = engines.get_mut(&id) else {
        return;
    };
    if seq < engine.page_seq {
        return; // a newer frame already stored
    }
    if let Some(prev) = engine.bitmaps.get("page") {
        if prev.w == bw && prev.h == bh && prev.bgra == bgra {
            return;
        }
    }
    engine.bitmap_gen += 1;
    engine.bitmaps.insert(
        "page".to_string(),
        super::CachedBitmap {
            bgra,
            w: bw,
            h: bh,
            grid: None,
        },
    );
    if let Some((pos, dims)) = engine.page_geo {
        let _ = engine.show_bitmap(super::OVERLAY_PAGE, "page", 0, pos, dims);
    }
}

/// Decode a PNG to straight-alpha row-major BGRA (overlay-add's format) via
/// the Windows Imaging Component — a system component, so the snapshot path
/// adds no new external crate. COM is initialized per call (this runs on a
/// fresh worker thread; apartment-threaded, uninitialized on the way out
/// only when THIS call initialized it).
fn decode_png_bgra(png: &[u8]) -> Result<(Vec<u8>, u32, u32), String> {
    // SAFETY: standard COM/WIC usage on a thread we own; every raw out-param
    // points at a live local, and `png` outlives the decode (the stream
    // reads from its memory).
    unsafe {
        let hr = CoInitializeEx(None, COINIT_APARTMENTTHREADED);
        if hr.is_err() {
            return Err(format!("CoInitializeEx: {hr}"));
        }
        let result = decode_png_bgra_com(png);
        CoUninitialize();
        result
    }
}

unsafe fn decode_png_bgra_com(png: &[u8]) -> Result<(Vec<u8>, u32, u32), String> {
    unsafe {
        let factory: IWICImagingFactory =
            CoCreateInstance(&CLSID_WICImagingFactory, None, CLSCTX_INPROC_SERVER)
                .map_err(|e| format!("CoCreateInstance(WIC): {e}"))?;
        // IWICStream::InitializeFromMemory keeps READING the caller's buffer
        // for the stream's lifetime — `png` outlives the whole decode.
        let stream: IWICStream = factory
            .CreateStream()
            .map_err(|e| format!("WIC CreateStream: {e}"))?;
        stream
            .InitializeFromMemory(png)
            .map_err(|e| format!("WIC InitializeFromMemory: {e}"))?;
        let decoder = factory
            .CreateDecoderFromStream(&stream, std::ptr::null(), WICDecodeMetadataCacheOnDemand)
            .map_err(|e| format!("WIC CreateDecoderFromStream: {e}"))?;
        let frame = decoder
            .GetFrame(0)
            .map_err(|e| format!("WIC GetFrame: {e}"))?;
        let converter: IWICFormatConverter = factory
            .CreateFormatConverter()
            .map_err(|e| format!("WIC CreateFormatConverter: {e}"))?;
        converter
            .Initialize(
                &frame,
                &GUID_WICPixelFormat32bppBGRA,
                WICBitmapDitherTypeNone,
                None,
                0.0,
                WICBitmapPaletteTypeCustom,
            )
            .map_err(|e| format!("WIC Initialize: {e}"))?;
        let (mut bw, mut bh) = (0u32, 0u32);
        converter
            .GetSize(&mut bw, &mut bh)
            .map_err(|e| format!("WIC GetSize: {e}"))?;
        if bw == 0 || bh == 0 {
            return Err("WIC: zero-sized frame".to_string());
        }
        let stride = bw
            .checked_mul(4)
            .ok_or_else(|| "WIC: stride overflow".to_string())?;
        let size = (stride as usize)
            .checked_mul(bh as usize)
            .ok_or_else(|| "WIC: buffer overflow".to_string())?;
        let mut buf = vec![0u8; size];
        converter
            .CopyPixels(std::ptr::null(), stride, &mut buf)
            .map_err(|e| format!("WIC CopyPixels: {e}"))?;
        Ok((buf, bw, bh))
    }
}
