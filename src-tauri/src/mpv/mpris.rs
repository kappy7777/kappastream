//! MPRIS D-Bus service for the native engine (media keys on the desktop).
//!
//! WebKitGTK's own MPRIS bridge — what hardware media keys ride on for the
//! webview — is built around a real, audio-producing media element, and the
//! native engine deliberately has none of those in the page (the stand-in
//! element approach was tried and does not register). This module puts the
//! ENGINE itself on the desktop's media controls the way native players do:
//! an `org.mpris.MediaPlayer2.kappastream` service whose Play/Pause/Stop run
//! the same internal command paths as the Tauri commands.
//!
//! Ownership of the well-known name tracks native playback: it is requested
//! while any engine is playing/paused and released otherwise, so an MPRIS
//! entry exists exactly while native playback could respond — and never
//! competes with the webview's element-backed session while the hls engine
//! plays. Which engine answers is the AUDIO AUTHORITY — the frontend
//! mirrors that pointer here via `mpris_set_authority`, so desktop keys
//! follow the same target as the keyboard shortcuts (single view is always
//! engine 0; a tile becomes the authority by being clicked). Before the
//! frontend speaks — or when its pick has no live engine — the last engine
//! that saw a click, an OSD interaction, or a volume/mute/seek write
//! stands in. What the desktop widgets DISPLAY (xesam:title) rides along
//! with every load: mpv_load records the channel / VOD / clip title for
//! the engine it loads. Cover art (mpris:artUrl) arrives separately via
//! mpris_set_art — the avatar URL is only known once the GQL status
//! fetch lands, not at load time — and is downloaded to the app cache so
//! the URI is a local file (GNOME Shell ignores remote art URLs).
//!
//! Everything is best-effort: no session bus (or a D-Bus failure) just
//! logs and retries at the next engine creation.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

use zbus::interface;
use zbus::zvariant::{ObjectPath, OwnedValue, Value};

use super::{lock_or_recover, mpv_set_paused, mpv_stop, DerivedState};

const MPRIS_NAME: &str = "org.mpris.MediaPlayer2.kappastream";
const MPRIS_PATH: &str = "/org/mpris/MediaPlayer2";
const TRACK_ID: &str = "/org/mpris/mediaplayer/kappastream/track";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Status {
    Playing,
    Paused,
}

fn statuses() -> &'static Mutex<HashMap<u32, Status>> {
    static MAP: OnceLock<Mutex<HashMap<u32, Status>>> = OnceLock::new();
    MAP.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Media title per engine (the channel / VOD / clip title the frontend
/// sends with every load) — what desktop widgets display.
fn titles() -> &'static Mutex<HashMap<u32, String>> {
    static MAP: OnceLock<Mutex<HashMap<u32, String>>> = OnceLock::new();
    MAP.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Cover art per engine: the avatar URL the frontend wants plus the
/// cached local file URI once the download lands. Best-effort — a failed
/// download just leaves widgets on the app icon.
#[derive(Default)]
struct Art {
    wanted: String,
    local: Option<String>,
}

fn arts() -> &'static Mutex<HashMap<u32, Art>> {
    static MAP: OnceLock<Mutex<HashMap<u32, Art>>> = OnceLock::new();
    MAP.get_or_init(|| Mutex::new(HashMap::new()))
}

/// The engine desktop media controls act on: the AUDIO-AUTHORITY mirror
/// (see the module doc). 0 — the single-view player — is the neutral
/// default, so a frontend that never speaks targets single view.
fn authority() -> &'static AtomicU32 {
    static ID: AtomicU32 = AtomicU32::new(0);
    &ID
}

/// The engine the user is controlling (the pre-authority fallback).
fn touched() -> &'static AtomicU32 {
    static ID: AtomicU32 = AtomicU32::new(0);
    &ID
}

