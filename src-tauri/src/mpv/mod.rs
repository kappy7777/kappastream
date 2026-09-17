// Experimental embedded-libmpv video engine ("video above the page").
//
// When the `mpv-embed` Cargo feature is on AND the runtime toggle is on, the
// main player renders through libmpv drawing into a native surface positioned
// ABOVE the (fully opaque) webview — input-transparent, so the HTML keeps all
// pointer handling; the in-video controls are mpv's OSD. Multi-view tiles run
// the SAME engine (one mpv core per tile, ids 1..=4 — the tile's own controls
// are the app's HTML strip below the video, and their OSD is disabled via
// ks-osc's ks-disable). The PiP window stays on hls.js (out of scope by
// design).
//
// (History: the original design drew the video UNDER the webview through a
// transparent "hole" in the page. WebKitGTK cannot render transparent
// regions correctly on this stack — its webview surface never clears between
// frames, so moving UI left stale copies and any painted content
// accumulated; verified down to a GL-free vanilla transparent window. Every
// working web-UI-over-mpv app (Stremio, iptvnator) uses Chromium, whose
// compositor handles this. Hence: no transparency anywhere.)
//
// GATING — three layers, all must hold:
//   1. This module only compiles under `#[cfg(feature = "mpv-embed")]` — a
//      DEFAULT feature (owner decision 2026-09-16): every release build
//      ships the engine and its platform packaging carries libmpv (deb/rpm
//      depends, AppImage bundling, Windows DLL resource, macOS dylib
//      closure bundled into the .app, AUR `mpv` dep). Only
//      `--no-default-features` builds exclude it (nothing ships that way).
//   2. Nothing release-affecting: the window/webview stay exactly as
//      tauri.conf.json builds them (opaque); the platform surfaces arrange
//      the native video surface at runtime.
//   3. `mpv_available()` returns true only when the feature is compiled in
//      AND the platform surface initialized; the Settings toggle is hidden
//      otherwise (the frontend also treats a missing command as false).
//
// BUILD PREREQUISITES (any build that keeps the default feature):
//   Linux:   libmpv — Arch: `pacman -S mpv`; Debian/Ubuntu: `apt install
//            libmpv-dev` (also the runtime libmpv.so.2, pulled in by it).
//            GL symbols are dlopened at runtime from libGL.so.1 /
//            libOpenGL.so.0 (GLVND; always present on a desktop, no dev
//            package needed — see src/mpv/linux.rs).
//   Windows: libmpv-2.dll + import library (see the Windows surface notes in
//            a later phase; MPV_SOURCE env for libmpv2's build script).
//   macOS:   `brew install mpv` (libmpv.dylib + headers).
//
// ARCHITECTURE
//   - A small REGISTRY of engines keyed by id: 0 is the single-stream player
//     (created lazily by the first `mpv_available` probe, so the Settings
//     toggle knows availability before anything loads), 1..=4 are multi-view
//     tile engines created on their first `mpv_load`. The `Mpv` handles are
//     deliberately LEAKED (`Box::leak` → `&'static Mpv`): libmpv2's
//     `RenderContext` borrows the `Mpv`, so storing both in one struct would
//     be self-referential, and an engine intentionally lives for the whole
//     process anyway (the bounded id set keeps the leak bounded).
//   - A dedicated event thread per engine blocks in `wait_event`, translates
//     mpv events/property changes into the `mpv://…` webview events (every
//     payload carries the engine id so the frontend routes them), and
//     throttles time updates to ~4 Hz in Rust.
//   - Platform surfaces (the native window region mpv draws into) live in
//     per-target modules behind the `VideoSurface` trait. Rects are LOGICAL
//     (GDK) pixels, already zoom-adjusted by the frontend.

use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use libmpv2::events::{Event, PropertyData};
use libmpv2::Mpv;
use serde::Serialize;
use tauri::{AppHandle, Emitter};

#[cfg(target_os = "linux")]
mod linux;
#[cfg(target_os = "linux")]
use linux as platform;

// Per-platform surfaces for the OTHER targets.
#[cfg(target_os = "windows")]
mod win32;
#[cfg(target_os = "windows")]
use win32 as platform;

#[cfg(target_os = "macos")]
mod macos;
#[cfg(target_os = "macos")]
use macos as platform;

/// The UA streamlink itself sends when resolving (its session default
/// `streamlink/<version>`) — mpv fetches the SAME resolved URLs, so it should
/// present the same way. Bump the version if it ever matters.
const MPV_USER_AGENT: &str = "streamlink/7.2.0";

/// Kappastream's in-video control OSD (replaces mpv's stock OSC). Lua,
/// drawn through the same render context as the video; data flows in via
/// script messages (mpv_script_msg) and button actions come back as
/// `ks-action` client messages (see the event thread). libmpv loads
/// scripts from files only, so the engine materializes this at init and
/// passes it via `scripts-append`.
const KS_OSC_LUA: &str = include_str!("ks-osc.lua");

/// Min interval between `mpv://time` emits (~4 Hz).
const TIME_EMIT_INTERVAL: Duration = Duration::from_millis(250);

/// The native region under the webview mpv renders into, one implementation
/// per platform. All rects in LOGICAL px, window-relative. Implementations
/// marshal to the UI thread themselves; calls are cheap and non-blocking.
pub trait VideoSurface: Send + Sync {
    fn show(&self);
    fn hide(&self);
    fn set_rect(&self, x: i32, y: i32, w: i32, h: i32);
}

struct Engine {
    mpv: &'static Mpv,
    surface: Box<dyn VideoSurface>,
    /// While a blocking webview overlay is open (Settings, About, what's
    /// new, … — anything that renders UNDER the native video window), the
    /// surface is hidden and the PlaybackRestart auto-reveal stays
    /// suspended. mpv keeps playing (audio) throughout; see
    /// mpv_set_surface_visible.
    overlay_suppressed: bool,
    /// A file is loaded and has presented at least one frame. Gates the
    /// BROADCAST re-show in mpv_set_surface_visible: re-revealing an engine
    /// the frontend stopped (mpv_stop hides + clears this) would pop a dead
    /// black box over the page.
    active: bool,
    /// OSD image overlays (info block, storyboard thumbnails, page-UI
    /// snapshots): decoded by
    /// the webview (which already has the sources cached/fetched) into BGRA and
    /// pushed via mpv_set_bitmap; ks-osc.lua drives show/hide + geometry
    /// through `ks-overlay` script messages so the OSD stays the single
    /// source of layout truth. Rendered by mpv's `overlay-add`, which rides
    /// the same OSD path vo=libmpv already draws.
    bitmaps: HashMap<String, CachedBitmap>,
    /// Bumped on every bitmap (re)upload — forces overlay re-issue so a new
    /// bitmap replaces the pixels on screen.
    bitmap_gen: u64,
    /// overlay id → (gen, content tag, x, y, w, h) last issued — collapses
    /// the 16 Hz show-message stream from the OSD's render tick.
    overlays: HashMap<u8, (u64, u64, i32, i32, u32, u32)>,
    /// Last geometry the OSD issued for the page-UI overlay. Kept so a
    /// refreshed page snapshot (mpv_page_snapshot) can re-issue overlay-add
    /// with the NEW bitmap without waiting for the next ks-page message —
    /// geometry changes are rare while a dialog is open, content changes
    /// are not.
    page_geo: Option<((i32, i32), (u32, u32))>,
    /// Sequence counter for page snapshots: allocated by the GTK main
    /// thread at snapshot time, checked by the store worker under the
    /// engine lock, so an older frame finishing late can never overwrite a
    /// newer one. Lives on the engine (not a static) so a rebuilt engine
    /// restarts the sequence cleanly.
    page_seq: u64,
}

