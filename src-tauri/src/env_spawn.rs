use std::process::Command;

// Windows process-creation flags. Used by hide_console()/detach() below;
// defined here (not imported from the winapi) so the flag names live next to
// the only code that sets them. Mirrors the SDK constants in winbase.h.
#[cfg(target_os = "windows")]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;
#[cfg(target_os = "windows")]
const DETACHED_PROCESS: u32 = 0x0000_0008;
#[cfg(target_os = "windows")]
const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;

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
    // Desktop-session identity + X authorization. xdg-open hands the URL
    // to the session's browser, which needs XAUTHORITY to connect to the
    // X server and the session vars to find its running instance (KDE's
    // browser wrappers key off KDE_FULL_SESSION). The AppRun hooks rewrite
    // XDG_DATA_DIRS / GTK_* / GST_* themselves — those stay excluded so
    // bundled-library pollution is still scrubbed.
    "XAUTHORITY",
    "XDG_CURRENT_DESKTOP",
    "XDG_SESSION_TYPE",
    "DESKTOP_SESSION",
    "KDE_FULL_SESSION",
    "KDE_SESSION_VERSION",
];

/// True when the app was launched from a Type-2 AppImage (the runtime
/// sets `APPIMAGE` for the main process, which we inherit). Two consumers:
/// the env-clearing whitelist below exists ONLY to counteract AppImage env
/// pollution, so it is applied exclusively in that case; and `compat.rs`
/// gates its AppImage `GDK_BACKEND` selection on the same signal so the two
/// can never disagree about what an AppImage run is.
pub(crate) fn in_appimage() -> bool {
    std::env::var("APPIMAGE").is_ok()
}

/// Filter an XDG-style colon-separated search path for forwarding out of an
/// AppImage: drop every entry that lives inside $APPDIR. The runtime's
/// apprun-hooks prepend the bundled `usr/` tree to XDG_DATA_DIRS /
/// XDG_CONFIG_DIRS, and forwarding those entries would re-introduce the
/// bundled-library pollution the whitelist exists to scrub — but dropping the
/// variables entirely hides the SYSTEM (and Flatpak-export) share dirs
/// xdg-open/gio need to find the default browser's desktop file. Returns
/// None when nothing survives: an empty search path must not shadow the
/// subsystem's compiled-in defaults, so the variable is omitted entirely.
pub(crate) fn filter_appimage_path(value: &str, appdir: Option<&str>) -> Option<String> {
    // No APPDIR: nothing identifiable to scrub, forward verbatim.
    let Some(dir) = appdir else {
        return Some(value.to_string());
    };
    let inside = |entry: &str| entry == dir || entry.starts_with(&format!("{dir}/"));
    let kept: Vec<&str> = value
        .split(':')
        .filter(|e| !e.is_empty() && !inside(e))
        .collect();
    if kept.is_empty() {
        None
    } else {
        Some(kept.join(":"))
    }
}

/// Configure the environment of a spawned subprocess.
///
/// Under an AppImage the runtime pollutes the env with bundled-library
/// paths (LD_LIBRARY_PATH, …) that break system subprocesses, so we
/// clear everything and forward only the safe whitelist above. The
/// whitelist carries the display + session vars (XAUTHORITY,
/// XDG_CURRENT_DESKTOP, …) so a browser launched by `xdg-open` can
/// connect to the display even under the scrub — without them it never
/// starts unless it was already running (then the URL is forwarded over
/// IPC and the running browser's own env is what matters).
///
/// In a native build (e.g. the AUR package) there is no such pollution,
/// so we inherit the parent env wholesale.
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
    // Data/config locations and $BROWSER: on Flatpak-browser systems
    // (Bazzite, Steam Deck, Silverblue, …) the default browser's desktop
    // file lives in a Flatpak export dir that only appears in these vars —
    // scrubbing them left link-opening dead. The *_HOME pair and BROWSER
    // cannot carry AppImage paths and pass through verbatim; the *_DIRS
    // pair is filtered of the AppImage's own entries instead.
    for k in ["XDG_DATA_HOME", "XDG_CONFIG_HOME", "BROWSER"] {
        if let Ok(v) = std::env::var(k) {
            cmd.env(k, v);
        }
    }
    let appdir = std::env::var("APPDIR").ok();
    for k in ["XDG_DATA_DIRS", "XDG_CONFIG_DIRS"] {
        if let Ok(v) = std::env::var(k) {
            if let Some(filtered) = filter_appimage_path(&v, appdir.as_deref()) {
                cmd.env(k, filtered);
            }
        }
    }
}

