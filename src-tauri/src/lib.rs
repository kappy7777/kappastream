mod decapi;
mod env_spawn;
mod export;
mod gql;
mod opener;
mod player;
mod resolve;
mod tray;

#[cfg(target_os = "linux")]
pub mod compat;

// Used for the single-instance callback's `app.get_webview_window(...)`.
#[cfg(desktop)]
use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let mut builder = tauri::Builder::default()
        .manage(decapi::DecApiClient::new().expect("failed to build DecAPI HTTP client"))
        .manage(gql::GqlClient::new().expect("failed to build GQL HTTP client"))
        .plugin(tauri_plugin_notification::init());

    // Single-instance guard: a second launch (e.g. the user clicks the
    // dock/AppImage while the window is hidden to the tray) must NOT start a
    // duplicate process — instead it surfaces + focuses the existing window
    // and the new process exits. Without this, close-to-tray + a dock click
    // leaves two processes running and two tray icons. Registered before
    // other plugins per the Tauri docs. Desktop-only: the plugin does not
    // build on mobile.
    #[cfg(desktop)]
    {
        builder = builder.plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(window) = app.get_webview_window(tray::MAIN_WINDOW) {
                let _ = window.show();
                let _ = window.set_focus();
            }
        }));
    }

    builder
        .setup(|app| {
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }
            tray::build(app.handle())?;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            resolve::resolve_stream,
            player::launch_player,
            opener::open_url_robust,
            decapi::decapi_fetch,
            gql::gql_fetch,
            export::save_favorites_export,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
