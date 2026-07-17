//! Linux graphics-compatibility setup.
//!
//! Invoked from the very top of `main()` (see `main.rs`), before `tauri::Builder`
//! and therefore before GTK, WebKitGTK, EGL or any Tauri webview initializes.
//!
//! There are two independent NVIDIA-specific workarounds, each applied only on
//! the matching session type and only when the user has not already supplied a
//! value. AMD, Intel and unknown sessions are always left untouched, and the two
//! workarounds are never both selected during a single session.
//!
//! ## Wayland — `__NV_DISABLE_EXPLICIT_SYNC=1`
//!
//! NVIDIA EGL-Wayland explicit sync can terminate GTK/WebKitGTK applications
//! when a surface is committed without an acquire point — the compositor raises
//! `wp_linux_drm_syncobj_surface_v1` error 4 ("explicit sync is used, but no
//! acquire point is set"), which surfaces as `Gdk-Message: Error 71 (Protocol
//! error) dispatching to Wayland display` and aborts the process. Setting
//! `__NV_DISABLE_EXPLICIT_SYNC=1` makes EGL-Wayland fall back to implicit sync,
//! avoiding the crash while keeping WebKitGTK's accelerated compositing path
//! enabled (the previous broad workaround, `WEBKIT_DISABLE_COMPOSITING_MODE=1`,
//! globally disabled compositing and crippled maximized-window performance).
//!
//! ## X11 — `WEBKIT_DISABLE_DMABUF_RENDERER=1`
//!
//! On X11 with the NVIDIA kernel driver loaded, WebKitGTK's DMA-BUF renderer can
//! fail to allocate a GBM buffer and print `Failed to create GBM buffer of size
//! 800x600: Invalid argument`, leaving the webview blank/invisible while the
//! process keeps running. Setting `WEBKIT_DISABLE_DMABUF_RENDERER=1` makes
//! WebKitGTK skip the GBM/DMA-BUF renderer path while leaving its compositing
//! mode enabled — the UI becomes visible and acceleration is otherwise retained.
//! It does not disable compositing globally and does not imply every NVIDIA or
//! every WebKitGTK version is affected.
//!
//! ## Common rules
//!
//! Both variables are applied only when ALL hold for their respective path:
//!  - the NVIDIA kernel driver appears loaded, AND
//!  - the session matches (Wayland for explicit sync, X11 for DMA-BUF renderer), AND
//!  - the user has not already set the variable.
//!
//! A user-provided value (including `"0"`, `"1"`, an arbitrary string, or even an
//! empty string) is always preserved — we only ever set a variable when it is
//! entirely absent.

use std::path::Path;

const NV_EXPLICIT_SYNC_VAR: &str = "__NV_DISABLE_EXPLICIT_SYNC";
const WEBKIT_DMABUF_VAR: &str = "WEBKIT_DISABLE_DMABUF_RENDERER";

/// Whether an NVIDIA kernel driver appears to be loaded, via two
/// dependency-free kernel signals. `/sys/module/nvidia` is a directory created
/// by the kernel when the `nvidia` module is loaded; `/proc/driver/nvidia/version`
/// is the procfs file the NVIDIA driver registers. Either present counts as
/// "NVIDIA loaded"; both are absent on AMD/Intel-only and NVIDIA-free systems.
///
/// Takes its paths as arguments so the probes can be exercised by unit tests
/// against stable filesystem objects (e.g. `/proc/self/status`, `/sys/module`)
/// without NVIDIA hardware or root.
fn nvidia_driver_present(proc_version: &Path, sys_module: &Path) -> bool {
    sys_module.is_dir() || proc_version.is_file()
}

