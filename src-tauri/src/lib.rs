mod env_spawn;
mod export;
mod gql;
mod opener;
mod platform;
mod player;
mod resolve;
mod tray;
mod vod_proxy;

// Embedded libmpv engine — a DEFAULT Cargo feature, LINUX-ONLY (owner
// scope decision 2026-09-18). The feature's deps are target-gated to
// Linux in Cargo.toml, so on Windows/macOS it resolves to an empty dep
// set AND this cfg keeps the module out entirely: a plain `cargo build`
// there compiles and links nothing mpv. See src/mpv/mod.rs for the
// gating rules and Linux libmpv packaging.
#[cfg(all(feature = "mpv-embed", target_os = "linux"))]
mod mpv;

// The honest availability probe for every build WITHOUT the Linux engine
// (Windows, macOS, and --no-default-features builds): it must still
// RESOLVE with an explicit reason, so the Settings row explains itself
// ("not supported on this platform") on a disabled toggle instead of
// silently hiding, and the frontend's engine selection falls back to
// hls.js. Every other mpv_* command is simply not registered in these
// builds — invokes reject cleanly (all frontend call sites catch).
#[cfg(not(all(feature = "mpv-embed", target_os = "linux")))]
mod mpv_unavailable {
    use serde::Serialize;

    #[derive(Serialize, Clone)]
    pub struct AvailabilityPayload {
        pub available: bool,
        pub reason: Option<String>,
    }

    #[tauri::command]
    pub fn mpv_available() -> AvailabilityPayload {
        AvailabilityPayload {
            available: false,
            reason: Some("not supported on this platform".to_string()),
        }
    }
}

#[cfg(target_os = "linux")]
pub mod compat;

// Used for the single-instance callback's `app.get_webview_window(...)`.
#[cfg(desktop)]
use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let mut builder = tauri::Builder::default()
        .manage(gql::GqlClient::new().expect("failed to build GQL HTTP client"))
        .plugin(tauri_plugin_notification::init());

    // Remember the main window's size / position / maximized state across
    // launches: saved to a small JSON file in the app config dir and restored
    // Rust-side at window creation, so there is no first-frame flash and no JS
    // involvement (first launch falls back to the tauri.conf.json default).
    // The flag set is deliberate: VISIBLE is excluded because close-to-tray
    // can quit the app with the window hidden — restoring that would look
    // like "the app didn't open"; FULLSCREEN is excluded because fullscreen /
    // theater state is deliberately never persisted in this app. The PiP
    // window is denylisted because pip-controller owns its rect entirely
    // (localStorage persistence + the 16:9 snap) and a second state manager
    // would race it.
    builder = builder.plugin(
        tauri_plugin_window_state::Builder::new()
            .with_denylist(&["pip"])
            .with_state_flags(
                tauri_plugin_window_state::StateFlags::SIZE
                    | tauri_plugin_window_state::StateFlags::POSITION
                    | tauri_plugin_window_state::StateFlags::MAXIMIZED
                    | tauri_plugin_window_state::StateFlags::DECORATIONS,
            )
            .build(),
    );

    // In-app self-update. Gated behind the `updater` Cargo feature (default
    // on). AUR builds compile with `--no-default-features`, so neither the
    // updater nor the process (relaunch) plugin is registered there — pacman
    // owns updates and a second self-update path must never fire. With the
    // plugins absent the JS `check()` call rejects immediately and is
    // swallowed silently by the frontend, so no AUR user ever sees a prompt.
    //
    // CSP note: the updater fetches latest.json + the signed artifacts via
    // reqwest here in Rust, NOT from the webview, so its HTTP never crosses
    // tauri.conf.json's CSP. Do NOT "fix" the absence of github.com / the
    // releases CDN from `connect-src` — that would only widen the page's
    // network surface for no benefit. (tauri.conf.json is parsed as strict
    // JSON, which is why this rationale lives here instead of in the CSP.)
    #[cfg(feature = "updater")]
    {
        builder = builder
            .plugin(tauri_plugin_updater::Builder::new().build())
            .plugin(tauri_plugin_process::init());
    }

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

    builder = vod_proxy::register(builder);

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

            // The main window is created hidden (tauri.conf.json
            // `visible: false`) so the window-state plugin's creation-time
            // restore can apply the saved geometry BEFORE the first paint —
            // a visible creation would flash the 1280x800 default and then
            // jump to the remembered size/position. Config windows are built
            // before this setup hook runs (tauri creates them, THEN calls
            // setup), so the restore has already fired by the time we show.
            #[cfg(desktop)]
            if let Some(window) = app.get_webview_window(tray::MAIN_WINDOW) {
                let _ = window.show();
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            resolve::resolve_stream,
            resolve::resolve_vod,
            resolve::resolve_clip,
            resolve::stream_qualities,
            resolve::streamlink_status,
            player::launch_player,
            platform::target_os,
            opener::open_url_robust,
            gql::gql_fetch,
            export::save_favorites_export,
            export::save_theme_export,
            // Feature-gated entries stay hidden from the default build's
            // command table entirely (the macro honours cfg on items).
            // The Linux-only cfg mirrors the mod declaration above; the
            // stub probe below covers every other build.
            #[cfg(all(feature = "mpv-embed", target_os = "linux"))]
            mpv::mpv_available,
            #[cfg(not(all(feature = "mpv-embed", target_os = "linux")))]
            mpv_unavailable::mpv_available,
            #[cfg(all(feature = "mpv-embed", target_os = "linux"))]
            mpv::mpv_load,
            #[cfg(all(feature = "mpv-embed", target_os = "linux"))]
            mpv::mpv_stop,
            #[cfg(all(feature = "mpv-embed", target_os = "linux"))]
            mpv::mpv_set_paused,
            #[cfg(all(feature = "mpv-embed", target_os = "linux"))]
            mpv::mpv_seek,
            #[cfg(all(feature = "mpv-embed", target_os = "linux"))]
            mpv::mpv_set_volume,
            #[cfg(all(feature = "mpv-embed", target_os = "linux"))]
            mpv::mpv_set_muted,
            #[cfg(all(feature = "mpv-embed", target_os = "linux"))]
            mpv::mpv_set_rect,
            #[cfg(all(feature = "mpv-embed", target_os = "linux"))]
            mpv::mpv_pointer,
            #[cfg(all(feature = "mpv-embed", target_os = "linux"))]
            mpv::mpv_set_surface_visible,
            #[cfg(all(feature = "mpv-embed", target_os = "linux"))]
            mpv::mpv_page_snapshot,
            #[cfg(all(feature = "mpv-embed", target_os = "linux"))]
            mpv::mpv_script_msg,
            #[cfg(all(feature = "mpv-embed", target_os = "linux"))]
            mpv::mpv_set_bitmap,
            #[cfg(all(feature = "mpv-embed", target_os = "linux"))]
            mpv::mpv_debug_log,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
