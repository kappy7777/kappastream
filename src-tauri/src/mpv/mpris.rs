//! MPRIS D-Bus service for desktop media controls.
//!
//! WebKitGTK's own MPRIS bridge — what hardware media keys ride on for the
//! webview — is built around a real, audio-producing media element, and the
//! native engine deliberately has none of those in the page (the stand-in
//! element approach was tried and does not register). This module puts the
//! ENGINE itself on the desktop's media controls the way native players do:
//! an `org.mpris.MediaPlayer2.kappastream` service whose Play/Pause/Stop run
//! the same internal command paths as the Tauri commands.
//!
//! Ownership of the well-known name tracks playback: it is requested while
//! anything playable is live and released otherwise, so an MPRIS entry
//! exists exactly while playback could respond. Two kinds of player feed
//! it:
//!
//! - **Engines.** Which engine answers is the AUDIO AUTHORITY — the
//!   frontend mirrors that pointer here via `mpris_set_authority`, so
//!   desktop keys follow the same target as the keyboard shortcuts (single
//!   view is always engine 0; a tile becomes the authority by being
//!   clicked). Before the frontend speaks — or when its pick has no live
//!   engine — the last engine that saw a click or a volume/mute/seek write
//!   stands in. What the desktop widgets DISPLAY (xesam:title) rides along
//!   with every load: mpv_load records the channel / VOD / clip title for
//!   the engine it loads. Cover art (mpris:artUrl) arrives separately via
//!   mpris_set_art — the avatar URL is only known once the GQL status
//!   fetch lands, not at load time — and is downloaded to the app cache so
//!   the URI is a local file (GNOME Shell ignores remote art URLs).
//! - **The webview player, inside the Flatpak only.** WebKitGTK's bridge
//!   never registers in that sandbox (it would need a desktop portal that
//!   does not exist), so the page reports its own playback via
//!   `mpris_note_page` — keyed by the calling window's label, so the PiP
//!   player is covered too — and desktop play/pause travels back as a
//!   `ks://mpris-action` event to exactly that window. Outside the Flatpak
//!   the command answers false and records nothing: the webview player
//!   keeps riding WebKitGTK's own bridge, and this service never competes
//!   with it there. The page answers at engine id 0 (the single-view
//!   slot), and a live engine 0 always wins — an engine mid-stream is
//!   never shadowed by a page note.
//!
//! Everything is best-effort: no session bus (or the bus going away
//! mid-run) just logs — the supervisor below restarts the service on a
//! capped backoff, and per-tick D-Bus failures are retried on the next
//! tick without killing the loop.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

use futures_util::StreamExt;
use serde::Serialize;
use tauri::Emitter;
use zbus::interface;
use zbus::zvariant::{ObjectPath, OwnedValue, Value};

use super::{lock_or_recover, mpv_set_paused, mpv_stop, DerivedState};

const MPRIS_NAME: &str = "org.mpris.MediaPlayer2.kappastream";
const MPRIS_PATH: &str = "/org/mpris/MediaPlayer2";
const TRACK_ID: &str = "/org/mpris/mediaplayer/kappastream/track";

/// Event a desktop play/pause request rides when the serving player is the
/// webview's (see Target::Page): the reporting window listens for it on
/// itself and routes the action through its own playback controls.
const PAGE_ACTION_EVENT: &str = "ks://mpris-action";

/// Art-cache slot for the webview player's avatar. Engine slots are
/// 0..=MAX_ENGINE_ID, so this sits past the engine range and its cache
/// files carry their own stem.
const PAGE_ART_ID: u32 = super::MAX_ENGINE_ID + 1;

/// Bounds on what a page report may carry: titles are channel or VOD
/// names (well under this), and the art URL is length-checked before it
/// is parsed.
const MAX_PAGE_TITLE_CHARS: usize = 256;
const MAX_PAGE_ART_URL_BYTES: usize = 2048;

/// Restart cadence for the supervised service loop (see ensure_started).
const MPRIS_RETRY_BASE: Duration = Duration::from_secs(2);
const MPRIS_RETRY_MAX: Duration = Duration::from_secs(60);

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

/// Cover art per engine: the avatar URL the frontend wants, the cached
/// local file URI once the download lands, and the file that engine last
/// published (kept across `wanted` changes so the next publish can remove
/// it). Best-effort — a failed download just leaves widgets on the app
/// icon.
#[derive(Default)]
struct Art {
    wanted: String,
    local: Option<String>,
    published: Option<PathBuf>,
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
/// re-send on every status refresh for free. Clearing also removes the
/// engine's published cache file — the per-URL file names must not
/// accumulate across clear/set cycles.
pub(super) fn note_art(app: &tauri::AppHandle, id: u32, url: Option<String>) -> Result<(), String> {
    let Some(url) = url else {
        let published = lock_or_recover(arts())
            .remove(&id)
            .and_then(|a| a.published);
        if let Some(path) = published {
            let _ = std::fs::remove_file(path);
        }
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
            // An avatar fetch must never hang the art task indefinitely.
            .connect_timeout(Duration::from_secs(10))
            .timeout(Duration::from_secs(20))
            .build()
            .unwrap_or_else(|_| reqwest::Client::new())
    })
}

/// 64-bit FNV-1a of the URL — enough spread to key cache file names per
/// avatar URL without pulling in a hash dependency.
fn url_hash(url: &str) -> u64 {
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for byte in url.as_bytes() {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
    }
    hash
}