/// A BGRA bitmap uploaded by the frontend, keyed ("infoblock", "page", or
/// "thumb:<n>").
struct CachedBitmap {
    bgra: Vec<u8>,
    w: u32,
    h: u32,
    /// Storyboard strips only: the cols × rows tile grid of the image, used
    /// to crop individual thumbnails.
    grid: Option<(u32, u32)>,
}

/// mpv overlay ids we own (client overlays are 0..63; 0 stays unused).
/// Higher ids draw above lower ones — the page-UI snapshot sits on top.
const OVERLAY_THUMB: u8 = 2;
const OVERLAY_PAGE: u8 = 3;
const OVERLAY_INFOBLOCK: u8 = 4;

static ENGINES: OnceLock<Mutex<HashMap<u32, Engine>>> = OnceLock::new();
static INIT_GUARD: Mutex<()> = Mutex::new(());

fn engines() -> &'static Mutex<HashMap<u32, Engine>> {
    ENGINES.get_or_init(|| Mutex::new(HashMap::new()))
}

// ---------------------------------------------------------------------------
// Engine bootstrap

/// libmpv refuses to create a core at all (`mpv_create` → NULL, surfacing as
/// the cryptic "mpv init failed: Null") when the LC_NUMERIC locale formats
/// numbers with a comma (de_DE, fr_FR, …) — and GTK's initialization has
/// already run `setlocale(LC_ALL, "")` with the user's desktop environment,
/// so this trips before our first line of engine code runs. The documented
/// contract (mpv/client.h: LC_NUMERIC "must be set to C"; reset it after any
/// setlocale(LC_ALL, ...)) is satisfied by pinning it back process-wide.
/// GTK and glib parse numbers with their own locale-independent `g_ascii_*`
/// helpers and nothing else in this app depends on LC_NUMERIC, so this is the
/// standard embedded-libmpv fix; mpv also requires it to STAY "C" for
/// the core's whole lifetime, hence no restore.
#[cfg(target_os = "linux")]
fn pin_c_numeric_locale() {
    // SAFETY: setlocale with a constant, always-available locale name. The
    // process-wide effect is exactly the point (see the comment above).
    unsafe { libc::setlocale(libc::LC_NUMERIC, c"C".as_ptr()) };
}

/// Get-or-create the engine for `id` (0 = single player, 1..=4 = tiles).
/// Creation failures are not cached — a platform whose surface cannot come
/// up simply keeps failing on every probe/load, which the frontend surfaces
/// as "unavailable" (single player) or a per-load fallback to hls.js (tiles).
fn ensure_engine(app: &AppHandle, id: u32) -> Result<(), String> {
    if engines()
        .lock()
        .expect("mpv engines lock poisoned")
        .contains_key(&id)
    {
        return Ok(());
    }
    // Serialize concurrent first calls (mpv_available + a first load racing).
    let _guard = INIT_GUARD.lock().expect("mpv engine init lock poisoned");
    if engines()
        .lock()
        .expect("mpv engines lock poisoned")
        .contains_key(&id)
    {
        return Ok(());
    }
    match build_engine(app, id) {
        Ok(engine) => {
            engines()
                .lock()
                .expect("mpv engines lock poisoned")
                .insert(id, engine);
            Ok(())
        }
        Err(err) => {
            // The frontend renders nothing for a false probe (the Settings
            // toggle stays hidden) — stderr is the only place the reason
            // exists, so make the failure impossible to miss.
            eprintln!("[mpv] engine {id} init failed: {err}");
            Err(err)
        }
    }
}

fn build_engine(app: &AppHandle, id: u32) -> Result<Engine, String> {
    // Before ANY libmpv call — mpv_create checks the locale immediately.
    #[cfg(target_os = "linux")]
    pin_c_numeric_locale();
    // Materialize the embedded OSD script — `scripts-append` takes a path.
    let osc_script = std::env::temp_dir()
        .join("kappastream-osc.lua")
        .to_str()
        .ok_or("temp dir path not UTF-8")?
        .to_string();
    std::fs::write(&osc_script, KS_OSC_LUA).map_err(|e| format!("write ks-osc.lua: {e}"))?;
    // Platform options that must apply at mpv-create time (Linux pins the
    // render API; the wid platforms set their window handle later instead).
    let mpv: &'static Mpv = Box::leak(Box::new(
        Mpv::with_initializer(|init| {
            #[cfg(target_os = "linux")]
            init.set_property("vo", "libmpv")?;
            // Deliberate per spec: never park on the last frame when a file
            // ends; the frontend learns 'ended' from the state event.
            init.set_property("keep-open", "no")?;
            init.set_property("audio-client-name", "kappastream")?;
            init.set_property("user-agent", MPV_USER_AGENT)?;
            // In-video controls: OUR ks-osc.lua replaces mpv's stock OSC
            // (same OSD pipeline — rendered through the same render context
            // as the video — but our layout, fed via script messages; see
            // KS_OSC_LUA). libmpv's script defaults differ from the CLI
            // player, so everything is explicit: scripts on, the STOCK osc
            // off, ytdl_hook OFF (it would run yt-dlp against every loadfile
            // URL), default key bindings OFF (all real input arrives as
            // forwarded pointer events from the webview — mpv_pointer).
            init.set_property("load-scripts", true)?;
            init.set_property("osc", false)?;
            // NOTE: the CLI's `--scripts-append` is a command-line-only
            // variant — the client API rejects the name ("option not
            // found", probed against this exact libmpv) — so the base
            // `scripts` list option carries our script instead.
            init.set_property("scripts", osc_script.as_str())?;
            init.set_property("ytdl", false)?;
            init.set_property("input-default-bindings", false)?;
            Ok(())
        })
        .map_err(|e| format!("mpv init failed: {e}"))?,
    ));

    // Property observers driving the state/time events (ids are unused; one
    // observer per property keeps the event thread's match legible).
    for (name, format) in [
        ("time-pos", libmpv2::Format::Double),
        ("duration", libmpv2::Format::Double),
        ("volume", libmpv2::Format::Double),
        ("mute", libmpv2::Format::Flag),
        ("pause", libmpv2::Format::Flag),
        ("core-idle", libmpv2::Format::Flag),
        ("paused-for-cache", libmpv2::Format::Flag),
        ("eof-reached", libmpv2::Format::Flag),
        ("idle-active", libmpv2::Format::Flag),
    ] {
        mpv.observe_property(name, format, 0)
            .map_err(|e| format!("observe {name} failed: {e}"))?;
    }

    // The surface reparents GTK widgets, so it runs its work on the UI
    // thread and reports back over a channel.
    let surface = platform::create(app, mpv, id)?;

    spawn_event_thread(app.clone(), mpv, id);

    Ok(Engine {
        mpv,
        surface,
        overlay_suppressed: false,
        active: false,
        page_geo: None,
        page_seq: 0,
        bitmaps: HashMap::new(),
        bitmap_gen: 0,
        overlays: HashMap::new(),
    })
}

// ---------------------------------------------------------------------------
// mpv state → webview events

#[derive(Serialize, Clone)]
struct StatePayload {
    id: u32,
    state: &'static str,
    error: Option<String>,
}

#[derive(Serialize, Clone)]
struct TimePayload {
    id: u32,
    position: f64,
    duration: f64,
}

#[derive(Serialize, Clone)]
struct VolumePayload {
    id: u32,
    /// 0..1 (mpv's property is a percentage, 0..130 with amplification —
    /// clamped so the OSC can't push the app past full volume).
    volume: f64,
    muted: bool,
}