/// Called from the per-engine event thread wherever a state event is
/// emitted: keeps the controllable-engine map current. Idle/ended/error/
/// loading states remove the engine (nothing to control).
pub(super) fn note_state(id: u32, state: &DerivedState) {
    let mut map = lock_or_recover(statuses());
    match state.as_ref().map(|(name, _)| *name) {
        Some("playing") | Some("buffering") => {
            map.insert(id, Status::Playing);
        }
        Some("paused") => {
            map.insert(id, Status::Paused);
        }
        _ => {
            map.remove(&id);
        }
    }
}

/// Mark `id` as the engine the user is controlling.
pub(super) fn note_touched(id: u32) {
    touched().store(id, Ordering::Relaxed);
}

/// Record `id`'s current media title (None clears it).
pub(super) fn set_title(id: u32, title: Option<String>) {
    let mut map = lock_or_recover(titles());
    match title {
        Some(title) => {
            map.insert(id, title);
        }
        None => {
            map.remove(&id);
        }
    }
}

/// Mirror the audio-authority pointer into the service (see the module
/// doc). A plain store: works before the service ever started, and the
/// next snapshot reads it lazily.
pub(super) fn set_authority(id: u32) {
    authority().store(id, Ordering::Relaxed);
}

fn title_of(id: u32) -> Option<String> {
    lock_or_recover(titles()).get(&id).cloned()
}

fn art_of(id: u32) -> Option<String> {
    lock_or_recover(arts())
        .get(&id)
        .and_then(|a| a.local.clone())
}

/// Avatars come from exactly one host (Twitch's static CDN) — anything
/// else the webview hands us is not fetched.
fn is_avatar_host(host: &str) -> bool {
    host == "static-cdn.jtvnw.net"
}

fn parse_art_url(raw: &str) -> Option<url::Url> {
    crate::resolve::parse_media_url(raw, is_avatar_host)
}

/// Record + fetch cover art for `id` (None clears). An unchanged wanted
/// URL with a local file already present is a no-op, so the frontend can
/// re-send on every status refresh for free.
pub(super) fn note_art(app: &tauri::AppHandle, id: u32, url: Option<String>) -> Result<(), String> {
    let Some(url) = url else {
        lock_or_recover(arts()).remove(&id);
        return Ok(());
    };
    let parsed = parse_art_url(&url).ok_or_else(|| format!("refusing art url: {url}"))?;
    {
        let mut map = lock_or_recover(arts());
        let entry = map.entry(id).or_default();
        if entry.wanted == parsed.as_str() && entry.local.is_some() {
            return Ok(());
        }
        entry.wanted = parsed.as_str().to_string();
        entry.local = None;
    }
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        if let Err(err) = fetch_art(&app, id, &parsed).await {
            eprintln!("[mpv] mpris art: {err}");
        }
    });
    Ok(())
}

/// Defensive ceiling on what we write into the cache (avatars are a few
/// KB; anything past this is not an avatar).
const MAX_ART_BYTES: usize = 2 * 1024 * 1024;

fn http() -> &'static reqwest::Client {
    // Same browser-shaped UA posture as the GQL transport; avatars are a
    // public CDN asset, so no app-identifying string either.
    static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
    CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .user_agent(crate::gql::USER_AGENT)
            .build()
            .unwrap_or_else(|_| reqwest::Client::new())
    })
}