/// Cache file name for an engine's avatar download: keyed by the avatar
/// URL, because desktop widgets cache art by URI — reusing one name per
/// engine republished the SAME file:// URI with new bytes and kept showing
/// the previous channel's avatar. Distinct URLs name distinct files, so
/// the publish swap (which removes the superseded file) is what a widget
/// sees.
fn art_file_name(id: u32, url: &str, ext: &str) -> String {
    let stem = if id == PAGE_ART_ID { "page" } else { "engine" };
    format!("{stem}-{id}-{:016x}.{ext}", url_hash(url))
}

/// The file a publish must remove: the previously published one, unless it
/// is the same path (a duplicate fetch for the same URL rewrites it).
fn superseded_art_to_delete(previous: Option<&Path>, new: &Path) -> Option<PathBuf> {
    previous
        .filter(|prev| prev != &new)
        .map(|prev| prev.to_path_buf())
}

/// The file a stale fetch must remove: its own write — unless that path is
/// the engine's currently published file, which no fetch may delete.
fn stale_art_to_delete(written: &Path, published: Option<&Path>) -> Option<PathBuf> {
    if published == Some(written) {
        None
    } else {
        Some(written.to_path_buf())
    }
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
    if resp
        .content_length()
        .is_some_and(|len| len > MAX_ART_BYTES as u64)
    {
        return Err("fetch: response exceeds the cap".to_string());
    }
    // Streamed cap (the gql_fetch pattern): neither a lying
    // Content-Length nor a chunked body can grow memory past the cap.
    let mut bytes = Vec::new();
    let mut stream = resp.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| format!("fetch: {e}"))?;
        if bytes.len().saturating_add(chunk.len()) > MAX_ART_BYTES {
            return Err("fetch: response exceeds the cap".to_string());
        }
        bytes.extend_from_slice(&chunk);
    }
    let ext = match url.path().rsplit('.').next() {
        Some("png") => "png",
        Some("webp") => "webp",
        _ => "jpg",
    };
    let file = dir.join(art_file_name(id, url.as_str(), ext));
    std::fs::write(&file, &bytes).map_err(|e| format!("write: {e}"))?;
    let uri =
        url::Url::from_file_path(&file).map_err(|_| "art path is not a file URL".to_string())?;
    // Publish or clean up under the arts lock so concurrent fetches for one
    // engine can never remove the file that is currently published: a
    // still-wanted fetch swaps `published` before its cleanup runs, and a
    // stale fetch only ever deletes its own write. Either way the engine
    // keeps at most one published file plus the new one in flight — the
    // cache stays bounded across unlimited channel switches.
    let cleanup: Option<PathBuf>;
    {
        let mut map = lock_or_recover(arts());
        match map.get_mut(&id) {
            Some(entry) if entry.wanted == url.as_str() => {
                cleanup = superseded_art_to_delete(entry.published.as_deref(), &file);
                entry.local = Some(uri.to_string());
                entry.published = Some(file);
            }
            // A newer note_art replaced the wanted URL while this fetch was
            // in flight: the stale download is dropped, not published.
            Some(entry) => {
                cleanup = stale_art_to_delete(&file, entry.published.as_deref());
            }
            // The entry was cleared outright mid-flight.
            None => cleanup = Some(file),
        }
    }
    if let Some(path) = cleanup {
        let _ = std::fs::remove_file(path);
    }
    Ok(())
}

/// Who answers a desktop media control right now: an mpv engine, or —
/// inside the flatpak, where the webview's own MPRIS bridge never
/// registers — the webview player of the named window.
#[derive(Clone, Debug, PartialEq, Eq)]
enum Target {
    Engine(u32),
    Page(String),
}

/// One window's webview-player report. `art` is the validated, normalized
/// avatar URL (or none) — the download itself runs through the same
/// bounded path as engine art.
struct PageNote {
    status: Status,
    title: Option<String>,
    art: Option<String>,
}

/// Page notes keyed by the reporting window's label. The label is taken
/// from the Webview server-side, so a page cannot report for another
/// window, and a destroyed window's note is dropped by the window-event
/// hook (webview teardown does not reliably run page code).
fn page_notes() -> &'static Mutex<HashMap<String, PageNote>> {
    static MAP: OnceLock<Mutex<HashMap<String, PageNote>>> = OnceLock::new();
    MAP.get_or_init(|| Mutex::new(HashMap::new()))
}

/// A page state token: playing/paused keep the window's note, stopped
/// removes it, anything else is a caller bug and rejected.
fn parse_page_state(raw: &str) -> Result<Option<Status>, String> {
    match raw {
        "playing" => Ok(Some(Status::Playing)),
        "paused" => Ok(Some(Status::Paused)),
        "stopped" => Ok(None),
        other => Err(format!("unknown page state: {other}")),
    }
}

/// Trim, strip control characters, and bound the title; empty becomes
/// None.
fn clean_page_title(raw: Option<String>) -> Option<String> {
    let raw = raw?;
    let cleaned: String = raw
        .trim()
        .chars()
        .filter(|c| !c.is_control())
        .take(MAX_PAGE_TITLE_CHARS)
        .collect();
    if cleaned.is_empty() {
        None
    } else {
        Some(cleaned)
    }
}

