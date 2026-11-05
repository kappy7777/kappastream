use tauri::menu::{MenuBuilder, MenuItemBuilder, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Manager, Runtime};

#[cfg(target_os = "linux")]
use std::ffi::OsStr;
#[cfg(target_os = "linux")]
use std::path::PathBuf;

const TRAY_ID: &str = "main-tray";
const MENU_SHOW: &str = "show";
const MENU_HIDE: &str = "hide";
const MENU_QUIT: &str = "quit";
/// The main window label (matches the unlabeled window in tauri.conf.json,
/// whose label defaults to "main"). Shared with the single-instance plugin
/// callback in lib.rs.
pub(crate) const MAIN_WINDOW: &str = "main";

/// Where the Linux tray PNG must be written under flatpak (see `build`).
/// Pure so the decision is unit-testable.
///
/// The appindicator tray transports its icon as an absolute file path
/// over the StatusNotifierItem interface (the bundled libappindicator
/// predates the IconPixmap property), and tray-icon writes that PNG
/// under `$XDG_RUNTIME_DIR/tray-icon` by default. Inside the flatpak
/// sandbox that directory is a private tmpfs mounted over the desktop's
/// `/run/user/<uid>`: the path the app advertises resolves to nothing
/// for the desktop and the tray renders as a blank slot. The per-app
/// `$XDG_CACHE_HOME` is the one directory that exists at the same
/// absolute path inside and outside the sandbox, so a PNG written there
/// is readable by the desktop. `None` (keep the default location)
/// unless both `FLATPAK_ID` and a usable absolute cache home are set.
#[cfg(target_os = "linux")]
fn flatpak_tray_cache_dir(
    flatpak_id: Option<&OsStr>,
    cache_home: Option<&OsStr>,
) -> Option<PathBuf> {
    if flatpak_id.is_none_or(|v| v.is_empty()) {
        return None;
    }
    let cache = PathBuf::from(cache_home?);
    if !cache.is_absolute() {
        return None;
    }
    Some(cache.join("tray-icon"))
}

/// Build the system-tray icon + its context menu.
///
/// The menu (Show / Hide / Quit) is the primary interaction on every
/// platform. A left-click toggle handler is also wired, but note that on
/// Linux `TrayIconEvent` is not emitted at all (see the `TrayIconEvent`
/// docs — "Linux: Unsupported"), so on Linux the right-click context menu
/// is the only way in. This handler still helps on Windows/macOS and is a
/// no-op on Linux.
pub fn build<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<()> {
    let show = MenuItemBuilder::with_id(MENU_SHOW, "Show").build(app)?;
    let hide = MenuItemBuilder::with_id(MENU_HIDE, "Hide").build(app)?;
    let separator = PredefinedMenuItem::separator(app)?;
    let quit = MenuItemBuilder::with_id(MENU_QUIT, "Quit").build(app)?;
    let menu = MenuBuilder::new(app)
        .item(&show)
        .item(&hide)
        .item(&separator)
        .item(&quit)
        .build()?;

    let mut builder = TrayIconBuilder::with_id(TRAY_ID)
        .tooltip("kappastream")
        .menu(&menu)
        .on_menu_event(on_menu_event)
        .on_tray_icon_event(on_tray_icon_event);

    if let Some(icon) = app.default_window_icon() {
        builder = builder.icon(icon.clone());
    }

    // See `flatpak_tray_cache_dir`: under flatpak the tray PNG must land
    // where the desktop can read it, or the tray icon stays blank. Create
    // the directory here and only override on success: tray-icon runs its
    // own create_dir_all and propagates a failure as a build error, which
    // must not stop the app from starting over an icon.
    #[cfg(target_os = "linux")]
    {
        if let Some(dir) = flatpak_tray_cache_dir(
            std::env::var_os("FLATPAK_ID").as_deref(),
            std::env::var_os("XDG_CACHE_HOME").as_deref(),
        ) {
            if std::fs::create_dir_all(&dir).is_ok() {
                builder = builder.temp_dir_path(dir);
            }
        }
    }

    builder.build(app)?;
    Ok(())
}

fn on_menu_event<R: Runtime>(app: &AppHandle<R>, event: tauri::menu::MenuEvent) {
    match event.id().as_ref() {
        MENU_SHOW => {
            if let Some(window) = app.get_webview_window(MAIN_WINDOW) {
                let _ = window.show();
                let _ = window.set_focus();
            }
        }
        MENU_HIDE => {
            if let Some(window) = app.get_webview_window(MAIN_WINDOW) {
                let _ = window.hide();
            }
        }
        MENU_QUIT => app.exit(0),
        _ => {}
    }
}

fn on_tray_icon_event<R: Runtime>(tray: &tauri::tray::TrayIcon<R>, event: TrayIconEvent) {
    if let TrayIconEvent::Click {
        button,
        button_state,
        ..
    } = event
    {
        if button == MouseButton::Left && button_state == MouseButtonState::Up {
            let app = tray.app_handle();
            if let Some(window) = app.get_webview_window(MAIN_WINDOW) {
                // Toggle: hide when visible, show+focus otherwise.
                match window.is_visible() {
                    Ok(true) => {
                        let _ = window.hide();
                    }
                    _ => {
                        let _ = window.show();
                        let _ = window.set_focus();
                    }
                }
            }
        }
    }
}

#[cfg(all(test, target_os = "linux"))]
mod tests {
    use super::*;
    use std::ffi::OsStr;
    use std::path::Path;

    #[test]
    fn tray_cache_dir_needs_flatpak_id_and_absolute_cache_home() {
        // No FLATPAK_ID: keep the default location (a non-sandboxed
        // install must not change behavior), even with a cache home set,
        // which is the norm on Linux desktops.
        assert_eq!(
            flatpak_tray_cache_dir(None, Some(OsStr::new("/home/u/.cache"))),
            None
        );
        assert_eq!(
            flatpak_tray_cache_dir(Some(OsStr::new("")), Some(OsStr::new("/home/u/.cache"))),
            None
        );
        // Flatpak without a usable cache home: no override.
        assert_eq!(
            flatpak_tray_cache_dir(Some(OsStr::new("io.github.x.y")), None),
            None
        );
        assert_eq!(
            flatpak_tray_cache_dir(Some(OsStr::new("io.github.x.y")), Some(OsStr::new(""))),
            None
        );
        assert_eq!(
            flatpak_tray_cache_dir(
                Some(OsStr::new("io.github.x.y")),
                Some(OsStr::new(".cache"))
            ),
            None
        );
        // The real shape: flatpak sets both, dir gains the tray subdir.
        assert_eq!(
            flatpak_tray_cache_dir(
                Some(OsStr::new("io.github.x.y")),
                Some(OsStr::new("/home/u/.var/app/x.y/cache"))
            ),
            Some(Path::new("/home/u/.var/app/x.y/cache").join("tray-icon"))
        );
    }
}