/// Coerce an `Option<String>` env capture to `Some(non-empty)` / `None`, treating
/// a present-but-empty value as absent. Used for the *session-signal* variables
/// (`XDG_SESSION_TYPE`, `WAYLAND_DISPLAY`, `DISPLAY`) where an empty string
/// carries no signal. The user-override variables are intentionally NOT routed
/// through this — an empty value there still counts as "user supplied".
fn non_empty(opt: &Option<String>) -> Option<&str> {
    opt.as_deref().filter(|s| !s.is_empty())
}

/// The display session class, derived only from environment signals (never from
/// compositor process names, desktop variables, or resolution).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Session {
    Wayland,
    X11,
    /// A session type we explicitly do not target (e.g. `XDG_SESSION_TYPE=tty`).
    Other,
    /// No usable session signal at all.
    Unknown,
}

/// Classify the session. `XDG_SESSION_TYPE` is the primary signal; when it is
/// absent or empty we fall back to `WAYLAND_DISPLAY` (Wayland) then `DISPLAY`
/// (X11). A Wayland session is never classified as X11 merely because `DISPLAY`
/// is also present (XWayland sets it).
fn classify_session(inputs: &CompatInputs) -> Session {
    match non_empty(&inputs.xdg_session_type) {
        Some("wayland") => Session::Wayland,
        Some("x11") => Session::X11,
        Some(_) => Session::Other,
        None => {
            if non_empty(&inputs.wayland_display).is_some() {
                Session::Wayland
            } else if non_empty(&inputs.display).is_some() {
                Session::X11
            } else {
                Session::Unknown
            }
        }
    }
}

/// Inputs to the workaround decision, abstracted away from the live process
/// environment + filesystem so the decision is unit-testable without NVIDIA
/// hardware, an X server, or a Wayland compositor.
#[derive(Clone, Debug)]
struct CompatInputs {
    /// `XDG_SESSION_TYPE` env value (primary session signal).
    xdg_session_type: Option<String>,
    /// `WAYLAND_DISPLAY` env value. Non-empty ⇒ Wayland session signal.
    wayland_display: Option<String>,
    /// `DISPLAY` env value. Non-empty with no Wayland signal ⇒ X11 fallback.
    display: Option<String>,
    /// `__NV_DISABLE_EXPLICIT_SYNC` env value, if the user supplied one.
    nv_disable_explicit_sync: Option<String>,
    /// `WEBKIT_DISABLE_DMABUF_RENDERER` env value, if the user supplied one.
    webkit_disable_dmabuf_renderer: Option<String>,
    /// NVIDIA kernel module / procfs signal.
    nvidia_loaded: bool,
}

/// The concrete compatibility actions to apply for a given `CompatInputs`.
/// At most one of these is selected for any normal session (Wayland selects the
/// explicit-sync path, X11 selects the DMA-BUF-renderer path).
#[derive(Debug, Default, PartialEq, Eq)]
struct CompatActions {
    disable_nvidia_explicit_sync: bool,
    disable_webkit_dmabuf_renderer: bool,
}

/// Select the compatibility actions for the given inputs.
///
/// - No NVIDIA driver ⇒ nothing (AMD/Intel/unknown GPUs are untouched).
/// - Wayland + NVIDIA + `__NV_DISABLE_EXPLICIT_SYNC` unset ⇒ explicit-sync path.
/// - X11 + NVIDIA + `WEBKIT_DISABLE_DMABUF_RENDERER` unset ⇒ DMA-BUF-renderer path.
/// - `Other`/`Unknown` sessions ⇒ nothing.
/// - Any user-supplied value (incl. `"0"`, `"1"`, arbitrary, or empty) ⇒ preserved
///   (the matching action is suppressed).
fn select_actions(inputs: &CompatInputs) -> CompatActions {
    let mut actions = CompatActions::default();
    if !inputs.nvidia_loaded {
        return actions;
    }
    match classify_session(inputs) {
        Session::Wayland => {
            if inputs.nv_disable_explicit_sync.is_none() {
                actions.disable_nvidia_explicit_sync = true;
            }
        }
        Session::X11 => {
            if inputs.webkit_disable_dmabuf_renderer.is_none() {
                actions.disable_webkit_dmabuf_renderer = true;
            }
        }
        Session::Other | Session::Unknown => {}
    }
    actions
}