/// Bound and validate the art URL under the same rules as engine art
/// (the avatar CDN over https, nothing else). Anything outside the rules
/// is DROPPED, not rejected: a bad URL must not silence the reporter —
/// the note still matters without art.
fn clean_page_art(raw: Option<String>) -> Option<String> {
    let raw = raw?;
    if raw.len() > MAX_PAGE_ART_URL_BYTES {
        return None;
    }
    parse_art_url(&raw).map(|url| url.to_string())
}

/// Record (or remove) one window's note. Outside the flatpak nothing is
/// ever recorded: the webview's own MPRIS bridge serves the webview player
/// there, and this service must not compete with it. Returns whether the
/// note was taken.
fn record_page_note(
    in_flatpak: bool,
    label: &str,
    status: Option<Status>,
    title: Option<String>,
    art: Option<String>,
) -> bool {
    if !in_flatpak {
        return false;
    }
    let mut map = lock_or_recover(page_notes());
    match status {
        Some(status) => {
            map.insert(label.to_string(), PageNote { status, title, art });
        }
        None => {
            map.remove(label);
        }
    }
    true
}

/// Drop a window's note outright (window destroyed). Returns whether a
/// note existed.
fn drop_page_note(label: &str) -> bool {
    lock_or_recover(page_notes()).remove(label).is_some()
}

/// Which window's player stands in: a secondary window (the PiP player —
/// the audio authority while open) beats the main window's. Labels are
/// sorted so the pick is deterministic.
fn serving_page(notes: &HashMap<String, PageNote>) -> Option<(&str, &PageNote)> {
    let main = crate::tray::MAIN_WINDOW;
    let label = notes
        .keys()
        .filter(|label| label.as_str() != main)
        .min()
        .map(String::as_str)
        .or_else(|| notes.contains_key(main).then_some(main))?;
    notes.get(label).map(|note| (label, note))
}

/// Merge the engine states with the page notes into the one player
/// desktop controls act on. The page answers at id 0 (the single-view
/// slot): every pointer that would name engine 0 prefers a LIVE engine 0,
/// then the page — an engine mid-stream is never shadowed — and with no
/// engine alive the page alone decides whether the name is owned.
fn resolve(
    engines: &HashMap<u32, Status>,
    pages: &HashMap<String, PageNote>,
    authority: u32,
    touched: u32,
) -> Option<(Target, Status)> {
    let at_zero = |engines: &HashMap<u32, Status>, pages: &HashMap<String, PageNote>| {
        engines
            .get(&0)
            .map(|status| (Target::Engine(0), *status))
            .or_else(|| {
                serving_page(pages)
                    .map(|(label, note)| (Target::Page(label.to_string()), note.status))
            })
    };
    if let Some(status) = engines.get(&authority) {
        return Some((Target::Engine(authority), *status));
    }
    if authority == 0 {
        if let Some(hit) = at_zero(engines, pages) {
            return Some(hit);
        }
    }
    if let Some(status) = engines.get(&touched) {
        return Some((Target::Engine(touched), *status));
    }
    if touched == 0 {
        if let Some(hit) = at_zero(engines, pages) {
            return Some(hit);
        }
    }
    // Fallback: the lowest live engine id (single view first). With no
    // engine alive, the page alone decides whether the name is owned.
    match engines.keys().min() {
        Some(&id) => engines.get(&id).map(|status| (Target::Engine(id), *status)),
        None => {
            serving_page(pages).map(|(label, note)| (Target::Page(label.to_string()), note.status))
        }
    }
}

fn snapshot() -> Option<(Target, Status)> {
    // statuses first, then page notes — the one place both are held, so a
    // single lock order everywhere (statuses -> page_notes -> arts).
    let engines = lock_or_recover(statuses());
    let pages = lock_or_recover(page_notes());
    let authority = authority().load(Ordering::Relaxed);
    let touched = touched().load(Ordering::Relaxed);
    resolve(&engines, &pages, authority, touched)
}

/// Title + art for whoever is serving: engines read their own maps, the
/// page reads its serving note and the page art slot.
fn media_of(target: &Target) -> (Option<String>, Option<String>) {
    match target {
        Target::Engine(id) => (title_of(*id), art_of(*id)),
        Target::Page(label) => {
            let title = lock_or_recover(page_notes())
                .get(label)
                .and_then(|note| note.title.clone());
            (title, art_of(PAGE_ART_ID))
        }
    }
}

/// One window's webview-player report (see the module doc). Returns false
/// outside the flatpak — the caller stops reporting after that answer.
pub(super) fn note_page(
    in_flatpak: bool,
    app: &tauri::AppHandle,
    label: &str,
    state: &str,
    title: Option<String>,
    art_url: Option<String>,
) -> Result<bool, String> {
    if !in_flatpak {
        return Ok(false);
    }
    let status = parse_page_state(state)?;
    let title = clean_page_title(title);
    let art = clean_page_art(art_url);
    let playing = status.is_some();
    record_page_note(true, label, status, title, art);
    if playing {
        ensure_started(app);
    }
    sync_page_art(app);
    Ok(true)
}

/// Drop a window's note (its window was destroyed).
pub(super) fn forget_page(app: &tauri::AppHandle, label: &str) {
    drop_page_note(label);
    sync_page_art(app);
}

/// Keep the page art slot in step with whatever the serving window last
/// reported: a change re-triggers the bounded download; no serving player
/// clears the slot (and its cache file).
fn sync_page_art(app: &tauri::AppHandle) {
    let wanted =
        serving_page(&lock_or_recover(page_notes())).and_then(|(_, note)| note.art.clone());
    let current = lock_or_recover(arts())
        .get(&PAGE_ART_ID)
        .map(|art| art.wanted.clone());
    if current == wanted {
        return;
    }
    if let Err(err) = note_art(app, PAGE_ART_ID, wanted) {
        eprintln!("[mpv] mpris page art: {err}");
    }
}

