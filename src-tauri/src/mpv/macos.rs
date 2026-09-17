// macOS (WKWebView) native video surface for the mpv-embed engine.
//
// Written against the documented AppKit + mpv `wid` semantics.
//
// DESIGN (no render-API plumbing on this platform): a plain NSView added to
// the WKWebView's superview BELOW the WKWebView
// (addSubview:positioned:relativeTo:), handed to mpv as `wid` — mpv attaches
// its own CA layer / video output to that view. Input stays with the webview
// (above it). Seeing the video requires a TRANSPARENT WKWebView:
// tauri.macos.conf.json repeats the window config with `transparent: true`
// (RFC 7396 merge REPLACES the windows array, hence the full entry) plus
// `app.macOSPrivateApi: true`, and Cargo.toml enables tauri's
// `macos-private-api` feature — all three are required for wry's private-API
// transparent-WKWebView path. The page also stops painting the player
// backdrop in native mode (`.app--native-video .player` in App.svelte).
//
// All AppKit calls are marshalled to the main thread (with_webview /
// run_on_main_thread); the raw view pointer is only dereferenced there.
//
// GEOMETRY CAVEAT: AppKit's coordinate system is BOTTOM-left origin, the
// frontend sends TOP-left-origin logical px (same values the GTK/Win32
// surfaces consume). set_rect flips Y against the superview's current bounds
// height before setFrame:.

use objc2::runtime::AnyObject;
use objc2::{class, msg_send};
use objc2_foundation::{NSPoint, NSRect, NSSize};
use tauri::{AppHandle, Manager};

use super::VideoSurface;

/// A raw NSView pointer. NSViews are NOT thread-safe — the wrapper exists so
/// the pointer can travel into main-thread dispatch closures, where (and only
/// where) `with` dereferences it. A method call on the whole wrapper also
/// defeats edition-2021 precise closure capture (a bare `wrapper.0` use
/// would capture the raw pointer and strip the Send wrapper).
struct MainThreadView(*mut AnyObject);
unsafe impl Send for MainThreadView {}
unsafe impl Sync for MainThreadView {}
impl MainThreadView {
    fn with<R>(self, f: impl FnOnce(*mut AnyObject) -> R) -> R {
        f(self.0)
    }
}

pub(super) struct MacOsSurface {
    app: AppHandle,
    view: MainThreadView,
}

impl VideoSurface for MacOsSurface {
    fn show(&self) {
        let view = MainThreadView(self.view.0);
        let _ = self.app.run_on_main_thread(move || {
            view.with(|view| unsafe {
                let _: () = msg_send![view, setHidden: false];
            });
        });
    }

    fn hide(&self) {
        let view = MainThreadView(self.view.0);
        let _ = self.app.run_on_main_thread(move || {
            view.with(|view| unsafe {
                let _: () = msg_send![view, setHidden: true];
            });
        });
    }

    fn set_rect(&self, x: i32, y: i32, w: i32, h: i32) {
        let view = MainThreadView(self.view.0);
        let _ = self.app.run_on_main_thread(move || {
            view.with(|view| unsafe {
                // Superview bounds height, for the top-left → bottom-left Y
                // flip (AppKit's origin is bottom-left; see the header).
                let superview: *mut AnyObject = msg_send![view, superview];
                if superview.is_null() {
                    return;
                }
                let bounds: NSRect = msg_send![superview, bounds];
                let flipped_y = (bounds.size.height - y as f64 - h as f64).round();
                let frame = NSRect::new(
                    NSPoint::new(x as f64, flipped_y),
                    NSSize::new(w.max(1) as f64, h.max(1) as f64),
                );
                let _: () = msg_send![view, setFrame: frame];
            });
        });
    }
}

/// Build the surface: create the NSView, insert it BELOW the WKWebView in
/// the shared superview, then hand its pointer to mpv as `wid` (mpv attaches
/// its own video output to the view — no render-context plumbing here).
pub(super) fn create(
    app: &AppHandle,
    mpv: &libmpv2::Mpv,
    _id: u32,
) -> Result<Box<dyn VideoSurface>, String> {
    let window = app
        .get_webview_window(crate::tray::MAIN_WINDOW)
        .ok_or("main window not found")?;

    // with_webview's closure runs on the main thread; the raw WKWebView
    // pointer (PlatformWebview::inner on macOS) is only used there.
    let (tx, rx) = std::sync::mpsc::channel();
    window
        .with_webview(move |webview| {
            let result = (|| -> Result<MainThreadView, String> {
                let wk: *mut AnyObject = webview.inner() as *mut AnyObject;
                if wk.is_null() {
                    return Err("WKWebView pointer is null".to_string());
                }
                let superview: *mut AnyObject = unsafe { msg_send![wk, superview] };
                if superview.is_null() {
                    return Err("WKWebView has no superview (wry layout changed?)".to_string());
                }
                let view: *mut AnyObject = unsafe { msg_send![class!(NSView), new] };
                if view.is_null() {
                    return Err("NSView new failed".to_string());
                }
                // NSWindowBelow = -1 (NSWindowOrderingMode): the new view goes
                // UNDER the WKWebView; the webview keeps every input event.
                const NS_WINDOW_BELOW: isize = -1;
                unsafe {
                    let _: () = msg_send![
                        superview,
                        addSubview: view,
                        positioned: NS_WINDOW_BELOW,
                        relativeTo: wk
                    ];
                    let _: () = msg_send![view, setHidden: true];
                }
                Ok(MainThreadView(view))
            })();
            let _ = tx.send(result);
        })
        .map_err(|e| format!("with_webview dispatch failed: {e}"))?;

    let view = rx
        .recv_timeout(std::time::Duration::from_secs(10))
        .map_err(|_| "surface init timed out".to_string())??;

    // mpv pins its video output to the view (i64 form of the pointer). The
    // view is retained by its superview, so the pointer stays valid.
    mpv.set_property("wid", view.0 as i64)
        .map_err(|e| format!("set wid: {e}"))?;

    Ok(Box::new(MacOsSurface {
        app: app.clone(),
        view,
    }))
}