/// Suppress the console window a Windows GUI app would otherwise pop up for a
/// spawned console subprocess (streamlink, mpv, an opener). No-op on Unix,
/// where there is no per-process console window. Use for short-lived /
/// controlled children (resolve, the mpv probe, the URL opener).
pub fn hide_console(cmd: &mut Command) {
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    // No-op on non-Windows (no per-process console window to suppress).
    #[cfg(not(target_os = "windows"))]
    let _ = cmd;
}

/// Fully detach a subprocess so it survives the parent independently (the
/// external-player / streamlink handoff in player.rs). On Unix this is already
/// the behaviour of dropping a non-`kill_on_drop` child handle (reparented to
/// init), so this is a no-op there. On Windows:
///   - DETACHED_PROCESS: the child inherits no console, so no window appears.
///   - CREATE_NEW_PROCESS_GROUP: the child gets its own group, so a Ctrl-C /
///     Ctrl-Break in the (GUI) parent never reaches it.
///   - the child survives the parent by default (no Job Object is attached),
///     and player.rs intentionally does NOT set `kill_on_drop`, mirroring the
///     Unix "drop the handle -> it keeps running" contract.
pub fn detach(cmd: &mut Command) {
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP);
    }
    // No-op on non-Windows (dropping the child handle already reparents it).
    #[cfg(not(target_os = "windows"))]
    let _ = cmd;
}

#[cfg(test)]
mod tests {
    use super::{filter_appimage_path, SAFE_ENV_VARS};

    #[test]
    fn safe_env_vars_carry_session_identity_but_not_appimage_pollution() {
        for var in [
            "XAUTHORITY",
            "XDG_CURRENT_DESKTOP",
            "XDG_SESSION_TYPE",
            "DESKTOP_SESSION",
            "KDE_FULL_SESSION",
            "KDE_SESSION_VERSION",
        ] {
            assert!(SAFE_ENV_VARS.contains(&var), "{var} missing from whitelist");
        }
        // The AppImage runtime's apprun-hooks rewrite these; forwarding the
        // rewritten values VERBATIM into children would re-introduce the
        // bundled-library pollution the whitelist exists to scrub. The XDG
        // *_DIRS pair is instead forwarded through filter_appimage_path,
        // which strips the AppImage's own entries — it stays out of the
        // verbatim whitelist.
        for var in [
            "XDG_DATA_DIRS",
            "LD_LIBRARY_PATH",
            "GTK_PATH",
            "GTK_EXE_PREFIX",
            "GIO_MODULE_DIR",
            "GST_PLUGIN_SYSTEM_PATH",
            "GST_PLUGIN_PATH",
        ] {
            assert!(!SAFE_ENV_VARS.contains(&var), "{var} must stay excluded");
        }
    }

    #[test]
    fn filter_appimage_path_removes_only_entries_under_the_mount() {
        let appdir = "/tmp/.mount_Kappa1234";
        // System + Flatpak-export entries survive untouched, in order.
        assert_eq!(
            filter_appimage_path(
                "/usr/local/share:/usr/share:/var/lib/flatpak/exports/share",
                Some(appdir)
            )
            .as_deref(),
            Some("/usr/local/share:/usr/share:/var/lib/flatpak/exports/share")
        );
        // The runtime's prepended entries (inside the mount) are stripped;
        // a sibling path sharing the prefix text is NOT (boundary '/').
        assert_eq!(
            filter_appimage_path(
                &format!("{appdir}/usr/share:/usr/share:{appdir}x/share:{appdir}"),
                Some(appdir)
            )
            .as_deref(),
            Some("/usr/share:/tmp/.mount_Kappa1234x/share")
        );
        // Empty segments never survive either.
        assert_eq!(
            filter_appimage_path("::/usr/share:", Some(appdir)).as_deref(),
            Some("/usr/share")
        );
    }

    #[test]
    fn filter_appimage_path_drops_the_variable_when_nothing_survives() {
        let appdir = "/tmp/.mount_Kappa1234";
        assert_eq!(filter_appimage_path(appdir, Some(appdir)), None);
        assert_eq!(
            filter_appimage_path(
                &format!("{appdir}/usr/share:{appdir}/etc/xdg"),
                Some(appdir)
            ),
            None
        );
        assert_eq!(filter_appimage_path("", Some(appdir)), None);
        assert_eq!(filter_appimage_path("::", Some(appdir)), None);
    }

    #[test]
    fn filter_appimage_path_without_appdir_passes_through_verbatim() {
        // No APPDIR (native run, or a hypothetical env without it): nothing
        // to scrub, the search path forwards as-is.
        assert_eq!(
            filter_appimage_path("/usr/share:/etc/xdg", None).as_deref(),
            Some("/usr/share:/etc/xdg")
        );
    }
}