/// The DesktopEntry name desktop shells resolve against the installed
/// .desktop files (the name without the `.desktop` suffix). Outside the
/// sandbox every package stages the file as `kappastream.desktop`
/// (AppImage/deb/rpm under that name; the AUR tarball installs it so);
/// the flatpak exports it under the app id
/// (`io.github.kappy7777.kappastream.desktop`), and inside that sandbox
/// `FLATPAK_ID` carries exactly that id — so the media widget finds the
/// app's icon and name instead of a missing entry.
fn desktop_entry_for(flatpak_id: Option<&str>) -> String {
    match flatpak_id {
        Some(id) if !id.is_empty() => id.to_string(),
        _ => "kappastream".to_string(),
    }
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
    fn desktop_entry(&self) -> String {
        desktop_entry_for(std::env::var("FLATPAK_ID").ok().as_deref())
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

/// The MPRIS method a desktop control invoked.
#[derive(Clone, Copy, Debug)]
enum Method {
    Play,
    Pause,
    PlayPause,
    Stop,
}

/// What the webview player can be asked to do. PlayPause and Stop are
/// resolved against the reported status HERE — the page applies a bare
/// play/pause and its apply guard makes repeats no-ops (a Stop on a live
/// stream pauses; there is no deeper stop for a browser player).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
enum PageAction {
    Play,
    Pause,
}

#[derive(Clone, Serialize)]
struct PageActionPayload {
    action: PageAction,
}

fn page_action(method: Method, status: Status) -> PageAction {
    match method {
        Method::Play => PageAction::Play,
        Method::Pause | Method::Stop => PageAction::Pause,
        Method::PlayPause if status == Status::Playing => PageAction::Pause,
        Method::PlayPause => PageAction::Play,
    }
}

struct Player {
    app: tauri::AppHandle,
}

impl Player {
    /// Route one desktop control to whoever is serving: engines run their
    /// own command paths; the webview player gets a bare play/pause event
    /// on its window (scoped to the window that reported playback).
    async fn dispatch(&self, method: Method) {
        let Some((target, status)) = snapshot() else {
            return;
        };
        match (target, method) {
            (Target::Engine(id), Method::Stop) => {
                let _ = mpv_stop(Some(id)).await;
            }
            (Target::Engine(id), Method::PlayPause) => {
                let _ = mpv_set_paused(Some(id), engine_paused_for_play_pause(status)).await;
            }
            (Target::Engine(id), Method::Play) => {
                let _ = mpv_set_paused(Some(id), false).await;
            }
            (Target::Engine(id), Method::Pause) => {
                let _ = mpv_set_paused(Some(id), true).await;
            }
            (Target::Page(label), method) => {
                let payload = PageActionPayload {
                    action: page_action(method, status),
                };
                if let Err(err) = self.app.emit_to(label.as_str(), PAGE_ACTION_EVENT, payload) {
                    eprintln!("[mpv] mpris page action: {err}");
                }
            }
        }
    }
}

/// The paused value PlayPause must SET: the opposite of the current state.
/// Passing the current state back (Paused → paused, Playing → playing) made
/// the toggle a silent no-op.
fn engine_paused_for_play_pause(status: Status) -> bool {
    status == Status::Playing
}

#[interface(name = "org.mpris.MediaPlayer2.Player")]
impl Player {
    async fn next(&self) {}
    async fn previous(&self) {}
    async fn stop(&self) {
        self.dispatch(Method::Stop).await;
    }
    async fn play(&self) {
        self.dispatch(Method::Play).await;
    }
    async fn pause(&self) {
        self.dispatch(Method::Pause).await;
    }
    async fn play_pause(&self) {
        self.dispatch(Method::PlayPause).await;
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
        metadata_for(snapshot().as_ref().map(|(target, _)| target))
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
fn metadata_with(
    track_suffix: &str,
    title: Option<String>,
    art: Option<String>,
) -> HashMap<String, OwnedValue> {
    let mut map = HashMap::with_capacity(3);
    let track = Value::ObjectPath(
        ObjectPath::try_from(format!("{TRACK_ID}/{track_suffix}"))
            .expect("engine ids and the page suffix keep the track path valid"),
    );
    map.insert(
        "mpris:trackid".to_string(),
        track.try_to_owned().expect("object path converts to owned"),
    );
    if let Some(title) = title {
        map.insert(
            "xesam:title".to_string(),
            Value::from(title)
                .try_to_owned()
                .expect("string value converts to owned"),
        );
    }
    if let Some(art) = art {
        map.insert(
            "mpris:artUrl".to_string(),
            Value::from(art)
                .try_to_owned()
                .expect("string value converts to owned"),
        );
    }
    map
}

/// Metadata for the serving target (or the empty shell when nothing is
/// live). Engines keep their per-id track ids; the webview player has its
/// own.
fn metadata_for(target: Option<&Target>) -> HashMap<String, OwnedValue> {
    match target {
        Some(Target::Engine(id)) => metadata_with(&id.to_string(), title_of(*id), art_of(*id)),
        Some(Target::Page(label)) => {
            let (title, art) = media_of(&Target::Page(label.clone()));
            metadata_with("page", title, art)
        }
        None => metadata_with("0", None, None),
    }
}

/// Start the service once per process. The spawned task SUPERVISES the
/// service loop: a connection-level failure (no session bus now, or the
/// bus going away) is retried on a capped backoff rather than left for the
/// next engine creation — engines are never removed from the registry, so
/// nothing else would restart the service and media keys would stay dead
/// until the app restarts.
pub(super) fn ensure_started(app: &tauri::AppHandle) {
    static STARTED: AtomicBool = AtomicBool::new(false);
    if STARTED.swap(true, Ordering::Relaxed) {
        return;
    }
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let mut backoff = MPRIS_RETRY_BASE;
        loop {
            match run(&app).await {
                // Unreachable today: the service loop below never exits on
                // its own — keep the arm so a future early-return can't turn
                // the supervisor into a busy loop.
                Ok(()) => break,
                Err(err) => {
                    eprintln!("[mpv] mpris service unavailable, retrying in {backoff:?}: {err}");
                    tokio::time::sleep(backoff).await;
                    backoff = next_retry_backoff(backoff);
                }
            }
        }
    });
}

/// Backoff between service restarts: 2 s doubling, capped at 60 s.
fn next_retry_backoff(prev: Duration) -> Duration {
    match prev.checked_mul(2) {
        Some(doubled) if doubled <= MPRIS_RETRY_MAX => doubled,
        _ => MPRIS_RETRY_MAX,
    }
}

/// Logs a per-tick failure at most once per distinct message. A bus that
/// stays broken must not turn the 500 ms tick into a log firehose, but a
/// genuinely new failure still gets its line. Bounded so a pathological
/// alternation of errors cannot grow it forever.
#[derive(Default)]
struct TickFailures {
    logged: Vec<String>,
}

impl TickFailures {
    fn note(&mut self, what: &str, err: impl std::fmt::Display) {
        if self.logged.len() >= 8 {
            return;
        }
        let msg = format!("[mpv] mpris {what} failed, retrying next tick: {err}");
        if self.logged.iter().any(|m| m == &msg) {
            return;
        }
        self.logged.push(msg.clone());
        eprintln!("{msg}");
    }
}

async fn emit_status_signal(conn: &zbus::connection::Connection) -> zbus::Result<()> {
    let iface = conn
        .object_server()
        .interface::<_, Player>(MPRIS_PATH)
        .await?;
    iface
        .get_mut()
        .await
        .playback_status_changed(iface.signal_emitter())
        .await?;
    Ok(())
}

async fn emit_metadata_signal(conn: &zbus::connection::Connection) -> zbus::Result<()> {
    let iface = conn
        .object_server()
        .interface::<_, Player>(MPRIS_PATH)
        .await?;
    iface
        .get_mut()
        .await
        .metadata_changed(iface.signal_emitter())
        .await?;
    Ok(())
}

async fn run(app: &tauri::AppHandle) -> zbus::Result<()> {
    let conn = zbus::connection::Builder::session()?
        .serve_at(MPRIS_PATH, Root)?
        .serve_at(MPRIS_PATH, Player { app: app.clone() })?
        .build()
        .await?;
    let mut owned = false;
    let mut announced: Option<Status> = None;
    let mut announced_meta: Option<(Target, Option<String>, Option<String>)> = None;
    let mut failures = TickFailures::default();
    loop {
        tokio::time::sleep(Duration::from_millis(500)).await;
        let snap = snapshot();
        let want_owned = snap.is_some();
        if want_owned != owned {
            // Only a connection-level error escapes this loop (the `?`s
            // above); a failed name request/release is retried on the next
            // tick with `owned` left untouched, so the state machine never
            // records an ownership it does not have.
            let attempted = if want_owned {
                conn.request_name(MPRIS_NAME).await
            } else {
                conn.release_name(MPRIS_NAME).await.map(|_| ())
            };
            match attempted {
                Ok(_) => {
                    owned = want_owned;
                    announced = None;
                    announced_meta = None;
                }
                Err(err) => failures.note(
                    if want_owned {
                        "name request"
                    } else {
                        "name release"
                    },
                    err,
                ),
            }
        }
        // The target tuple is not Copy (it carries the window label), so
        // borrow for the status read and move only for the metadata read.
        let status = snap.as_ref().map(|(_, status)| *status);
        if owned && status != announced {
            match emit_status_signal(&conn).await {
                Ok(()) => announced = status,
                Err(err) => failures.note("playback-status signal", err),
            }
        }
        // The serving player, its title, or its art changed (authority
        // moved, a load replaced the media, or the art download landed):
        // re-announce so widgets re-render.
        let meta = snap.map(|(target, _)| {
            let (title, art) = media_of(&target);
            (target, title, art)
        });
        if owned && meta != announced_meta {
            match emit_metadata_signal(&conn).await {
                Ok(()) => announced_meta = meta,
                Err(err) => failures.note("metadata signal", err),
            }
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
    fn desktop_entry_names_the_flatpak_export_or_the_bare_name() {
        // Outside the sandbox the desktop file is kappastream.desktop.
        assert_eq!(desktop_entry_for(None), "kappastream");
        assert_eq!(desktop_entry_for(Some("")), "kappastream");
        // Inside the flatpak FLATPAK_ID carries the exported desktop
        // file's name (minus .desktop): the app id.
        assert_eq!(
            desktop_entry_for(Some("io.github.kappy7777.kappastream")),
            "io.github.kappy7777.kappastream"
        );
    }

    #[test]
    fn metadata_carries_the_recorded_title() {
        cleanup(&[40, 41]);
        set_title(40, Some("somechannel".to_string()));
        set_title(41, None);
        let with = metadata_for(Some(&Target::Engine(40)));
        assert_eq!(str_of(&with, "xesam:title").as_deref(), Some("somechannel"));
        assert!(with.contains_key("mpris:trackid"));
        // No title recorded: the key is absent, not an empty string.
        let without = metadata_for(Some(&Target::Engine(41)));
        assert!(!without.contains_key("xesam:title"));
        assert!(without.contains_key("mpris:trackid"));
        cleanup(&[40, 41]);
    }

    #[test]
    fn track_ids_differ_per_engine() {
        let a = metadata_for(Some(&Target::Engine(40)));
        let b = metadata_for(Some(&Target::Engine(41)));
        let path = |m: &HashMap<String, OwnedValue>| match &**m.get("mpris:trackid").unwrap() {
            Value::ObjectPath(p) => p.to_string(),
            _ => panic!("trackid is not an object path"),
        };
        assert_ne!(path(&a), path(&b));
    }

    #[test]
    fn play_pause_pauses_a_playing_engine_and_resumes_a_paused_one() {
        assert!(engine_paused_for_play_pause(Status::Playing));
        assert!(!engine_paused_for_play_pause(Status::Paused));
    }

    #[test]
    fn snapshot_prefers_the_authority_then_touched() {
        cleanup(&[42, 43]);
        set_alive(42, Status::Playing);
        set_alive(43, Status::Playing);
        note_touched(42);
        set_authority(43);
        assert_eq!(snapshot(), Some((Target::Engine(43), Status::Playing)));
        // The authority engine went away: the touched one stands in.
        lock_or_recover(statuses()).remove(&43);
        assert_eq!(snapshot(), Some((Target::Engine(42), Status::Playing)));
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
                published: None,
            },
        );
        assert!(!metadata_for(Some(&Target::Engine(44))).contains_key("mpris:artUrl"));
        lock_or_recover(arts()).insert(
            44,
            Art {
                wanted: "https://static-cdn.jtvnw.net/x.png".to_string(),
                local: Some("file:///cache/mpris/engine-44-00000000000000ab.png".to_string()),
                published: None,
            },
        );
        let with = metadata_for(Some(&Target::Engine(44)));
        assert_eq!(
            str_of(&with, "mpris:artUrl").as_deref(),
            Some("file:///cache/mpris/engine-44-00000000000000ab.png")
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

    #[test]
    fn retry_backoff_doubles_from_2s_to_the_60s_cap() {
        assert_eq!(
            next_retry_backoff(Duration::from_secs(2)),
            Duration::from_secs(4)
        );
        assert_eq!(
            next_retry_backoff(Duration::from_secs(4)),
            Duration::from_secs(8)
        );
        assert_eq!(
            next_retry_backoff(Duration::from_secs(16)),
            Duration::from_secs(32)
        );
        // 32 s doubles past the cap — the cap wins, and holds.
        assert_eq!(
            next_retry_backoff(Duration::from_secs(32)),
            Duration::from_secs(60)
        );
        assert_eq!(
            next_retry_backoff(Duration::from_secs(60)),
            Duration::from_secs(60)
        );
    }

    #[test]
    fn per_tick_failure_logging_is_deduplicated_by_message() {
        let mut failures = TickFailures::default();
        failures.note("name request", "no bus");
        failures.note("name request", "no bus");
        failures.note("name request", "no bus");
        assert_eq!(failures.logged.len(), 1);
        failures.note("name release", "name not owned");
        assert_eq!(failures.logged.len(), 2);
        // The log stays bounded no matter how distinct the errors are.
        for i in 0..20 {
            failures.note("metadata signal", format!("err {i}"));
        }
        assert_eq!(failures.logged.len(), 8);
    }

    #[test]
    fn art_file_names_carry_the_engine_and_a_per_url_hash() {
        let a = art_file_name(7, "https://static-cdn.jtvnw.net/a.png", "png");
        let b = art_file_name(7, "https://static-cdn.jtvnw.net/b.png", "png");
        // Different avatar URLs must name different files — that is the
        // whole point of the hash (widgets cache art by URI).
        assert_ne!(a, b);
        assert!(a.starts_with("engine-7-"), "name: {a}");
        let stem = a.strip_suffix(".png").expect("keeps the extension");
        let hash = stem.rsplit('-').next().expect("hash after the engine id");
        assert_eq!(hash.len(), 16);
        assert!(
            hash.chars()
                .all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase()),
            "hash: {hash}"
        );
        // Stable for the same URL, distinct per engine.
        assert_eq!(
            a,
            art_file_name(7, "https://static-cdn.jtvnw.net/a.png", "png")
        );
        assert_ne!(
            a,
            art_file_name(8, "https://static-cdn.jtvnw.net/a.png", "png")
        );
    }

    #[test]
    fn publishing_deletes_only_a_superseded_file() {
        let new = PathBuf::from("/cache/mpris/engine-1-000000000000000a.png");
        let old = PathBuf::from("/cache/mpris/engine-1-000000000000000b.png");
        assert_eq!(superseded_art_to_delete(Some(&old), &new), Some(old));
        assert_eq!(superseded_art_to_delete(None, &new), None);
        // A duplicate fetch for the same URL names the same file: removing
        // it would delete what the first fetch just published.
        assert_eq!(superseded_art_to_delete(Some(&new), &new), None);
    }

    #[test]
    fn a_stale_fetch_cleans_up_unless_it_rewrote_the_published_file() {
        let written = PathBuf::from("/cache/mpris/engine-1-000000000000000a.png");
        let published = PathBuf::from("/cache/mpris/engine-1-000000000000000b.png");
        assert_eq!(
            stale_art_to_delete(&written, Some(&published)),
            Some(written.clone())
        );
        assert_eq!(stale_art_to_delete(&written, None), Some(written.clone()));
        // The stale URL is still the published one (a newer fetch for it is
        // in flight): never delete the published file.
        assert_eq!(stale_art_to_delete(&written, Some(&written)), None);
    }

    // ── Webview-player stand-in (flatpak) ─────────────────────────────

    /// Test labels are unique per test: the page-note map is a process-wide
    /// static and tests run in parallel.
    fn cleanup_pages(labels: &[&str]) {
        let mut pages = lock_or_recover(page_notes());
        for label in labels {
            pages.remove(*label);
        }
    }

    fn page_note_of(status: Status, title: Option<&str>) -> (String, PageNote) {
        (
            "main".to_string(),
            PageNote {
                status,
                title: title.map(str::to_string),
                art: None,
            },
        )
    }

    fn engines_of(pairs: &[(u32, Status)]) -> HashMap<u32, Status> {
        pairs.iter().copied().collect()
    }

    #[test]
    fn page_states_parse_and_unknown_states_are_rejected() {
        assert_eq!(parse_page_state("playing"), Ok(Some(Status::Playing)));
        assert_eq!(parse_page_state("paused"), Ok(Some(Status::Paused)));
        assert_eq!(parse_page_state("stopped"), Ok(None));
        // The vocabulary is exact: casing or emptiness is a caller bug.
        assert!(parse_page_state("Playing").is_err());
        assert!(parse_page_state("").is_err());
    }

    #[test]
    fn page_notes_record_nothing_outside_the_flatpak() {
        cleanup_pages(&["test-notflat"]);
        assert!(!record_page_note(
            false,
            "test-notflat",
            Some(Status::Playing),
            Some("somechannel".to_string()),
            None
        ));
        assert!(lock_or_recover(page_notes()).get("test-notflat").is_none());
        cleanup_pages(&["test-notflat"]);
    }

    #[test]
    fn a_stopped_page_note_removes_the_record() {
        cleanup_pages(&["test-stopped"]);
        assert!(record_page_note(
            true,
            "test-stopped",
            Some(Status::Playing),
            Some("somechannel".to_string()),
            None
        ));
        assert!(record_page_note(true, "test-stopped", None, None, None));
        assert!(lock_or_recover(page_notes()).get("test-stopped").is_none());
        cleanup_pages(&["test-stopped"]);
    }

    #[test]
    fn page_titles_are_trimmed_bounded_and_control_free() {
        assert_eq!(clean_page_title(None), None);
        assert_eq!(clean_page_title(Some("   ".to_string())), None);
        assert_eq!(
            clean_page_title(Some("  somechannel \n".to_string())),
            Some("somechannel".to_string())
        );
        // Control characters are stripped, not rejected.
        assert_eq!(
            clean_page_title(Some("a\u{7}b".to_string())),
            Some("ab".to_string())
        );
        // The cap truncates instead of failing.
        let long = "x".repeat(MAX_PAGE_TITLE_CHARS + 10);
        assert_eq!(
            clean_page_title(Some(long)).map(|t| t.chars().count()),
            Some(MAX_PAGE_TITLE_CHARS)
        );
    }

    #[test]
    fn page_art_urls_are_validated_and_dropped_when_out_of_rules() {
        assert_eq!(clean_page_art(None), None);
        assert_eq!(
            clean_page_art(Some(
                "https://static-cdn.jtvnw.net/jtv_user_pictures/x.png".to_string()
            )),
            Some("https://static-cdn.jtvnw.net/jtv_user_pictures/x.png".to_string())
        );
        // Off-host, not https, or oversized: dropped, never an error — a
        // rejected note would silence the whole reporter.
        assert_eq!(
            clean_page_art(Some("https://example.invalid/x.png".to_string())),
            None
        );
        assert_eq!(
            clean_page_art(Some("http://static-cdn.jtvnw.net/x.png".to_string())),
            None
        );
        let oversized = format!(
            "https://static-cdn.jtvnw.net/{}.png",
            "a".repeat(MAX_PAGE_ART_URL_BYTES)
        );
        assert_eq!(clean_page_art(Some(oversized)), None);
    }

    #[test]
    fn resolve_without_page_notes_follows_the_engine_rules() {
        let pages = HashMap::new();
        // Authority wins, then touched, then the lowest live id.
        assert_eq!(
            resolve(
                &engines_of(&[(2, Status::Playing), (1, Status::Paused)]),
                &pages,
                1,
                2
            ),
            Some((Target::Engine(1), Status::Paused))
        );
        assert_eq!(
            resolve(&engines_of(&[(2, Status::Playing)]), &pages, 9, 2),
            Some((Target::Engine(2), Status::Playing))
        );
        assert_eq!(resolve(&HashMap::new(), &pages, 0, 0), None);
    }

    #[test]
    fn the_page_answers_at_id_0_only_while_engine_0_is_idle() {
        let pages: HashMap<String, PageNote> =
            [page_note_of(Status::Playing, None)].into_iter().collect();
        // A live engine 0 shadows the page even when the pointers drift.
        assert_eq!(
            resolve(&engines_of(&[(0, Status::Paused)]), &pages, 0, 3),
            Some((Target::Engine(0), Status::Paused))
        );
        // Engine 0 idle: the page answers through the id-0 pointers.
        assert_eq!(
            resolve(&engines_of(&[(3, Status::Playing)]), &pages, 0, 0),
            Some((Target::Page("main".to_string()), Status::Playing))
        );
    }

    #[test]
    fn an_engine_authority_wins_over_a_live_page() {
        let pages: HashMap<String, PageNote> =
            [page_note_of(Status::Playing, None)].into_iter().collect();
        assert_eq!(
            resolve(&engines_of(&[(2, Status::Paused)]), &pages, 2, 0),
            Some((Target::Engine(2), Status::Paused))
        );
    }

    #[test]
    fn with_no_engine_alive_the_page_alone_decides_ownership() {
        let pages: HashMap<String, PageNote> =
            [page_note_of(Status::Playing, None)].into_iter().collect();
        assert_eq!(
            resolve(&HashMap::new(), &pages, 4, 4),
            Some((Target::Page("main".to_string()), Status::Playing))
        );
        // Engines from 1 up keep the pure-engine fallback (the lowest live
        // id serves; the page is not spliced in front of a real engine).
        assert_eq!(
            resolve(
                &engines_of(&[(1, Status::Playing), (2, Status::Paused)]),
                &pages,
                9,
                9
            ),
            Some((Target::Engine(1), Status::Playing))
        );
    }

    #[test]
    fn a_secondary_window_serves_ahead_of_the_main_window() {
        let pages: HashMap<String, PageNote> = [
            page_note_of(Status::Playing, None),
            (
                "pip".to_string(),
                PageNote {
                    status: Status::Paused,
                    title: None,
                    art: None,
                },
            ),
        ]
        .into_iter()
        .collect();
        assert_eq!(
            serving_page(&pages).map(|(label, note)| (label.to_string(), note.status)),
            Some(("pip".to_string(), Status::Paused))
        );
        assert_eq!(
            resolve(&HashMap::new(), &pages, 0, 0),
            Some((Target::Page("pip".to_string()), Status::Paused))
        );
    }

    #[test]
    fn page_actions_map_play_pause_toggle_and_stop() {
        use Method::{Pause, Play, PlayPause, Stop};
        assert_eq!(page_action(Play, Status::Paused), PageAction::Play);
        assert_eq!(page_action(Pause, Status::Playing), PageAction::Pause);
        // The toggle flips against the reported status.
        assert_eq!(page_action(PlayPause, Status::Playing), PageAction::Pause);
        assert_eq!(page_action(PlayPause, Status::Paused), PageAction::Play);
        // Stop on a browser player pauses (or is a guarded no-op paused).
        assert_eq!(page_action(Stop, Status::Playing), PageAction::Pause);
        assert_eq!(page_action(Stop, Status::Paused), PageAction::Pause);
    }

    #[test]
    fn page_action_payload_serializes_to_the_frontend_vocabulary() {
        let json = serde_json::to_string(&PageActionPayload {
            action: PageAction::Pause,
        })
        .expect("serializes");
        assert_eq!(json, r#"{"action":"pause"}"#);
    }

    #[test]
    fn page_metadata_uses_the_page_title_and_its_own_track_id() {
        cleanup_pages(&["test-pagemeta"]);
        lock_or_recover(page_notes()).insert(
            "test-pagemeta".to_string(),
            PageNote {
                status: Status::Playing,
                title: Some("somechannel".to_string()),
                art: None,
            },
        );
        let page = metadata_for(Some(&Target::Page("test-pagemeta".to_string())));
        assert_eq!(str_of(&page, "xesam:title").as_deref(), Some("somechannel"));
        let track = |m: &HashMap<String, OwnedValue>| match &**m.get("mpris:trackid").unwrap() {
            Value::ObjectPath(p) => p.to_string(),
            _ => panic!("trackid is not an object path"),
        };
        assert_ne!(
            track(&page),
            track(&metadata_for(Some(&Target::Engine(40))))
        );
        cleanup_pages(&["test-pagemeta"]);
    }

    #[test]
    fn the_page_art_slot_sits_past_the_engine_range_with_its_own_file_names() {
        let name = art_file_name(PAGE_ART_ID, "https://static-cdn.jtvnw.net/a.png", "png");
        assert!(name.starts_with("page-"), "name: {name}");
        // Engine names keep their shape.
        assert!(
            art_file_name(2, "https://static-cdn.jtvnw.net/a.png", "png").starts_with("engine-2-")
        );
    }

    #[test]
    fn forgetting_a_window_drops_only_its_page_note() {
        cleanup_pages(&["test-drop-a", "test-drop-b"]);
        record_page_note(true, "test-drop-a", Some(Status::Playing), None, None);
        record_page_note(true, "test-drop-b", Some(Status::Paused), None, None);
        assert!(drop_page_note("test-drop-a"));
        // A second drop of the same label reports nothing left.
        assert!(!drop_page_note("test-drop-a"));
        {
            let pages = lock_or_recover(page_notes());
            assert!(pages.get("test-drop-a").is_none());
            assert!(pages.get("test-drop-b").is_some());
        }
        cleanup_pages(&["test-drop-a", "test-drop-b"]);
    }
}