/// `mpv://action` — an ks-osc button press, tagged with its engine.
#[derive(Serialize, Clone)]
struct ActionPayload {
    id: u32,
    action: String,
}

/// The derived playback state, or None when nothing is loaded (idle — never
/// emitted; it just stops the state events).
type DerivedState = Option<(&'static str, Option<String>)>;

/// Collapse the observed properties into the frontend's state vocabulary.
fn compute_state(mpv: &Mpv) -> DerivedState {
    let flag = |name: &str| mpv.get_property::<bool>(name).unwrap_or(false);
    if flag("idle-active") {
        return None;
    }
    if flag("eof-reached") {
        return Some(("ended", None));
    }
    if flag("pause") {
        return Some(("paused", None));
    }
    if flag("paused-for-cache") {
        return Some(("buffering", None));
    }
    if flag("core-idle") {
        return Some(("loading", None));
    }
    Some(("playing", None))
}

fn emit_state(id: u32, app: &AppHandle, state: DerivedState) {
    if let Some((state, error)) = state {
        let _ = app.emit("mpv://state", StatePayload { id, state, error });
    }
}

fn spawn_event_thread(app: AppHandle, mpv: &'static Mpv, id: u32) {
    std::thread::spawn(move || {
        let mut last_time_emit = Instant::now() - TIME_EMIT_INTERVAL;
        let mut duration = 0f64;
        let mut last_state: DerivedState = None;
        let mut state_dirty = true;
        loop {
            let event = mpv.wait_event(-1.0);
            let Some(event) = event else { continue };
            match event {
                Ok(Event::PropertyChange { name, change, .. }) => match (name, change) {
                    ("time-pos", PropertyData::Double(p)) => {
                        let now = Instant::now();
                        if now.duration_since(last_time_emit) >= TIME_EMIT_INTERVAL {
                            last_time_emit = now;
                            let _ = app.emit(
                                "mpv://time",
                                TimePayload {
                                    id,
                                    position: p.max(0.0),
                                    duration,
                                },
                            );
                        }
                    }
                    ("duration", PropertyData::Double(d)) => {
                        if d.is_finite() && d > 0.0 {
                            duration = d;
                        }
                    }
                    // OSC-driven volume/mute (dragging mpv's own in-video
                    // slider) mirrors back into the app. Read BOTH fresh so
                    // either property's change carries a consistent pair.
                    ("volume", _) | ("mute", _) => {
                        let vol = mpv.get_property::<f64>("volume").unwrap_or(100.0);
                        let mute = mpv.get_property::<bool>("mute").unwrap_or(false);
                        let _ = app.emit(
                            "mpv://volume",
                            VolumePayload {
                                id,
                                volume: (vol / 100.0).clamp(0.0, 1.0),
                                muted: mute,
                            },
                        );
                    }
                    // Any of the playback-shape properties may flip the
                    // derived state; recompute after this event.
                    ("pause", _)
                    | ("core-idle", _)
                    | ("paused-for-cache", _)
                    | ("eof-reached", _)
                    | ("idle-active", _) => state_dirty = true,
                    _ => {}
                },
                Ok(Event::Seek) => {
                    let _ = app.emit("mpv://seeking", id);
                    state_dirty = true;
                }
                Ok(Event::PlaybackRestart) => {
                    let _ = app.emit("mpv://seeked", id);
                    state_dirty = true;
                    // First frame presented (also fires on seeks/unpause —
                    // the surface's show path collapses repeats): reveal the
                    // native video surface. Until now it stayed hidden so
                    // the page's loading spinner / error overlays render
                    // normally instead of being covered by a black box.
                    // Suppressed while a blocking overlay owns the screen
                    // (mpv_set_surface_visible re-shows on its dismissal).
                    if let Some(engine) = engines()
                        .lock()
                        .expect("mpv engines lock poisoned")
                        .get_mut(&id)
                    {
                        engine.active = true;
                        if !engine.overlay_suppressed {
                            engine.surface.show();
                        }
                    }
                }
                Ok(Event::FileLoaded) => {
                    // `start` is a load-time option: whatever position was
                    // requested for THIS file must not leak into the next.
                    let _ = mpv.set_property("start", "none");
                    state_dirty = true;
                }
                Ok(Event::EndFile(_)) => {
                    // Normal ends surface via eof-reached/idle-active; an
                    // ERRORED end-file arrives as the Err arm below.
                    state_dirty = true;
                }
                Ok(Event::ClientMessage(args)) => {
                    // ks-osc button actions (see ks-osc.lua), relayed to the
                    // frontend, which maps them onto the existing handlers
                    // (stop/PiP/mpv/theater/fullscreen/quality:<label>).
                    if args.first().copied() == Some("ks-action") {
                        if let Some(action) = args.get(1) {
                            let _ = app.emit(
                                "mpv://action",
                                ActionPayload {
                                    id,
                                    action: action.to_string(),
                                },
                            );
                        }
                    } else if args.first().copied() == Some("ks-overlay") {
                        // ks-osc image-overlay geometry (storyboard
                        // thumbnails, the info block, the page-UI snapshot
                        // overlay): the OSD's
                        // render math is the single source of layout truth,
                        // mpv composites via overlay-add. Best-effort — a
                        // failed overlay is a visual no-op, not an error the
                        // user can act on.
                        if let Some(engine) = engines()
                            .lock()
                            .expect("mpv engines lock poisoned")
                            .get_mut(&id)
                        {
                            let _ = engine.handle_ks_overlay(&args[1..]);
                        }
                    }
                }
                Err(e) => {
                    let err = Some(format!("{e}"));
                    if last_state.as_ref().map(|(s, _)| *s) != Some("error") {
                        last_state = Some(("error", err.clone()));
                        emit_state(id, &app, Some(("error", err)));
                    }
                }
                _ => {}
            }
            if state_dirty {
                state_dirty = false;
                let state = compute_state(mpv);
                // Idle = no file: the engine is no longer an active surface
                // (a broadcast re-show must not un-hide a stopped engine).
                if state.is_none() {
                    if let Some(engine) = engines()
                        .lock()
                        .expect("mpv engines lock poisoned")
                        .get_mut(&id)
                    {
                        engine.active = false;
                    }
                }
                if state != last_state {
                    last_state = clone_state(&state);
                    emit_state(id, &app, state);
                }
            }
        }
    });
}

fn clone_state(s: &DerivedState) -> DerivedState {
    s.as_ref().map(|(name, err)| (*name, err.clone()))
}

// ---------------------------------------------------------------------------
// OSD image overlays (storyboard thumbnails + webview bitmaps)

impl Engine {
    /// `ks-overlay <thumb|page|infoblock> <show args…|hide>` — see ks-osc.lua.
    fn handle_ks_overlay(&mut self, p: &[&str]) -> Result<(), String> {
        let geti = |i: usize| -> Result<i64, String> {
            p.get(i)
                .and_then(|s| s.parse::<i64>().ok())
                .ok_or_else(|| format!("bad ks-overlay arg {i}: {p:?}"))
        };
        match (p.first().copied(), p.get(1).copied()) {
            (Some("thumb"), Some("show")) => self.show_thumb(
                geti(2)? as i32,
                geti(3)? as i32,
                geti(4)?.max(1) as u32,
                geti(5)?.max(1) as u32,
                geti(6)?.max(0) as u32,
                geti(7)?.max(0) as u32,
            ),
            (Some("thumb"), Some("hide")) => {
                self.hide_overlay(OVERLAY_THUMB);
                Ok(())
            }
            (Some("page"), Some("show")) => {
                let pos = (geti(2)? as i32, geti(3)? as i32);
                let dims = (geti(4)?.max(1) as u32, geti(5)?.max(1) as u32);
                self.page_geo = Some((pos, dims));
                let res = self.show_bitmap(OVERLAY_PAGE, "page", 0, pos, dims);
                if res.is_err() && !self.bitmaps.contains_key("page") {
                    // Expected ONCE per dialog: the geometry message races
                    // the first snapshot; the snapshot's completion re-issues
                    // from page_geo.
                    return Ok(());
                }
                res
            }
            (Some("page"), Some("hide")) => {
                self.page_geo = None;
                self.hide_overlay(OVERLAY_PAGE);
                Ok(())
            }
            (Some("infoblock"), Some("show")) => {
                let pos = (geti(2)? as i32, geti(3)? as i32);
                let dims = (geti(4)?.max(1) as u32, geti(5)?.max(1) as u32);
                self.show_bitmap(OVERLAY_INFOBLOCK, "infoblock", 0, pos, dims)
            }
            (Some("infoblock"), Some("hide")) => {
                self.hide_overlay(OVERLAY_INFOBLOCK);
                Ok(())
            }
            _ => Err(format!("bad ks-overlay: {p:?}")),
        }
    }

    /// Resample the cached `key` bitmap to `dims`, write it to a temp file
    /// and (re)issue overlay-add. `tag` separates same-geometry
    /// different-content issuances (thumbnail tile indices).
    fn show_bitmap(
        &mut self,
        id: u8,
        key: &str,
        tag: u64,
        pos: (i32, i32),
        dims: (u32, u32),
    ) -> Result<(), String> {
        let (x, y) = pos;
        let (w, h) = dims;
        let gen = self.bitmap_gen;
        if self.overlays.get(&id) == Some(&(gen, tag, x, y, w, h)) {
            return Ok(()); // the OSD's 16 Hz render tick sends identical geometry
        }
        let scaled = {
            let bmp = self
                .bitmaps
                .get(key)
                .ok_or_else(|| format!("no bitmap '{key}' (not decoded yet)"))?;
            resample_bgra(&bmp.bgra, bmp.w, bmp.h, w, h)
        };
        let fname = format!("kappastream-osc-{}.bgra", key.replace(':', "-"));
        let path = std::env::temp_dir().join(fname);
        std::fs::write(&path, &scaled).map_err(|e| format!("write overlay file: {e}"))?;
        let path_s = path.to_str().ok_or("temp path not UTF-8")?.to_string();
        let args = [
            id.to_string(),
            x.to_string(),
            y.to_string(),
            path_s,
            "0".to_string(),
            "bgra".to_string(),
            w.to_string(),
            h.to_string(),
            (w * 4).to_string(),
        ];
        let argv: Vec<&str> = args.iter().map(String::as_str).collect();
        self.mpv
            .command("overlay-add", &argv)
            .map_err(|e| format!("overlay-add: {e}"))?;
        self.overlays.insert(id, (gen, tag, x, y, w, h));
        Ok(())
    }

    fn show_thumb(
        &mut self,
        x: i32,
        y: i32,
        w: u32,
        h: u32,
        strip: u32,
        tile: u32,
    ) -> Result<(), String> {
        let key = format!("thumb:{strip}");
        let (cropped, tw, th) = {
            let bmp = self
                .bitmaps
                .get(&key)
                .ok_or_else(|| format!("no bitmap '{key}' (not decoded yet)"))?;
            let (cols, rows) = bmp.grid.ok_or("strip bitmap without grid")?;
            let tile_w = bmp.w / cols;
            let tile_h = bmp.h / rows;
            let (out, ow, oh) = crop_tile_bgra(&bmp.bgra, bmp.w, bmp.h, tile_w, tile_h, tile)
                .ok_or_else(|| format!("tile {tile} outside strip grid"))?;
            (out, ow, oh)
        };
        // Stage the crop as a transient bitmap under a private key, then go
        // through the common resample+issue path.
        self.bitmaps.insert(
            "thumb:current".to_string(),
            CachedBitmap {
                bgra: cropped,
                w: tw,
                h: th,
                grid: None,
            },
        );
        // Any bitmap insert bumps the generation; make sure THIS one is the
        // latest so the dedupe below sees it as current.
        self.bitmap_gen += 1;
        self.show_bitmap(
            OVERLAY_THUMB,
            "thumb:current",
            (u64::from(strip) << 32) | u64::from(tile),
            (x, y),
            (w, h),
        )
    }

    fn hide_overlay(&mut self, id: u8) {
        if self.overlays.remove(&id).is_some() {
            let id_s = id.to_string();
            if let Err(e) = self.mpv.command("overlay-remove", &[id_s.as_str()]) {
                eprintln!("[mpv] overlay-remove {id}: {e}");
            }
        }
    }
}

/// Standard base64 (with padding) → bytes. Hand-rolled to keep the crate's
/// dependency set untouched for one decode site; verified against fixtures.
fn b64_decode(s: &str) -> Result<Vec<u8>, String> {
    fn val(c: u8) -> Result<u32, String> {
        Ok(match c {
            b'A'..=b'Z' => u32::from(c - b'A'),
            b'a'..=b'z' => u32::from(c - b'a') + 26,
            b'0'..=b'9' => u32::from(c - b'0') + 52,
            b'+' => 62,
            b'/' => 63,
            _ => return Err(format!("invalid base64 byte 0x{c:02x}")),
        })
    }
    let bytes: Vec<u8> = s.bytes().filter(|b| !b.is_ascii_whitespace()).collect();
    let mut out = Vec::with_capacity(bytes.len() / 4 * 3);
    for chunk in bytes.chunks(4) {
        if chunk.len() < 2 {
            return Err("truncated base64".to_string());
        }
        let b2 = if chunk.len() > 2 && chunk[2] != b'=' {
            Some(val(chunk[2])?)
        } else {
            None
        };
        let b3 = if chunk.len() > 3 && chunk[3] != b'=' {
            Some(val(chunk[3])?)
        } else {
            None
        };
        let v = (val(chunk[0])? << 18)
            | (val(chunk[1])? << 12)
            | (b2.unwrap_or(0) << 6)
            | b3.unwrap_or(0);
        out.push((v >> 16) as u8);
        if b2.is_some() {
            out.push((v >> 8) as u8);
        }
        if b3.is_some() {
            out.push(v as u8);
        }
    }
    Ok(out)
}

/// Nearest-neighbor BGRA resample — display-size targets change with the
/// window, and this never touches more than a ~1 MP source.
fn resample_bgra(src: &[u8], sw: u32, sh: u32, dw: u32, dh: u32) -> Vec<u8> {
    if sw == 0 || sh == 0 || dw == 0 || dh == 0 {
        return Vec::new();
    }
    let mut out = vec![0u8; dw as usize * dh as usize * 4];
    for dy in 0..dh {
        let sy = u64::from(dy) * u64::from(sh) / u64::from(dh);
        for dx in 0..dw {
            let sx = u64::from(dx) * u64::from(sw) / u64::from(dw);
            let s = ((sy * u64::from(sw) + sx) * 4) as usize;
            let d = ((u64::from(dy) * u64::from(dw) + u64::from(dx)) * 4) as usize;
            out[d..d + 4].copy_from_slice(&src[s..s + 4]);
        }
    }
    out
}

/// Crop a rect out of a cairo ARGB32 image surface (PREMULTIPLIED alpha,
/// little-endian bytes `[B, G, R, A]`, rows padded to `stride`) and convert
/// it to straight-alpha row-major BGRA — the format overlay-add composites.
/// The webview snapshot hands us the page exactly in that cairo format.
/// `crop` is (x, y, w, h) in snapshot pixels; it is clamped to the image
/// and an empty intersection yields an empty vec.
fn argb32_crop_to_bgra(
    data: &[u8],
    stride: usize,
    sw: usize,
    sh: usize,
    crop: (usize, usize, usize, usize),
) -> Vec<u8> {
    let (cx, cy, cw, ch) = crop;
    let x1 = cx.min(sw);
    let y1 = cy.min(sh);
    let x2 = cx.saturating_add(cw).min(sw);
    let y2 = cy.saturating_add(ch).min(sh);
    if x2 <= x1 || y2 <= y1 || stride < sw * 4 {
        return Vec::new();
    }
    let w = x2 - x1;
    let mut out = Vec::with_capacity(w * (y2 - y1) * 4);
    for row in y1..y2 {
        let base = row * stride + x1 * 4;
        for px in data[base..base + w * 4].chunks_exact(4) {
            let (b, g, r, a) = (px[0], px[1], px[2], px[3]);
            if a == 0 {
                out.extend_from_slice(&[0, 0, 0, 0]);
            } else if a == 255 {
                out.extend_from_slice(&[b, g, r, a]);
            } else {
                // Un-premultiply with rounding: cairo stores color channels
                // already multiplied by a/255.
                let un = |c: u8| -> u8 {
                    ((u16::from(c) * 255 + u16::from(a) / 2) / u16::from(a)) as u8
                };
                out.extend_from_slice(&[un(b), un(g), un(r), a]);
            }
        }
    }
    out
}

/// Zero the alpha of every packed straight-BGRA pixel OUTSIDE the union of
/// `keeps` ((x, y, w, h) bitmap px, clamped). The page snapshot's crop box
/// is the UNION BBOX of the overlapping elements — regions inside the box
/// but outside the elements show the page's empty player, which would
/// composite as an opaque dark border around the UI. Masking keeps only
/// the elements themselves; empty `keeps` leaves the bitmap untouched.
fn mask_keep_rects(bgra: &mut [u8], w: usize, h: usize, keeps: &[(usize, usize, usize, usize)]) {
    if keeps.is_empty() || w == 0 || h == 0 || bgra.len() < w * h * 4 {
        return;
    }
    let mut mask = vec![0u8; w * h];
    for &(kx, ky, kw, kh) in keeps {
        let x1 = kx.min(w);
        let y1 = ky.min(h);
        let x2 = kx.saturating_add(kw).min(w);
        let y2 = ky.saturating_add(kh).min(h);
        for row in mask.chunks_exact_mut(w).skip(y1).take(y2 - y1) {
            row[x1..x2].fill(1);
        }
    }
    for (px, keep) in bgra.chunks_exact_mut(4).zip(mask) {
        if keep == 0 {
            px[3] = 0;
        }
    }
}

/// Crop tile `tile` (row-major) out of a storyboard strip grid of
/// `tile_w × tile_h` cells. Returns the bytes + the tile dims.
fn crop_tile_bgra(
    src: &[u8],
    strip_w: u32,
    strip_h: u32,
    tile_w: u32,
    tile_h: u32,
    tile: u32,
) -> Option<(Vec<u8>, u32, u32)> {
    if tile_w == 0 || tile_h == 0 || strip_w == 0 || strip_h == 0 {
        return None;
    }
    let cols = strip_w / tile_w;
    let rows = strip_h / tile_h;
    if cols == 0 || rows == 0 {
        return None;
    }
    let col = tile % cols;
    let row = tile / cols;
    if row >= rows {
        return None;
    }
    let x0 = col * tile_w;
    let mut out = Vec::with_capacity(tile_w as usize * tile_h as usize * 4);
    for y in 0..tile_h {
        let base = (((row * tile_h + y) * strip_w + x0) * 4) as usize;
        let end = base + tile_w as usize * 4;
        if end > src.len() {
            return None;
        }
        out.extend_from_slice(&src[base..end]);
    }
    Some((out, tile_w, tile_h))
}

// ---------------------------------------------------------------------------
// Commands

/// The registry is BOUNDED: id 0 is the single-view player, 1..=4 the
/// multi-view tiles (the frontend's free-list ids). Every id-taking command
/// funnels through `engine_id` — a stray large id must be REJECTED, never
/// mint a fresh leaked mpv core + native surface.
const MAX_ENGINE_ID: u32 = 4;

fn engine_id(id: Option<u32>) -> Result<u32, String> {
    let id = id.unwrap_or(0);
    if id > MAX_ENGINE_ID {
        Err(format!("engine id {id} out of range (0..={MAX_ENGINE_ID})"))
    } else {
        Ok(id)
    }
}

fn with_engine<R>(id: u32, f: impl FnOnce(&mut Engine) -> Result<R, String>) -> Result<R, String> {
    let mut engines = engines().lock().expect("mpv engines lock poisoned");
    let engine = engines
        .get_mut(&id)
        .ok_or_else(|| "mpv engine unavailable".to_string())?;
    f(engine)
}

/// Runtime availability probe result for the frontend. Flagged builds always
/// RESOLVE — when the surface fails to init the `reason` carries the exact
/// error so Settings can display it instead of silently hiding the feature
/// (a rejected invoke means a default build, where this command doesn't exist).
#[derive(Serialize, Clone)]
pub struct AvailabilityPayload {
    pub available: bool,
    pub reason: Option<String>,
}

/// Runtime availability probe for the frontend (also engine 0's eager
/// bootstrap: a first call creates the single-player core + surface). In
/// default builds this command does not exist at all (registration is
/// feature-gated in lib.rs) — the frontend's invoke rejects and is treated as
/// "not available".
#[tauri::command]
pub fn mpv_available(app: AppHandle) -> AvailabilityPayload {
    // Linux is the only owner-verified platform. On Windows/macOS the
    // surface has never run on hardware, so the Settings toggle stays
    // hidden there (the frontend renders nothing for a false probe and
    // selectVideoBackend falls back to hls). Escape hatch for the owner's
    // on-hardware verification runs: launch the binary with
    // KAPPASTREAM_MPV_FORCE=1 to have the engine offered as if verified.
    #[cfg(not(target_os = "linux"))]
    {
        if std::env::var_os("KAPPASTREAM_MPV_FORCE").is_none() {
            return AvailabilityPayload {
                available: false,
                reason: Some("engine not verified on this platform yet".to_string()),
            };
        }
    }
    match ensure_engine(&app, 0) {
        Ok(_) => AvailabilityPayload {
            available: true,
            reason: None,
        },
        Err(reason) => AvailabilityPayload {
            available: false,
            reason: Some(reason),
        },
    }
}

/// Load a media URL on the engine `id` (0 = single player, 1..=4 = tiles)
/// and show the surface. The URL is the STREAMLINK-RESOLVED one, passed
/// THROUGH directly — mpv is not a browser, so no ksvod proxy, no CORS.
/// `start_at` (VOD resume) becomes mpv's `start` load option; it is cleared
/// again on FileLoaded. Volume/muted are applied at load (the engine may
/// have been created by a bare availability probe before the frontend ever
/// set them).
#[tauri::command]
#[allow(clippy::too_many_arguments)] // the load's full parameter set, mirroring mpv's own loadfile+options
pub fn mpv_load(
    app: AppHandle,
    id: Option<u32>,
    url: String,
    kind: String,
    start_at: Option<f64>,
    hwdec: String,
    volume: f64,
    muted: bool,
) -> Result<(), String> {
    if !matches!(kind.as_str(), "live" | "vod" | "clip") {
        return Err(format!("unknown media kind: {kind}"));
    }
    // The webview is the caller — a TRUST BOUNDARY. mpv opens file://,
    // edl://, memory://, lavf://, smb:// and local playlists if handed
    // them, so nothing reaches loadfile without passing the same https +
    // host-family predicate the resolvers apply to streamlink's output.
    crate::resolve::validate_media_url(&url, &kind)?;
    // The engine (and the surface) must be up; a lazy first call is fine —
    // the frontend probes mpv_available at startup, which normally already
    // built engine 0, but a first-ever load (or a tile's first stream) must
    // also work.
    let id = engine_id(id)?;
    ensure_engine(&app, id)?;
    with_engine(id, |e| {
        e.mpv
            .set_property("hwdec", hwdec.as_str())
            .map_err(|err| format!("set hwdec: {err}"))?;
        e.mpv
            .set_property("volume", volume.clamp(0.0, 1.0) * 100.0)
            .map_err(|err| format!("set volume: {err}"))?;
        e.mpv
            .set_property("mute", muted)
            .map_err(|err| format!("set mute: {err}"))?;
        if let Some(start) = start_at {
            if start.is_finite() && start > 0.5 {
                e.mpv
                    .set_property("start", format!("+{start:.3}"))
                    .map_err(|err| format!("set start: {err}"))?;
            }
        }
        e.mpv
            .command("loadfile", &[url.as_str(), "replace"])
            .map_err(|err| format!("loadfile: {err}"))?;
        // NOTE: the surface is NOT revealed here — the event thread shows it
        // on the first PlaybackRestart (first frame presented), so the page's
        // loading/error overlays aren't covered by a black video box during
        // load.
        Ok(())
    })
}

/// Stop playback and hide the surface (the transparent page region goes back
/// to opaque). Safe (and a no-op) when the engine never came up — the
/// frontend calls this on every teardown.
#[tauri::command]
pub fn mpv_stop(id: Option<u32>) -> Result<(), String> {
    let id = engine_id(id)?;
    if let Some(engine) = engines()
        .lock()
        .expect("mpv engines lock poisoned")
        .get_mut(&id)
    {
        engine.active = false;
        let _ = engine.mpv.command("stop", &[]);
        engine.surface.hide();
    }
    Ok(())
}

#[tauri::command]
pub fn mpv_set_paused(id: Option<u32>, paused: bool) -> Result<(), String> {
    with_engine(engine_id(id)?, |e| {
        e.mpv
            .set_property("pause", paused)
            .map_err(|err| format!("set pause: {err}"))
    })
}

/// Absolute seek in seconds.
#[tauri::command]
pub fn mpv_seek(id: Option<u32>, seconds: f64) -> Result<(), String> {
    let target = format!("{:.3}", seconds.max(0.0));
    with_engine(engine_id(id)?, |e| {
        e.mpv
            .command("seek", &[target.as_str(), "absolute"])
            .map_err(|err| format!("seek: {err}"))
    })
}

/// Volume 0..1 (mpv's property is 0..100).
#[tauri::command]
pub fn mpv_set_volume(id: Option<u32>, volume: f64) -> Result<(), String> {
    let v = volume.clamp(0.0, 1.0) * 100.0;
    with_engine(engine_id(id)?, |e| {
        e.mpv
            .set_property("volume", v)
            .map_err(|err| format!("set volume: {err}"))
    })
}

#[tauri::command]
pub fn mpv_set_muted(id: Option<u32>, muted: bool) -> Result<(), String> {
    with_engine(engine_id(id)?, |e| {
        e.mpv
            .set_property("mute", muted)
            .map_err(|err| format!("set mute: {err}"))
    })
}

/// Position the surface (logical px, window-relative, zoom-adjusted by the
/// frontend). Cheap: the surface marshals to the UI thread itself, so this
/// never blocks the caller.
#[tauri::command]
pub fn mpv_set_rect(id: Option<u32>, x: i32, y: i32, w: i32, h: i32) -> Result<(), String> {
    with_engine(engine_id(id)?, |e| {
        e.surface.set_rect(x, y, w, h);
        Ok(())
    })
}

/// Forward a pointer event over the native video into mpv's input queue —
/// the ONLY way to interact with mpv's on-screen controller (the OSC lives
/// in mpv's OSD; the webview's pointer events land on the page UNDER the
/// native surface). Coordinates are NORMALIZED within the player rect
/// (0..1) and rescaled here by mpv's own OSD dimensions (== the render
/// size), so a webview-vs-GDK scale mismatch can never desync the mapping.
/// `kind`: "move" | "click" (button 0) | "wheel-up" | "wheel-down".
#[tauri::command]
pub fn mpv_pointer(id: Option<u32>, x: f64, y: f64, kind: String) -> Result<(), String> {
    with_engine(engine_id(id)?, |e| {
        // 0 until the first render configured the OSD size — nothing to
        // hit-test yet, drop the event.
        let osd_w = e.mpv.get_property::<i64>("osd-width").unwrap_or(0);
        let osd_h = e.mpv.get_property::<i64>("osd-height").unwrap_or(0);
        if osd_w <= 0 || osd_h <= 0 {
            return Ok(());
        }
        let ix = (x.clamp(0.0, 1.0) * osd_w as f64).round() as i64;
        let iy = (y.clamp(0.0, 1.0) * osd_h as f64).round() as i64;
        // NOTE: mpv 0.40's `mouse` command has ONLY single/double click
        // modes — down/up don't exist (probed against this exact libmpv:
        // rejected with invalid-parameter; keydown/keyup MBTN_LEFT dispatch
        // nothing) — so "click" is a one-shot single; the OSD script
        // synthesizes drags from the click stream (scrub preview, commit on
        // stream end).
        let (cmd, args): (&str, Vec<String>) = match kind.as_str() {
            "move" => ("mouse", vec![ix.to_string(), iy.to_string()]),
            "click" => (
                "mouse",
                vec![ix.to_string(), iy.to_string(), "0".into(), "single".into()],
            ),
            "wheel-up" => ("keypress", vec!["WHEEL_UP".into()]),
            "wheel-down" => ("keypress", vec!["WHEEL_DOWN".into()]),
            other => return Err(format!("unknown pointer kind: {other}")),
        };
        let argv: Vec<&str> = args.iter().map(String::as_str).collect();
        e.mpv
            .command(cmd, &argv)
            .map_err(|err| format!("{cmd}: {err}"))
    })
}

/// Hide/show the native video surfaces while a blocking webview overlay
/// (Settings, About, what's-new, search results, …) is open: those render
/// in the page, i.e. UNDER the native surfaces, so the video would eat
/// them. Applies to EVERY engine (a modal is a whole-window concern — in
/// multi-view any tile surface must duck too). Hiding is VISUAL only — mpv
/// keeps playing (audio) — and the PlaybackRestart auto-reveal stays
/// suspended while suppressed. The re-show skips engines the frontend
/// stopped (`active`, e.g. closed tiles) so a broadcast never pops a dead
/// black box. Quiet no-op without engines (the frontend calls it
/// unconditionally).
#[tauri::command]
pub fn mpv_set_surface_visible(visible: bool) -> Result<(), String> {
    let mut engines = engines().lock().expect("mpv engines lock poisoned");
    for engine in engines.values_mut() {
        engine.overlay_suppressed = !visible;
        if visible {
            if engine.active {
                engine.surface.show();
            }
        } else {
            engine.surface.hide();
        }
    }
    Ok(())
}

/// Send a script message to the embedded OSD script (ks-osc.lua) — the
/// app-side data feed: stream info, theme colors, the quality list, and
/// the pip/theater/fullscreen highlight states. Args pass through
/// verbatim; args[0] is the message name ("ks-info", "ks-theme", …).
#[tauri::command]
pub fn mpv_script_msg(id: Option<u32>, args: Vec<String>) -> Result<(), String> {
    if args.is_empty() {
        return Err("empty script message".to_string());
    }
    with_engine(engine_id(id)?, |e| {
        let argv: Vec<&str> = args.iter().map(String::as_str).collect();
        e.mpv
            .command("script-message", &argv)
            .map_err(|err| format!("script-message: {err}"))
    })
}

/// Snapshot the webview and composite the page UI that overlaps the video
/// ABOVE it as an mpv bitmap overlay — the successor to two failed
/// "cut holes in the video" approaches (GDK visual shapes are a no-op on
/// Wayland; alpha-clearing the GL frame never visibly landed). The page's
/// dialogs/dropdowns/tooltips/toasts render in the webview UNDER the native
/// video window, but pointer input already falls through the video to the
/// real elements — so re-drawing their PIXELS over the video (a cropped
/// `webkit_web_view_get_snapshot`) makes them both visible and fully
/// interactive. The frontend sends the union box (window CSS px, the same
/// space mpv_set_rect uses) whenever the set of overlapping modules
/// changes and at a slow cadence for content refreshes; geometry (fractions
/// of the video rect, via ks-osc's ks-page) and pixels flow through the
/// same overlay-add path as the storyboard thumbnails.
///
/// `keep` (flat x,y,w,h CSS-px rects within the crop) MASKS the bitmap:
/// pixels outside every keep rect get alpha 0, so the union crop of e.g.
/// the notification menu + a tooltip poking past its edge doesn't carry
/// the empty player's opaque background as dark padding around the
/// elements. Empty/absent = keep everything.
#[tauri::command]
pub fn mpv_page_snapshot(
    app: AppHandle,
    id: Option<u32>,
    x: i32,
    y: i32,
    w: i32,
    h: i32,
    keep: Option<Vec<i32>>,
) -> Result<(), String> {
    if x < 0 || y < 0 || w < 1 || h < 1 {
        return Err("snapshot rect must be non-negative with w/h >= 1".to_string());
    }
    if let Some(flat) = &keep {
        if flat.len() % 4 != 0 {
            return Err("keep must be flat x,y,w,h rects".to_string());
        }
    }
    #[cfg(target_os = "linux")]
    {
        linux::page_snapshot(&app, engine_id(id)?, x, y, w, h, keep.unwrap_or_default())
    }
    #[cfg(not(target_os = "linux"))]
    {
        let _ = (app, keep);
        Err("page-UI overlay snapshots are Linux-only for now".to_string())
    }
}

/// Upload an OSD image bitmap (base64 BGRA + dims; storyboard strips also
/// carry their cols × rows tile grid). The webview decodes what it already
/// has (the info block; storyboard strips via the ksvod proxy) — Rust
/// never fetches anything. ks-osc.lua later drives the actual on-screen
/// overlay geometry via `ks-overlay` script messages.
#[tauri::command]
pub fn mpv_set_bitmap(
    id: Option<u32>,
    key: String,
    b64: String,
    w: u32,
    h: u32,
    cols: Option<u32>,
    rows: Option<u32>,
) -> Result<(), String> {
    if key.is_empty() || w == 0 || h == 0 {
        return Err("bitmap needs a key and non-zero dims".to_string());
    }
    let grid = match (cols, rows) {
        (None, None) => None,
        (Some(c), Some(r)) if c >= 1 && r >= 1 => Some((c, r)),
        _ => return Err("grid needs cols >= 1 and rows >= 1".to_string()),
    };
    let bgra = b64_decode(&b64)?;
    if bgra.len() != w as usize * h as usize * 4 {
        return Err(format!(
            "bitmap '{}' payload {} B does not match {w}x{h} BGRA",
            key,
            bgra.len()
        ));
    }
    with_engine(engine_id(id)?, |e| {
        e.bitmap_gen += 1;
        e.bitmaps.insert(key, CachedBitmap { bgra, w, h, grid });
        Ok(())
    })
}

#[cfg(all(test, feature = "mpv-embed"))]
mod tests {
    use super::*;

    #[test]
    fn engine_ids_are_bounded_to_the_registry_range() {
        assert_eq!(engine_id(None), Ok(0));
        for id in 0..=MAX_ENGINE_ID {
            assert_eq!(engine_id(Some(id)), Ok(id));
        }
        for id in [5u32, 6, 1000, u32::MAX] {
            assert!(engine_id(Some(id)).is_err(), "id {id} must be rejected");
        }
        // The commands run the bound BEFORE any registry access — an
        // out-of-range id is an error even on the quiet-teardown command
        // (mpv_stop), and never mints an engine; a valid-but-absent id
        // keeps its existing quiet no-op contract.
        assert!(mpv_stop(Some(u32::MAX)).is_err());
        assert!(mpv_stop(Some(5)).is_err());
        assert!(mpv_stop(Some(MAX_ENGINE_ID)).is_ok());
        assert!(mpv_stop(None).is_ok());
    }

    #[test]
    fn commands_fail_cleanly_without_an_engine() {
        // No engine exists in a test process (build_engine needs a Tauri
        // app handle): the registry must read empty and every command helper
        // must fail cleanly rather than panic. mpv_stop is the deliberate
        // exception — teardown paths call it unconditionally, so it must be
        // a quiet no-op (for every id).
        assert!(engines().lock().unwrap().is_empty());
        assert!(with_engine(0, |_| Ok(())).is_err());
        assert!(with_engine(2, |_| Ok(())).is_err());
        assert!(mpv_stop(None).is_ok());
        assert!(mpv_stop(Some(3)).is_ok());
        // mpv_set_surface_visible is on the unconditional teardown-adjacent
        // path like mpv_stop: quiet no-op without engines (and a broadcast
        // over zero engines must not panic either). mpv_pointer is only ever
        // called from an active native session, so a missing engine is a
        // real error there.
        assert!(mpv_set_surface_visible(true).is_ok());
        assert!(mpv_set_surface_visible(false).is_ok());
        // mpv_page_snapshot needs a live AppHandle (webview access) — its
        // validation is a three-branch guard; the interesting math
        // (un-premultiply/crop) is pinned by argb32 tests below.
        assert!(mpv_pointer(None, 0.5, 0.5, "move".to_string()).is_err());
        assert!(mpv_script_msg(None, Vec::<String>::new()).is_err());
        assert!(mpv_script_msg(None, vec!["ks-page".to_string()]).is_err());
        assert!(mpv_set_bitmap(
            None,
            "infoblock".into(),
            "AAAAAA==".into(),
            0,
            0,
            None,
            None
        )
        .is_err());
    }

    #[test]
    fn base64_decodes_standard_alphabet() {
        assert_eq!(b64_decode("").unwrap(), Vec::<u8>::new());
        assert_eq!(b64_decode("QQ==").unwrap(), b"A");
        assert_eq!(b64_decode("QUI=").unwrap(), b"AB");
        assert_eq!(b64_decode("QUJD").unwrap(), b"ABC");
        assert_eq!(b64_decode("QUJDRA==").unwrap(), b"ABCD");
        // +/ alphabet and embedded whitespace tolerance
        assert_eq!(b64_decode("PDw/Pz8+Pg==").unwrap(), b"<<???>>");
        assert_eq!(b64_decode("QUJD\nRA==").unwrap(), b"ABCD");
        assert!(b64_decode("A").is_err());
        assert!(b64_decode("!!!!").is_err());
    }

    #[test]
    fn resample_is_identity_at_same_size_and_nearest_when_scaled() {
        // 2x1 BGRA: red | green
        let src = [0x00, 0x00, 0xFF, 0xFF, 0x00, 0xFF, 0x00, 0xFF];
        assert_eq!(resample_bgra(&src, 2, 1, 2, 1), src.to_vec());
        // Downscale to 1x1: nearest picks the FIRST source pixel (index 0).
        assert_eq!(resample_bgra(&src, 2, 1, 1, 1), src[0..4].to_vec());
        // Upscale 1x1 -> 2x1 duplicates the pixel (nearest: 0.5 → 0).
        let red = src[0..4].to_vec();
        let doubled: Vec<u8> = red.iter().chain(red.iter()).copied().collect();
        assert_eq!(resample_bgra(&src[0..4], 1, 1, 2, 1), doubled);
        assert!(resample_bgra(&src, 2, 1, 0, 1).is_empty());
    }

    #[test]
    fn keep_rect_masking_zeroes_only_outside_alpha() {
        // 3x2 bitmap, all opaque; keep the left column and the bottom-right
        // pixel — everything else must end transparent (color kept, alpha 0).
        let mut bgra = vec![0xEEu8; 3 * 2 * 4];
        mask_keep_rects(&mut bgra, 3, 2, &[(0, 0, 1, 2), (2, 1, 1, 1)]);
        let alpha = |i: usize| bgra[i * 4 + 3];
        assert_eq!(alpha(0), 0xEE); // (0,0) kept
        assert_eq!(alpha(1), 0x00); // (1,0) outside
        assert_eq!(alpha(2), 0x00); // (2,0) outside
        assert_eq!(alpha(3), 0xEE); // (0,1) kept
        assert_eq!(alpha(4), 0x00); // (1,1) outside
        assert_eq!(alpha(5), 0xEE); // (2,1) kept — overlapping/clamped rect
                                    // Out-of-bounds keeps clamp; empty keeps leave everything opaque.
        let mut untouched = vec![0xEEu8; 4];
        mask_keep_rects(&mut untouched, 1, 1, &[]);
        assert_eq!(untouched, vec![0xEE; 4]);
        mask_keep_rects(&mut untouched, 1, 1, &[(9, 9, 5, 5)]);
        assert_eq!(untouched[3], 0x00);
    }

    #[test]
    fn argb32_crop_unpremultiplies_and_clamps() {
        // 2x2 ARGB32 image, stride padded to 12 B (one phantom column):
        //   opaque red | 50% blue (premult b=64,a=128)
        //   transparent| opaque white
        let mut data = vec![0u8; 2 * 12];
        data[0..4].copy_from_slice(&[0x00, 0x00, 0xFF, 0xFF]); // red, opaque
        data[4..8].copy_from_slice(&[0x40, 0x00, 0x00, 0x80]); // premult blue
        let row2 = &mut data[12..]; // second row (past the 12 B stride)
        row2[0..4].copy_from_slice(&[0x00, 0x00, 0x00, 0x00]); // empty
        row2[4..8].copy_from_slice(&[0xFF, 0xFF, 0xFF, 0xFF]); // white
                                                               // Full crop: straight alpha restored (64*255/128 = 127.5 → 128).
        assert_eq!(
            argb32_crop_to_bgra(&data, 12, 2, 2, (0, 0, 2, 2)),
            vec![
                0x00, 0x00, 0xFF, 0xFF, //
                0x80, 0x00, 0x00, 0x80, //
                0x00, 0x00, 0x00, 0x00, //
                0xFF, 0xFF, 0xFF, 0xFF,
            ]
        );
        // Crop just the first column (stride must be honored).
        assert_eq!(
            argb32_crop_to_bgra(&data, 12, 2, 2, (0, 0, 1, 2)),
            vec![0x00, 0x00, 0xFF, 0xFF, 0x00, 0x00, 0x00, 0x00]
        );
        // Out-of-bounds crops clamp to the intersection (here: the bottom
        // right pixel alone); disjoint crops = empty.
        assert_eq!(
            argb32_crop_to_bgra(&data, 12, 2, 2, (1, 1, 9, 9)),
            vec![0xFF, 0xFF, 0xFF, 0xFF]
        );
        assert!(argb32_crop_to_bgra(&data, 12, 2, 2, (5, 5, 2, 2)).is_empty());
        // A stride narrower than the image is malformed → empty.
        assert!(argb32_crop_to_bgra(&data, 4, 2, 2, (0, 0, 2, 2)).is_empty());
    }

    #[test]
    fn crop_tile_picks_the_row_major_cell() {
        // 2x2 grid of 1px BGRA cells: R G / B W
        let src = [
            0x00, 0x00, 0xFF, 0xFF, /**/ 0x00, 0xFF, 0x00, 0xFF, //
            0xFF, 0x00, 0x00, 0xFF, /**/ 0xFF, 0xFF, 0xFF, 0xFF,
        ];
        let cell = |t| {
            let (v, w, h) = crop_tile_bgra(&src, 2, 2, 1, 1, t).unwrap();
            assert_eq!((w, h), (1, 1));
            v
        };
        assert_eq!(cell(0), src[0..4].to_vec()); // R
        assert_eq!(cell(1), src[4..8].to_vec()); // G
        assert_eq!(cell(2), src[8..12].to_vec()); // B
        assert_eq!(cell(3), src[12..16].to_vec()); // W
        assert!(crop_tile_bgra(&src, 2, 2, 1, 1, 4).is_none()); // past the grid
        assert!(crop_tile_bgra(&src, 2, 2, 0, 1, 0).is_none()); // degenerate tile
    }

    /// Reproduces the shipped bug exactly: on any real desktop GTK has set
    /// LC_ALL from the environment, and if that locale formats numbers with
    /// a comma (de_DE, fr_FR, …) libmpv refuses `mpv_create` — the
    /// user-visible "mpv init failed: Null". Runs against the real libmpv
    /// the crate links.
    /// (C.UTF-8 does NOT reproduce it: its decimal point stays '.', which is
    /// why this picks the first candidate that actually changes it.)
    #[test]
    #[cfg(target_os = "linux")]
    fn mpv_core_requires_dot_decimal_locale_and_the_pin_fixes_it() {
        use std::ffi::{CStr, CString};
        // SAFETY: locale save/probe/restore around the assertions; the saved
        // value is copied out immediately (setlocale's returned pointer only
        // lives until the next call).
        unsafe {
            let saved = libc::setlocale(libc::LC_ALL, std::ptr::null());
            let saved = if saved.is_null() {
                CString::new("C").unwrap()
            } else {
                CStr::from_ptr(saved).to_owned()
            };
            let mut repro = false;
            for name in [c"de_DE.UTF-8", c"fr_FR.UTF-8"] {
                if libc::setlocale(libc::LC_ALL, name.as_ptr()).is_null() {
                    continue; // locale not installed on this runner
                }
                let conv = libc::localeconv();
                if !conv.is_null() && libc::strcmp((*conv).decimal_point, c".".as_ptr()) != 0 {
                    repro = true;
                    break;
                }
            }
            if repro {
                assert!(
                    Mpv::new().is_err(),
                    "libmpv must refuse a comma-decimal locale (mpv_create → NULL)"
                );
                pin_c_numeric_locale();
                assert!(
                    Mpv::new().is_ok(),
                    "after pinning LC_NUMERIC=C the core must create"
                );
            } else {
                eprintln!("no comma-decimal locale available; mechanism test skipped");
            }
            libc::setlocale(libc::LC_ALL, saved.as_ptr());
        }
    }
}
