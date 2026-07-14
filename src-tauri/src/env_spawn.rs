use std::process::Command;

/// Safe-to-forward env vars when running from an AppImage. Deliberately
/// excludes LD_LIBRARY_PATH, LD_PRELOAD, GTK_*, QT_*, XDG_DATA_DIRS,
/// PYTHONHOME, PYTHONPATH — anything an AppImage might pollute the parent
/// env with that would break subprocess library resolution (e.g. bash's
/// readline failing to resolve `rl_print_keybinding` because
/// libreadline.so got shadowed by an AppImage-bundled one).
pub const SAFE_ENV_VARS: &[&str] = &[
    "PATH",
    "HOME",
    "DISPLAY",
    "DBUS_SESSION_BUS_ADDRESS",
    "LANG",
    "LC_ALL",
    // Wayland session detection — both vars are needed together for
    // Wayland clients to locate the compositor's socket. WAYLAND_DISPLAY
    // names the socket; XDG_RUNTIME_DIR is where the socket lives.
    "WAYLAND_DISPLAY",
    "XDG_RUNTIME_DIR",
    // HiDPI / display scaling — legitimate desktop-session config,
    // not AppImage pollution. Without these, GTK/Qt apps launched as
    // subprocesses (Chromium, Firefox, etc.) render at 1× scale and
    // look tiny on HiDPI displays.
    "GDK_SCALE",
    "GDK_DPI_SCALE",
    "QT_SCALE_FACTOR",
    "QT_AUTO_SCREEN_SCALE_FACTOR",
];

/// True when the app was launched from a Type-2 AppImage (the runtime
/// sets `APPIMAGE` for the main process, which we inherit). The
/// env-clearing whitelist below exists ONLY to counteract AppImage env
/// pollution, so it is applied exclusively in that case.
fn in_appimage() -> bool {
    std::env::var("APPIMAGE").is_ok()
}

/// Configure the environment of a spawned subprocess.
///
/// Under an AppImage the runtime pollutes the env with bundled-library
/// paths (LD_LIBRARY_PATH, …) that break system subprocesses, so we
/// clear everything and forward only the safe whitelist above.
///
/// In a native build (e.g. the AUR package) there is no such pollution,
/// so we inherit the parent env wholesale. This is also required for
/// correctness: a browser launched by `xdg-open` needs display-auth /
/// session vars (XAUTHORITY, XDG_CURRENT_DESKTOP, …) that the whitelist
/// omits. Without them a freshly-launched browser cannot connect to the
/// display and never starts — which is why the opener only worked when
/// the browser was already running (the URL is then forwarded over IPC
/// and the running browser's own env is what matters).
pub fn configure(cmd: &mut Command, path_override: Option<&str>) {
    if !in_appimage() {
        // Native: inherit the parent env untouched. `path_override` is
        // only meaningful for AppImage (whose runtime strips PATH); the
        // inherited PATH already contains /usr/bin etc., so it's ignored.
        let _ = path_override;
        return;
    }

    cmd.env_clear();
    for &k in SAFE_ENV_VARS {
        let v = if k == "PATH" {
            if let Some(p) = path_override {
                p.to_string()
            } else {
                match std::env::var(k) {
                    Ok(v) => v,
                    Err(_) => continue,
                }
            }
        } else {
            match std::env::var(k) {
                Ok(v) => v,
                Err(_) => continue,
            }
        };
        cmd.env(k, v);
    }
}