/// Gather the real process environment + kernel state into `CompatInputs`.
fn read_inputs() -> CompatInputs {
    CompatInputs {
        xdg_session_type: std::env::var("XDG_SESSION_TYPE").ok(),
        wayland_display: std::env::var("WAYLAND_DISPLAY").ok(),
        display: std::env::var("DISPLAY").ok(),
        nv_disable_explicit_sync: std::env::var(NV_EXPLICIT_SYNC_VAR).ok(),
        webkit_disable_dmabuf_renderer: std::env::var(WEBKIT_DMABUF_VAR).ok(),
        nvidia_loaded: nvidia_driver_present(
            Path::new("/proc/driver/nvidia/version"),
            Path::new("/sys/module/nvidia"),
        ),
    }
}

/// Apply the Linux graphics-compatibility workarounds.
///
/// MUST be called at the very start of `main()`, before Tauri/GTK/WebKitGTK/EGL
/// initialize, so `__NV_DISABLE_EXPLICIT_SYNC` is visible to EGL-Wayland when it
/// first creates a surface and `WEBKIT_DISABLE_DMABUF_RENDERER` is visible to
/// WebKitGTK before it picks its renderer. Calling it from `main()` is early
/// enough because all EGL/Wayland surface creation and WebKitGTK renderer
/// selection happens later, during Tauri window/webview setup (inside
/// `tauri::Builder::run`) — nothing touches EGL or the renderer before `main()`
/// runs.
///
/// `std::env::set_var` is safe here because this runs on the single main thread
/// at process startup, before any other thread or library reads the
/// environment. User-provided values are never overwritten.
pub fn configure() {
    let actions = select_actions(&read_inputs());
    if actions.disable_nvidia_explicit_sync {
        std::env::set_var(NV_EXPLICIT_SYNC_VAR, "1");
    }
    if actions.disable_webkit_dmabuf_renderer {
        std::env::set_var(WEBKIT_DMABUF_VAR, "1");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // Test input builder: every signal is explicit so each case documents exactly
    // which environment it represents. Fields: (xdg, wayland, display, nv_sync,
    // webkit_dmabuf, nvidia_loaded).
    fn compat(
        xdg: Option<&str>,
        wayland: Option<&str>,
        display: Option<&str>,
        nv_sync: Option<&str>,
        webkit: Option<&str>,
        nvidia: bool,
    ) -> CompatInputs {
        CompatInputs {
            xdg_session_type: xdg.map(String::from),
            wayland_display: wayland.map(String::from),
            display: display.map(String::from),
            nv_disable_explicit_sync: nv_sync.map(String::from),
            webkit_disable_dmabuf_renderer: webkit.map(String::from),
            nvidia_loaded: nvidia,
        }
    }

    fn actions_wayland_only() -> CompatActions {
        CompatActions {
            disable_nvidia_explicit_sync: true,
            disable_webkit_dmabuf_renderer: false,
        }
    }

    fn actions_x11_only() -> CompatActions {
        CompatActions {
            disable_nvidia_explicit_sync: false,
            disable_webkit_dmabuf_renderer: true,
        }
    }

    fn actions_none() -> CompatActions {
        CompatActions::default()
    }

    // #1 NVIDIA Wayland with unset variables selects only the explicit-sync path.
    #[test]
    fn nvidia_wayland_unset_selects_explicit_sync_only() {
        assert_eq!(
            select_actions(&compat(
                Some("wayland"),
                Some("wayland-0"),
                None,
                None,
                None,
                true
            )),
            actions_wayland_only()
        );
    }

    // #2 NVIDIA X11 with unset variables selects only the DMA-BUF-renderer path.
    #[test]
    fn nvidia_x11_unset_selects_dmabuf_only() {
        assert_eq!(
            select_actions(&compat(Some("x11"), None, Some(":0"), None, None, true)),
            actions_x11_only()
        );
    }

    // #3 Wayland with both WAYLAND_DISPLAY and DISPLAY stays Wayland.
    #[test]
    fn wayland_with_display_stays_wayland() {
        assert_eq!(
            classify_session(&compat(
                Some("wayland"),
                Some("wayland-0"),
                Some(":0"),
                None,
                None,
                true
            )),
            Session::Wayland
        );
        // And the action set is the Wayland-only one (X11 DMA-BUF not selected).
        assert_eq!(
            select_actions(&compat(
                Some("wayland"),
                Some("wayland-0"),
                Some(":0"),
                None,
                None,
                true
            )),
            actions_wayland_only()
        );
    }

    // #4 XDG_SESSION_TYPE=x11 is classified as X11.
    #[test]
    fn xdg_session_type_x11_is_x11() {
        assert_eq!(
            classify_session(&compat(Some("x11"), None, Some(":0"), None, None, false)),
            Session::X11
        );
    }

    // #5 X11 fallback: XDG_SESSION_TYPE missing, DISPLAY set, no WAYLAND_DISPLAY.
    #[test]
    fn x11_fallback_when_xdg_missing() {
        assert_eq!(
            classify_session(&compat(None, None, Some(":0"), None, None, false)),
            Session::X11
        );
        // Fallback path also drives the action under NVIDIA.
        assert_eq!(
            select_actions(&compat(None, None, Some(":0"), None, None, true)),
            actions_x11_only()
        );
    }

    // #6 Missing session variables ⇒ Unknown, and no workaround even with NVIDIA.
    #[test]
    fn missing_session_vars_unknown_and_no_action() {
        assert_eq!(
            classify_session(&compat(None, None, None, None, None, false)),
            Session::Unknown
        );
        assert_eq!(
            select_actions(&compat(None, None, None, None, None, true)),
            actions_none()
        );
    }

    // #7 AMD/Intel-equivalent input (no NVIDIA driver) ⇒ no workaround on either
    //    session type.
    #[test]
    fn non_nvidia_no_workaround() {
        assert_eq!(
            select_actions(&compat(
                Some("wayland"),
                Some("wayland-0"),
                None,
                None,
                None,
                false
            )),
            actions_none()
        );
        assert_eq!(
            select_actions(&compat(Some("x11"), None, Some(":0"), None, None, false)),
            actions_none()
        );
    }

    // #8 User value WEBKIT_DISABLE_DMABUF_RENDERER=0 is preserved.
    #[test]
    fn dmabuf_user_zero_preserved() {
        assert_eq!(
            select_actions(&compat(
                Some("x11"),
                None,
                Some(":0"),
                None,
                Some("0"),
                true
            )),
            actions_none()
        );
    }

    // #9 User value WEBKIT_DISABLE_DMABUF_RENDERER=1 is preserved.
    #[test]
    fn dmabuf_user_one_preserved() {
        assert_eq!(
            select_actions(&compat(
                Some("x11"),
                None,
                Some(":0"),
                None,
                Some("1"),
                true
            )),
            actions_none()
        );
    }

    // #10 Arbitrary user value for the DMA-BUF variable is preserved.
    #[test]
    fn dmabuf_arbitrary_user_value_preserved() {
        assert_eq!(
            select_actions(&compat(
                Some("x11"),
                None,
                Some(":0"),
                None,
                Some("custom"),
                true
            )),
            actions_none()
        );
    }

    // #11 Existing __NV_DISABLE_EXPLICIT_SYNC override behavior still works
    //     (Wayland + NVIDIA + user value ⇒ explicit-sync action suppressed).
    #[test]
    fn explicit_sync_user_override_preserved() {
        assert_eq!(
            select_actions(&compat(
                Some("wayland"),
                Some("wayland-0"),
                None,
                Some("0"),
                None,
                true
            )),
            actions_none()
        );
        assert_eq!(
            select_actions(&compat(
                Some("wayland"),
                Some("wayland-0"),
                None,
                Some("1"),
                None,
                true
            )),
            actions_none()
        );
    }

    // #12 X11 does not select the Wayland explicit-sync workaround.
    #[test]
    fn x11_never_selects_explicit_sync() {
        let actions = select_actions(&compat(Some("x11"), None, Some(":0"), None, None, true));
        assert!(!actions.disable_nvidia_explicit_sync);
        assert!(actions.disable_webkit_dmabuf_renderer);
    }

    // #13 Wayland does not select the X11 DMA-BUF workaround.
    #[test]
    fn wayland_never_selects_dmabuf() {
        let actions = select_actions(&compat(
            Some("wayland"),
            Some("wayland-0"),
            None,
            None,
            None,
            true,
        ));
        assert!(actions.disable_nvidia_explicit_sync);
        assert!(!actions.disable_webkit_dmabuf_renderer);
    }

    // #14 Empty environment strings are handled deliberately:
    //     - empty XDG_SESSION_TYPE ⇒ treated as absent (fallback path);
    //     - empty WAYLAND_DISPLAY ⇒ not Wayland;
    //     - empty user-override values ⇒ preserved (not overwritten).
    #[test]
    fn empty_strings_handled_deliberately() {
        // Empty XDG + no other signal ⇒ Unknown.
        assert_eq!(
            classify_session(&compat(Some(""), None, None, None, None, false)),
            Session::Unknown
        );
        // Empty WAYLAND_DISPLAY with DISPLAY set ⇒ X11 fallback (not Wayland).
        assert_eq!(
            classify_session(&compat(None, Some(""), Some(":0"), None, None, false)),
            Session::X11
        );
        // Empty user DMA-BUF value on NVIDIA X11 ⇒ preserved (no action).
        assert_eq!(
            select_actions(&compat(Some("x11"), None, Some(":0"), None, Some(""), true)),
            actions_none()
        );
        // Empty user explicit-sync value on NVIDIA Wayland ⇒ preserved (no action).
        assert_eq!(
            select_actions(&compat(
                Some("wayland"),
                Some("wayland-0"),
                None,
                Some(""),
                None,
                true
            )),
            actions_none()
        );
    }

    // tty session type ⇒ Other, no workaround even with NVIDIA.
    #[test]
    fn tty_session_is_other_and_untargeted() {
        assert_eq!(
            classify_session(&compat(Some("tty"), None, None, None, None, false)),
            Session::Other
        );
        assert_eq!(
            select_actions(&compat(Some("tty"), None, None, None, None, true)),
            actions_none()
        );
    }

    // #15 NVIDIA filesystem detection probes remain valid. The pure decision
    //     against `nvidia_loaded` is covered by #1/#7 above; these exercise the
    //     path probes themselves against stable filesystem objects (no NVIDIA
    //     hardware / no root required).
    #[test]
    fn nvidia_driver_present_false_for_missing_paths() {
        assert!(!nvidia_driver_present(
            Path::new("/proc/driver/nvidia/does-not-exist-version"),
            Path::new("/sys/module/definitely-not-nvidia"),
        ));
    }

    #[test]
    fn nvidia_driver_present_via_proc_file_signal() {
        // /proc/self/status always exists as a regular file → procfs branch.
        assert!(nvidia_driver_present(
            Path::new("/proc/self/status"),
            Path::new("/sys/module/definitely-not-nvidia"),
        ));
    }

    #[test]
    fn nvidia_driver_present_via_sys_dir_signal() {
        // /sys/module always exists as a directory on Linux → sysfs branch.
        assert!(nvidia_driver_present(
            Path::new("/proc/driver/nvidia/does-not-exist-version"),
            Path::new("/sys/module"),
        ));
    }
}
