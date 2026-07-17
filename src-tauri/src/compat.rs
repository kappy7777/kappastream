//! Linux graphics-compatibility setup.
//!
//! Invoked from the very top of `main()` (see `main.rs`), before `tauri::Builder`
//! and therefore before GTK, WebKitGTK, EGL or any Tauri webview initializes.
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
//! The workaround is applied only on Wayland sessions with the NVIDIA kernel
//! driver loaded, and only when the user has not already supplied a value.
//! AMD, Intel and X11 sessions are left untouched.

use std::path::Path;

const NV_EXPLICIT_SYNC_VAR: &str = "__NV_DISABLE_EXPLICIT_SYNC";

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

/// Inputs to the workaround decision, abstracted away from the live process
/// environment + filesystem so the decision is unit-testable without NVIDIA
/// hardware or a real Wayland socket.
#[derive(Clone, Debug)]
struct CompatInputs {
    /// `WAYLAND_DISPLAY` env value. `Some` + non-empty ⇒ Wayland session signal.
    wayland_display: Option<String>,
    /// `__NV_DISABLE_EXPLICIT_SYNC` env value, if the user supplied one.
    nv_disable_explicit_sync: Option<String>,
    /// NVIDIA kernel module / procfs signal.
    nvidia_loaded: bool,
}

/// Decide whether the process should set `__NV_DISABLE_EXPLICIT_SYNC=1`.
///
/// Returns `true` only when ALL hold:
///  - the session looks like Wayland (`WAYLAND_DISPLAY` present and non-empty), AND
///  - the NVIDIA kernel driver is loaded, AND
///  - the user has not already set `__NV_DISABLE_EXPLICIT_SYNC`.
///
/// A user-provided value (including `"0"`, `"1"`, or anything else) is always
/// preserved — we only ever set the variable when it is entirely absent.
fn should_disable_explicit_sync(inputs: &CompatInputs) -> bool {
    let on_wayland = inputs
        .wayland_display
        .as_deref()
        .map(|v| !v.is_empty())
        .unwrap_or(false);
    if inputs.nv_disable_explicit_sync.is_some() {
        return false;
    }
    on_wayland && inputs.nvidia_loaded
}

/// Gather the real process environment + kernel state into `CompatInputs`.
fn read_inputs() -> CompatInputs {
    CompatInputs {
        wayland_display: std::env::var("WAYLAND_DISPLAY").ok(),
        nv_disable_explicit_sync: std::env::var(NV_EXPLICIT_SYNC_VAR).ok(),
        nvidia_loaded: nvidia_driver_present(
            Path::new("/proc/driver/nvidia/version"),
            Path::new("/sys/module/nvidia"),
        ),
    }
}

/// Apply the Linux graphics-compatibility workaround.
///
/// MUST be called at the very start of `main()`, before Tauri/GTK/WebKitGTK/EGL
/// initialize, so `__NV_DISABLE_EXPLICIT_SYNC` is visible to EGL-Wayland when it
/// first creates a surface. Calling it from `main()` is early enough because all
/// EGL/Wayland surface creation happens later, during Tauri window/webview setup
/// (inside `tauri::Builder::run`) — nothing touches EGL before `main()` runs.
///
/// `std::env::set_var` is safe here because this runs on the single main thread
/// at process startup, before any other thread or library reads the
/// environment. User-provided values are never overwritten.
pub fn configure() {
    if should_disable_explicit_sync(&read_inputs()) {
        std::env::set_var(NV_EXPLICIT_SYNC_VAR, "1");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn inputs(wayland: Option<&str>, nv: Option<&str>, nvidia: bool) -> CompatInputs {
        CompatInputs {
            wayland_display: wayland.map(String::from),
            nv_disable_explicit_sync: nv.map(String::from),
            nvidia_loaded: nvidia,
        }
    }

    // #1 Wayland + NVIDIA + unset ⇒ workaround requested.
    #[test]
    fn wayland_nvidia_unset_requests_workaround() {
        assert!(should_disable_explicit_sync(&inputs(
            Some("wayland-0"),
            None,
            true
        )));
    }

    // #2 Wayland + NVIDIA + user "0" preserves "0" (no change).
    #[test]
    fn wayland_nvidia_user_zero_preserved() {
        assert!(!should_disable_explicit_sync(&inputs(
            Some("wayland-0"),
            Some("0"),
            true
        )));
    }

    // #3 Wayland + NVIDIA + user "1" preserves "1".
    #[test]
    fn wayland_nvidia_user_one_preserved() {
        assert!(!should_disable_explicit_sync(&inputs(
            Some("wayland-0"),
            Some("1"),
            true
        )));
    }

    // #4 X11 + NVIDIA ⇒ no change (WAYLAND_DISPLAY unset or empty).
    #[test]
    fn x11_nvidia_no_change() {
        assert!(!should_disable_explicit_sync(&inputs(None, None, true)));
        assert!(!should_disable_explicit_sync(&inputs(Some(""), None, true)));
    }

    // #5 Wayland + no NVIDIA ⇒ no change.
    #[test]
    fn wayland_no_nvidia_no_change() {
        assert!(!should_disable_explicit_sync(&inputs(
            Some("wayland-0"),
            None,
            false
        )));
    }

    // #6 Missing environment variables do not panic.
    #[test]
    fn missing_env_no_panic() {
        assert!(!should_disable_explicit_sync(&inputs(None, None, false)));
        assert!(!should_disable_explicit_sync(&inputs(None, None, true)));
    }

    // #7 NVIDIA detection handles the selected /proc + /sys signals. The pure
    //    decision against `nvidia_loaded` is covered by #1/#5 above; these
    //    exercise the path probes themselves against stable filesystem objects
    //    (no NVIDIA hardware / no root required).
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

    // Edge: an arbitrary user-provided value is still preserved (no overwrite).
    #[test]
    fn arbitrary_user_value_preserved() {
        assert!(!should_disable_explicit_sync(&inputs(
            Some("w"),
            Some("anything"),
            true
        )));
    }
}