async fn fetch_art(app: &tauri::AppHandle, id: u32, url: &url::Url) -> Result<(), String> {
    use tauri::Manager;
    let dir = app
        .path()
        .app_cache_dir()
        .map_err(|e| format!("cache dir: {e}"))?
        .join("mpris");
    std::fs::create_dir_all(&dir).map_err(|e| format!("cache dir: {e}"))?;
    let resp = http()
        .get(url.as_str())
        .send()
        .await
        .map_err(|e| format!("fetch: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("fetch: status {}", resp.status()));
    }
    let bytes = resp.bytes().await.map_err(|e| format!("fetch: {e}"))?;
    if bytes.len() > MAX_ART_BYTES {
        return Err(format!("fetch: {} bytes exceeds the cap", bytes.len()));
    }
    // One stable name per engine: each load overwrites the previous
    // channel's avatar, so the cache never grows past five files.
    let ext = match url.path().rsplit('.').next() {
        Some("png") => "png",
        Some("webp") => "webp",
        _ => "jpg",
    };
    let file = dir.join(format!("engine-{id}.{ext}"));
    std::fs::write(&file, &bytes).map_err(|e| format!("write: {e}"))?;
    let uri =
        url::Url::from_file_path(&file).map_err(|_| "art path is not a file URL".to_string())?;
    // A newer note_art may have replaced the wanted URL while this fetch
    // was in flight; the stale download is dropped, not published.
    let mut map = lock_or_recover(arts());
    if let Some(entry) = map.get_mut(&id) {
        if entry.wanted == url.as_str() {
            entry.local = Some(uri.to_string());
        }
    }
    Ok(())
}

fn snapshot() -> Option<(u32, Status)> {
    let map = lock_or_recover(statuses());
    let authority = authority().load(Ordering::Relaxed);
    if let Some(status) = map.get(&authority) {
        return Some((authority, *status));
    }
    let touched = touched().load(Ordering::Relaxed);
    if let Some(status) = map.get(&touched) {
        return Some((touched, *status));
    }
    // Neither pointer names a live engine (tile closed / stream stopped):
    // fall back to the lowest live id — engine 0 first, i.e. single view.
    let id = *map.keys().min()?;
    map.get(&id).map(|status| (id, *status))
}

struct Root;

#[interface(name = "org.mpris.MediaPlayer2")]
impl Root {
    fn quit(&self) {}
    fn raise(&self) {}
    #[zbus(property)]
    fn can_quit(&self) -> bool {
        false
    }
    #[zbus(property)]
    fn can_raise(&self) -> bool {
        false
    }
    #[zbus(property)]
    fn full_screen(&self) -> bool {
        false
    }
    #[zbus(property)]
    fn has_track_list(&self) -> bool {
        false
    }
    #[zbus(property)]
    fn identity(&self) -> &str {
        "kappastream"
    }
    #[zbus(property)]
    fn desktop_entry(&self) -> &str {
        // The installed desktop file is kappastream.desktop everywhere
        // (AppImage/deb/rpm stage it under that name; the AUR tarball
        // installs it as kappastream.desktop too).
        "kappastream"
    }
    #[zbus(property)]
    fn supported_uri_schemes(&self) -> Vec<&str> {
        Vec::new()
    }
    #[zbus(property)]
    fn supported_mime_types(&self) -> Vec<&str> {
        Vec::new()
    }
}

struct Player;

#[interface(name = "org.mpris.MediaPlayer2.Player")]
impl Player {
    async fn next(&self) {}
    async fn previous(&self) {}
    async fn stop(&self) {
        if let Some((id, _)) = snapshot() {
            let _ = mpv_stop(Some(id)).await;
        }
    }
    async fn play(&self) {
        if let Some((id, _)) = snapshot() {
            let _ = mpv_set_paused(Some(id), false).await;
        }
    }
    async fn pause(&self) {
        if let Some((id, _)) = snapshot() {
            let _ = mpv_set_paused(Some(id), true).await;
        }
    }
    async fn play_pause(&self) {
        if let Some((id, status)) = snapshot() {
            let _ = mpv_set_paused(Some(id), status == Status::Paused).await;
        }
    }
    async fn seek(&self, _offset: i64) {}
    async fn set_position(&self, _track: ObjectPath<'_>, _position: i64) {}
    async fn open_uri(&self, _uri: &str) {}

    #[zbus(property)]
    fn playback_status(&self) -> String {
        match snapshot() {
            Some((_, Status::Paused)) => "Paused".to_string(),
            Some((_, Status::Playing)) => "Playing".to_string(),
            None => "Stopped".to_string(),
        }
    }
    #[zbus(property)]
    fn loop_status(&self) -> &str {
        "None"
    }
    #[zbus(property)]
    fn rate(&self) -> f64 {
        1.0
    }
    #[zbus(property)]
    fn shuffle(&self) -> bool {
        false
    }
    #[zbus(property)]
    fn metadata(&self) -> HashMap<String, OwnedValue> {
        metadata_map(snapshot().map(|(id, _)| id))
    }
    #[zbus(property)]
    fn volume(&self) -> f64 {
        1.0
    }
    #[zbus(property)]
    fn position(&self) -> i64 {
        0
    }
    #[zbus(property)]
    fn minimum_rate(&self) -> f64 {
        1.0
    }
    #[zbus(property)]
    fn maximum_rate(&self) -> f64 {
        1.0
    }
    #[zbus(property)]
    fn can_go_next(&self) -> bool {
        false
    }
    #[zbus(property)]
    fn can_go_previous(&self) -> bool {
        false
    }
    #[zbus(property)]
    fn can_play(&self) -> bool {
        snapshot().is_some()
    }
    #[zbus(property)]
    fn can_pause(&self) -> bool {
        snapshot().is_some()
    }
    #[zbus(property)]
    fn can_seek(&self) -> bool {
        false
    }
    #[zbus(property)]
    fn can_control(&self) -> bool {
        snapshot().is_some()
    }
}

/// The `a{sv}` the desktop widgets read: a track id plus, when the
/// frontend sent them, the channel / VOD / clip title (`xesam:title` is
/// what GNOME's and KDE's media widgets display — the same string the
/// hls engine's MediaMetadata would carry) and the cached avatar file
/// (`mpris:artUrl` — GNOME Shell only renders local files).
fn metadata_map(id: Option<u32>) -> HashMap<String, OwnedValue> {
    let id = id.unwrap_or(0);
    let mut map = HashMap::with_capacity(3);
    let track = Value::ObjectPath(
        ObjectPath::try_from(format!("{TRACK_ID}/{id}"))
            .expect("an engine id keeps the track path valid"),
    );
    map.insert(
        "mpris:trackid".to_string(),
        track.try_to_owned().expect("object path converts to owned"),
    );
    if let Some(title) = title_of(id) {
        map.insert(
            "xesam:title".to_string(),
            Value::from(title)
                .try_to_owned()
                .expect("string value converts to owned"),
        );
    }
    if let Some(art) = art_of(id) {
        map.insert(
            "mpris:artUrl".to_string(),
            Value::from(art)
                .try_to_owned()
                .expect("string value converts to owned"),
        );
    }
    map
}

/// Start the service once per process (retried at the next engine creation
/// if the session bus is unavailable now).
pub(super) fn ensure_started() {
    static STARTED: AtomicBool = AtomicBool::new(false);
    if STARTED.swap(true, Ordering::Relaxed) {
        return;
    }
    tauri::async_runtime::spawn(async {
        if let Err(err) = run().await {
            eprintln!("[mpv] mpris service unavailable: {err}");
            STARTED.store(false, Ordering::Relaxed);
        }
    });
}

async fn run() -> zbus::Result<()> {
    let conn = zbus::connection::Builder::session()?
        .serve_at(MPRIS_PATH, Root)?
        .serve_at(MPRIS_PATH, Player)?
        .build()
        .await?;
    let mut owned = false;
    let mut announced: Option<Status> = None;
    let mut announced_meta: Option<(u32, Option<String>, Option<String>)> = None;
    loop {
        tokio::time::sleep(Duration::from_millis(500)).await;
        let snap = snapshot();
        let want_owned = snap.is_some();
        if want_owned != owned {
            if want_owned {
                conn.request_name(MPRIS_NAME).await?;
            } else {
                conn.release_name(MPRIS_NAME).await?;
            }
            owned = want_owned;
            announced = None;
            announced_meta = None;
        }
        let status = snap.map(|(_, status)| status);
        if owned && status != announced {
            let iface = conn
                .object_server()
                .interface::<_, Player>(MPRIS_PATH)
                .await?;
            iface
                .get_mut()
                .await
                .playback_status_changed(iface.signal_emitter())
                .await?;
            announced = status;
        }
        // The controlling engine, its title, or its art changed (authority
        // moved, a load replaced the media, or the art download landed):
        // re-announce so widgets re-render.
        let meta = snap.map(|(id, _)| (id, title_of(id), art_of(id)));
        if owned && meta != announced_meta {
            let iface = conn
                .object_server()
                .interface::<_, Player>(MPRIS_PATH)
                .await?;
            iface
                .get_mut()
                .await
                .metadata_changed(iface.signal_emitter())
                .await?;
            announced_meta = meta;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // Engine ids outside the real registry range: the maps are
    // process-wide statics and tests run in parallel, so each test owns
    // ids nothing else touches (and cleans them out again).
    fn cleanup(ids: &[u32]) {
        let mut statuses = lock_or_recover(statuses());
        let mut titles = lock_or_recover(titles());
        let mut arts = lock_or_recover(arts());
        for id in ids {
            statuses.remove(id);
            titles.remove(id);
            arts.remove(id);
        }
    }

    fn set_alive(id: u32, status: Status) {
        lock_or_recover(statuses()).insert(id, status);
    }

    fn str_of(map: &HashMap<String, OwnedValue>, key: &str) -> Option<String> {
        match &**map.get(key)? {
            Value::Str(s) => Some(s.to_string()),
            _ => None,
        }
    }

    #[test]
    fn metadata_carries_the_recorded_title() {
        cleanup(&[40, 41]);
        set_title(40, Some("somechannel".to_string()));
        set_title(41, None);
        let with = metadata_map(Some(40));
        assert_eq!(str_of(&with, "xesam:title").as_deref(), Some("somechannel"));
        assert!(with.contains_key("mpris:trackid"));
        // No title recorded: the key is absent, not an empty string.
        let without = metadata_map(Some(41));
        assert!(!without.contains_key("xesam:title"));
        assert!(without.contains_key("mpris:trackid"));
        cleanup(&[40, 41]);
    }

    #[test]
    fn track_ids_differ_per_engine() {
        let a = metadata_map(Some(40));
        let b = metadata_map(Some(41));
        let path = |m: &HashMap<String, OwnedValue>| match &**m.get("mpris:trackid").unwrap() {
            Value::ObjectPath(p) => p.to_string(),
            _ => panic!("trackid is not an object path"),
        };
        assert_ne!(path(&a), path(&b));
    }

    #[test]
    fn snapshot_prefers_the_authority_then_touched() {
        cleanup(&[42, 43]);
        set_alive(42, Status::Playing);
        set_alive(43, Status::Playing);
        note_touched(42);
        set_authority(43);
        assert_eq!(snapshot(), Some((43, Status::Playing)));
        // The authority engine went away: the touched one stands in.
        lock_or_recover(statuses()).remove(&43);
        assert_eq!(snapshot(), Some((42, Status::Playing)));
        cleanup(&[42, 43]);
    }

    #[test]
    fn metadata_carries_art_only_once_the_download_landed() {
        cleanup(&[44]);
        // Wanted but not yet downloaded: no mpris:artUrl (widgets stay on
        // the app icon rather than a dead URL).
        lock_or_recover(arts()).insert(
            44,
            Art {
                wanted: "https://static-cdn.jtvnw.net/x.png".to_string(),
                local: None,
            },
        );
        assert!(!metadata_map(Some(44)).contains_key("mpris:artUrl"));
        lock_or_recover(arts()).insert(
            44,
            Art {
                wanted: "https://static-cdn.jtvnw.net/x.png".to_string(),
                local: Some("file:///cache/mpris/engine-44.png".to_string()),
            },
        );
        let with = metadata_map(Some(44));
        assert_eq!(
            str_of(&with, "mpris:artUrl").as_deref(),
            Some("file:///cache/mpris/engine-44.png")
        );
        cleanup(&[44]);
    }

    #[test]
    fn art_urls_are_the_avatar_cdn_over_https_only() {
        assert!(parse_art_url("https://static-cdn.jtvnw.net/jtv_user_pictures/x.png").is_some());
        // Not the avatar host, not https, or smuggling a port — refused.
        assert!(parse_art_url("https://example.invalid/x.png").is_none());
        assert!(parse_art_url("http://static-cdn.jtvnw.net/x.png").is_none());
        assert!(parse_art_url("https://static-cdn.jtvnw.net:8443/x.png").is_none());
    }
}
