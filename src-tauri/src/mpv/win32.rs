// Windows (WebView2) native video surface for the mpv-embed engine.
//
// Written against the documented Win32 + WebView2 + mpv `wid` semantics.
//
// DESIGN (no render-API plumbing on this platform): a plain child HWND of the
// Tauri window, z-ordered to the BOTTOM of the sibling stack so it sits
// UNDER the WebView2 controller's own child HWND, handed to mpv as `wid` —
// mpv then creates its own video output INSIDE that window. Input stays with
// the webview (top of the Z order). Seeing the video requires the webview
// background to be transparent: tauri.windows.conf.json repeats the window
// config with `transparent: true` (RFC 7396 merge REPLACES the windows
// array, hence the full entry), which wry maps to WebView2's transparent
// DefaultBackgroundColor; the page also stops painting the player backdrop
// in native mode (`.app--native-video .player` in App.svelte).
//
// KNOWN RISK (deliberately surfaced, not improvised around): in windowed
// hosting, a transparent WebView2 may composite over the PARENT window's
// background rather than over sibling child windows beneath it. If that
// shows the window background where the video should be, the fallback is
// WebView2 COMPOSITION hosting — which wry does not expose. Do not invent a
// workaround here; stop and report.
//
// DPI: the frontend sends LOGICAL px (same as the GTK surface). Win32 child
// window coordinates are physical when the process is per-monitor DPI aware
// (Tauri is), so set_rect multiplies by the window's scale factor on the UI
// thread before SetWindowPos.

use tauri::{AppHandle, Manager};
use windows_sys::Win32::Foundation::HWND;
use windows_sys::Win32::System::LibraryLoader::GetModuleHandleW;
use windows_sys::Win32::UI::WindowsAndMessaging::{
    CreateWindowExW, DestroyWindow, SetWindowPos, ShowWindow, HWND_BOTTOM, SWP_NOACTIVATE, SW_HIDE,
    SW_SHOWNA, WS_CHILD,
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

pub(super) struct WindowsSurface {
    app: AppHandle,
    hwnd: ChildHwnd,
}

fn wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(std::iter::once(0)).collect()
}

impl VideoSurface for WindowsSurface {
    fn show(&self) {
        let hwnd = self.hwnd;
        let _ = self.app.run_on_main_thread(move || unsafe {
            ShowWindow(hwnd.raw(), SW_SHOWNA);
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
                // HWND_BOTTOM on every move: the child must stay beneath the
                // WebView2 sibling regardless of what else re-orders the stack.
                SetWindowPos(
                    hwnd.raw(),
                    HWND_BOTTOM,
                    px(x),
                    px(y),
                    px(w.max(1)),
                    px(h.max(1)),
                    SWP_NOACTIVATE,
                );
            }
        });
    }
}

impl Drop for WindowsSurface {
    fn drop(&mut self) {
        let hwnd = self.hwnd;
        let _ = self.app.run_on_main_thread(move || unsafe {
            DestroyWindow(hwnd.raw());
        });
    }
}

/// Build the surface: create the child HWND under the main window's WebView2,
/// then hand it to mpv as `wid` (so mpv renders into it with its OWN vo —
/// that is why this platform has no render-context plumbing).
pub(super) fn create(
    app: &AppHandle,
    mpv: &libmpv2::Mpv,
    _id: u32,
) -> Result<Box<dyn VideoSurface>, String> {
    let window = app
        .get_webview_window(crate::tray::MAIN_WINDOW)
        .ok_or("main window not found")?;
    let parent = window.hwnd().map_err(|e| format!("no main HWND: {e}"))?;

    // A "STATIC"-class child window: a plain surface with the system's
    // default (no-op for painting) window procedure — mpv subclasses/renders
    // into it via wid. Hidden until a stream loads.
    let class = wide("STATIC");
    let module = unsafe { GetModuleHandleW(std::ptr::null()) };
    let hwnd = unsafe {
        CreateWindowExW(
            0,                    // dwExStyle
            class.as_ptr(),       // lpClassName
            std::ptr::null(),     // lpWindowName
            WS_CHILD,             // dwStyle (no WS_VISIBLE yet)
            0,                    // x
            0,                    // y
            1,                    // nWidth
            1,                    // nHeight
            parent.0,             // hWndParent (tauri's HWND newtype → raw)
            std::ptr::null_mut(), // hMenu
            module,               // hInstance
            std::ptr::null(),     // lpParam
        )
    };
    if hwnd.is_null() {
        return Err("CreateWindowExW failed".to_string());
    }
    // Bottom of the sibling stack = under the WebView2 controller's HWND.
    unsafe {
        SetWindowPos(hwnd, HWND_BOTTOM, 0, 0, 1, 1, SWP_NOACTIVATE);
    }

    // mpv owns this window from here on: `wid` pins its video output to the
    // child HWND (i64 form of the handle, per libmpv docs).
    mpv.set_property("wid", hwnd as i64)
        .map_err(|e| format!("set wid: {e}"))?;

    Ok(Box::new(WindowsSurface {
        app: app.clone(),
        hwnd: ChildHwnd(hwnd),
    }))
}
