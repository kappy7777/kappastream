mod decapi;
mod env_spawn;
mod export;
mod opener;
mod player;
mod resolve;
mod tray;

#[cfg(target_os = "linux")]
pub mod compat;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(decapi::DecApiClient::new().expect("failed to build DecAPI HTTP client"))
        .plugin(tauri_plugin_notification::init())
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
            export::save_favorites_export,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
