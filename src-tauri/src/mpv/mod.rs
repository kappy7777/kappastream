// Experimental embedded-libmpv video engine ("video above the page") —
// LINUX-ONLY. Windows and macOS build no mpv code at all and run the
// hls.js engine exclusively; off-Linux support is out of scope rather
// than pending.
//
// When the `mpv-embed` Cargo feature is on AND the runtime toggle is on, the
// main player renders through libmpv drawing into a native surface positioned
// ABOVE the (fully opaque) webview — input-transparent, so the HTML keeps all
// pointer handling; the in-video controls are mpv's OSD. Multi-view tiles run
// the SAME engine (one mpv core per tile, ids 1..=4) with the SAME OSD in
// ks-osc's trimmed "tile" mode (no app-global buttons; reorder arrows + a
// close X in the bar, channel label top-left) — the app's HTML control strip
// renders on hls tiles only. The PiP window stays on hls.js (out of scope by
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
//   1. This module only compiles under
//      `#[cfg(all(feature = "mpv-embed", target_os = "linux"))]`. The
//      feature is a DEFAULT whose dependency
//      set is target-gated to Linux in Cargo.toml — so every LINUX release
//      build ships the engine and its packaging carries libmpv (deb/rpm
//      depends, AppImage bundling via linuxdeploy, AUR `mpv` dep), while a
//      plain Windows/macOS `cargo build` compiles and links NOTHING mpv
//      and needs nothing installed. There is no force-enable hatch.
//   2. Nothing release-affecting: the window/webview stay exactly as
//      tauri.conf.json builds them (opaque); the Linux surface arranges
//      the native video surface at runtime.
//   3. `mpv_available()` returns true only when the surface initialized;
//      builds without the engine register a lib.rs stub that resolves
//      false with "not supported on this platform" (the frontend also
//      treats a missing command as false).
//
// BUILD PREREQUISITES (Linux only — the only platform that compiles this):
//   libmpv — Arch: `pacman -S mpv`; Debian/Ubuntu: `apt install
//   libmpv-dev` (also the runtime libmpv.so.2, pulled in by it). GL
//   symbols are dlopened at runtime from libGL.so.1 / libOpenGL.so.0
//   (GLVND; always present on a desktop, no dev package needed — see
//   src/mpv/linux.rs).
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
//   - COMMAND THREADING: every command that talks to the mpv core is an
//     async command, so its libmpv calls run on the Tauri async runtime —
//     NEVER the GTK main thread, which is the render thread (the GLArea
//     render callback) and must per libmpv's render.h contract call only
//     mpv_render_* functions. A per-engine gate (`with_core`) serializes
//     concurrent commands deterministically. GTK-only commands
//     (mpv_set_rect, mpv_set_surface_visible, mpv_page_snapshot) and the
//     state-only mpv_set_bitmap stay sync — running on the main thread is
//     what they want; the engine bootstrap (widgets + render-context
//     creation) runs on the main thread inside `with_webview` by
//     construction.
//   - The platform surface (the native window region mpv draws into) is
//     linux.rs behind the `VideoSurface` trait. Rects are LOGICAL (GDK)
//     pixels, already zoom-adjusted by the frontend.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

use libmpv2::events::{Event, PropertyData};
use libmpv2::Mpv;
use serde::Serialize;
use tauri::async_runtime::Mutex as AsyncMutex;
use tauri::{AppHandle, Emitter, Manager};

#[cfg(target_os = "linux")]
mod linux;
#[cfg(target_os = "linux")]
use linux as platform;

/// The UA mpv presents when fetching the resolved media URLs: THE SAME
/// shared browser const the GQL proxy sends (gql::USER_AGENT) — an alias,
/// not a second copy. The previous "streamlink/7.2.0" was never streamlink's
/// session default (its http session sends a Firefox UA), nobody else sent
/// that exact string, and it fingerprinted every kappastream install at
/// Twitch's CDN. The alias exists so the drift test has two names to
/// compare.
const MPV_USER_AGENT: &str = crate::gql::USER_AGENT;

/// Kappastream's in-video control OSD (replaces mpv's stock OSC). Lua,
/// drawn through the same render context as the video; data flows in via
/// script messages (mpv_script_msg) and button actions come back as
/// `ks-action` client messages (see the event thread). libmpv loads
/// scripts from files only, so the engine materializes this at init and
/// passes it via the `scripts` list option.
const KS_OSC_LUA: &str = include_str!("ks-osc.lua");

/// Min interval between `mpv://time` emits (~4 Hz).
const TIME_EMIT_INTERVAL: Duration = Duration::from_millis(250);

/// Leading-edge throttle with a GUARANTEED trailing flush, for the
/// `mpv://time` stream. The first value of a window emits immediately;
/// values arriving inside the window are held and the LAST held value
/// emits when the window expires — without the trailing half, quick seeks
/// while paused could leave the UI on the pre-seek position forever (the
/// next time-pos change only comes with further playback; a paused seek
/// changes time-pos exactly once). Pure decision logic: `now` is fed in,
/// so the unit tests drive synthetic clocks.
struct TimeThrottle {
    interval: Duration,
    /// When the window opened (the last emit).
    last_emit: Option<Instant>,
    /// The most recent value dropped by the window, awaiting its flush.
    pending: Option<f64>,
}

impl TimeThrottle {
    fn new(interval: Duration) -> Self {
        TimeThrottle {
            interval,
            last_emit: None,
            pending: None,
        }
    }

    /// Offer a value; `Some(v)` means emit it now.
    fn offer(&mut self, now: Instant, v: f64) -> Option<f64> {
        let window_open = self
            .last_emit
            .is_some_and(|t| now.duration_since(t) < self.interval);
        if window_open {
            self.pending = Some(v);
            return None;
        }
        self.last_emit = Some(now);
        self.pending = None;
        Some(v)
    }

    /// The trailing flush, driven by the event loop's clock: emits the held
    /// value once the window has expired. `wait_timeout` tells the loop
    /// when to come back for it.
    fn poll_flush(&mut self, now: Instant) -> Option<f64> {
        let last = self.last_emit?;
        if now.duration_since(last) < self.interval {
            return None;
        }
        let v = self.pending.take()?;
        self.last_emit = Some(now);
        Some(v)
    }

    /// Emit a held value IMMEDIATELY (PlaybackRestart: a seek just landed
    /// and the UI needs the position now, not at window expiry).
    fn force_flush(&mut self, now: Instant) -> Option<f64> {
        let v = self.pending.take()?;
        self.last_emit = Some(now);
        Some(v)
    }

    /// The `wait_event` timeout to use: while a value is held, at most the
    /// rest of the window (plus 1 ms so the deadline has certainly passed
    /// when the wait returns); otherwise block indefinitely (-1.0).
    fn wait_timeout(&self, now: Instant) -> f64 {
        match (self.pending.is_some(), self.last_emit) {
            (true, Some(last)) => {
                let remaining = self.interval.saturating_sub(now.duration_since(last));
                remaining.as_secs_f64() + 0.001
            }
            _ => -1.0,
        }
    }
}

/// The native region under the webview mpv renders into. All rects in
/// LOGICAL px, window-relative. The implementation marshals to the UI
/// thread itself; calls are cheap and non-blocking. `fold_top` is the
/// number of rows currently hidden ABOVE the rect (the page scrolled the
/// video under the top bar); the surface clips them at presentation time.
pub trait VideoSurface: Send + Sync {
    fn show(&self);
    fn hide(&self);
    fn set_rect(&self, x: i32, y: i32, w: i32, h: i32, fold_top: i32);
}

struct Engine {
    mpv: &'static Mpv,
    surface: Arc<dyn VideoSurface>,
    /// Gate serializing this engine's libmpv calls (see `with_core`): async
    /// commands run on the Tauri async runtime — never the GTK main
    /// (render) thread — and the gate keeps concurrent commands for one
    /// engine deterministic (first to reach the gate runs first). The
    /// strict invoke-order the single-threaded sync commands provided
    /// still holds where it matters: the frontend awaits every load
    /// (playback-session's attachMpv), and the fire-and-forget commands
    /// (pointer, volume, script feeds) are last-wins by design.
    core_gate: Arc<AsyncMutex<()>>,
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
    /// Last observed osd-width/osd-height — the render size mpv_pointer
    /// rescales normalized pointer coordinates by. OBSERVED by the event
    /// thread (a property change arrives whenever the render size changes),
    /// so the command needs no synchronous get_property round-trips per
    /// pointermove. Cleared on idle, matching the old get_property failure
    /// mode that dropped events while nothing renders.
    osd: (i64, i64),
    /// OSD image overlays (info block, storyboard thumbnails, page-UI
    /// snapshots): decoded by
    /// the webview (which already has the sources cached/fetched) into
    /// PREMULTIPLIED BGRA — the format overlay-add composites — and pushed
    /// via mpv_set_bitmap; ks-osc.lua drives show/hide + geometry
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
/// "thumb:<n>"). The pixels are an Arc so the overlay path can clone them
/// out of the engines lock and resample/issue without holding it.
struct CachedBitmap {
    bgra: Arc<Vec<u8>>,
    w: u32,
    h: u32,
    /// Storyboard strips only: the cols × rows tile grid of the image, used
    /// to crop individual thumbnails.
    grid: Option<(u32, u32)>,
}

/// A cheaply-cloned handle to an engine's surface and cached OSD size,
/// copied out under the engines lock in one brief grab. Callers must NOT
/// hold the registry lock across a libmpv call or bitmap resampling:
/// the lock also guards the per-engine event threads (wait_event + overlay
/// issuing) and the page-snapshot workers, and one synchronous core call
/// held under it stalls all of them — and, for commands that run on the
/// GTK main thread, squeezes the render callback's own scheduling window.
/// (The mpv core itself is deliberately NOT part of this handle: core
/// calls go through `with_core`, which serializes per engine and runs off
/// the main thread.)
#[derive(Clone)]
struct EngineHandle {
    surface: Arc<dyn VideoSurface>,
    osd: (i64, i64),
}

fn engine_handle(id: u32) -> Result<EngineHandle, String> {
    engine_handle_opt(id).ok_or_else(|| "mpv engine unavailable".to_string())
}

fn engine_handle_opt(id: u32) -> Option<EngineHandle> {
    lock_or_recover(engines()).get(&id).map(|e| EngineHandle {
        surface: Arc::clone(&e.surface),
        osd: e.osd,
    })
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

/// Lock one of the mpv statics, recovering from a poisoned lock instead of
/// panicking. A panic on some other thread while holding one of these locks
/// must not take every mpv command down with it: the guarded state is a
/// plain registry / counter / rect that stays structurally valid across a
/// panicking critical section, so the data behind a poisoned lock is still
/// safe to keep using.
pub(super) fn lock_or_recover<T>(lock: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    match lock.lock() {
        Ok(guard) => guard,
        Err(poisoned) => poisoned.into_inner(),
    }
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
    if lock_or_recover(engines()).contains_key(&id) {
        return Ok(());
    }
    // Serialize concurrent first calls (mpv_available + a first load racing).
    let _guard = lock_or_recover(&INIT_GUARD);
    if lock_or_recover(engines()).contains_key(&id) {
        return Ok(());
    }
    match build_engine(app, id) {
        Ok(engine) => {
            lock_or_recover(engines()).insert(id, engine);
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

/// The engine's private per-user runtime dir — where the materialized
/// ks-osc.lua script lives. NEVER the shared temp dir: mpv Lua has
/// os.execute, a PREDICTABLE name in /tmp is a pre-create/symlink race on
/// multi-user Linux, and fs.protected_regular makes poisoning trivial
/// anyway. Linux prefers $XDG_RUNTIME_DIR/kappastream (0700 by systemd
/// convention) when it is set, absolute and exists; everything else falls
/// back to the per-user cache dir.
fn select_runtime_base(xdg: Option<&str>, cache: PathBuf) -> PathBuf {
    match xdg {
        Some(dir) if Path::new(dir).is_absolute() && Path::new(dir).is_dir() => {
            Path::new(dir).join("kappastream")
        }
        _ => cache.join("mpv"),
    }
}

/// Create (or accept an existing) dir and lock it down: 0700 where the
/// platform has modes, and a REFUSAL (Err) when the path is a symlink or —
/// on Linux, where the shared-machine threat model lives — not owned by
/// the current uid. Engine init fails cleanly on refusal; the frontend
/// hides the engine (mpv_available false) rather than running degraded.
fn setup_private_dir(dir: &Path) -> Result<PathBuf, String> {
    let name = dir
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("runtime dir");
    if let Ok(meta) = std::fs::symlink_metadata(dir) {
        if meta.file_type().is_symlink() {
            return Err(format!("{name}: refusing a symlinked runtime dir"));
        }
    }
    std::fs::create_dir_all(dir).map_err(|e| format!("create {name}: {e}"))?;
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700))
            .map_err(|e| format!("chmod {name}: {e}"))?;
    }
    {
        use std::os::unix::fs::MetadataExt;
        let uid = unsafe { libc::getuid() };
        let owner = std::fs::metadata(dir)
            .map_err(|e| format!("stat {name}: {e}"))?
            .uid();
        if owner != uid {
            return Err(format!("{name}: runtime dir not owned by the current user"));
        }
    }
    Ok(dir.to_path_buf())
}

/// Write a file inside the private runtime dir with mode 0600 where the
/// platform has modes. Truncation is fine there: the dir is 0700 and ours.
fn write_private_file(path: &Path, contents: &[u8]) -> Result<(), String> {
    let name = path
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("file")
        .to_string();
    {
        use std::io::Write;
        use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
        let mut file = std::fs::OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(true)
            .mode(0o600)
            .open(path)
            .map_err(|e| format!("open {name}: {e}"))?;
        file.write_all(contents)
            .map_err(|e| format!("write {name}: {e}"))?;
        // `.mode()` only applies at creation — normalize a pre-existing
        // file that may carry a wider mode from an earlier write style.
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))
            .map_err(|e| format!("chmod {name}: {e}"))?;
        Ok(())
    }
}

fn ensure_private_runtime_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let cache = app
        .path()
        .app_cache_dir()
        .map_err(|e| format!("app cache dir: {e}"))?;
    let base = select_runtime_base(std::env::var("XDG_RUNTIME_DIR").ok().as_deref(), cache);
    setup_private_dir(&base)
}

fn build_engine(app: &AppHandle, id: u32) -> Result<Engine, String> {
    // Before ANY libmpv call — mpv_create checks the locale immediately.
    pin_c_numeric_locale();
    // Materialize the embedded OSD script into the PRIVATE per-user runtime
    // dir (see ensure_private_runtime_dir) — 0600, never the shared /tmp.
    let runtime_dir = ensure_private_runtime_dir(app)?;
    let osc_script = runtime_dir
        .join("kappastream-osc.lua")
        .to_str()
        .ok_or("runtime dir path not UTF-8")?
        .to_string();
    write_private_file(Path::new(&osc_script), KS_OSC_LUA.as_bytes())
        .map_err(|e| format!("write ks-osc.lua: {e}"))?;
    // Platform options that must apply at mpv-create time: Linux pins the
    // render API (vo=libmpv drawing into our GLArea — mpv never creates a
    // window of its own).
    let mpv: &'static Mpv = Box::leak(Box::new(
        Mpv::with_initializer(|init| {
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
            // player, so everything is explicit: the STOCK osc off,
            // ytdl_hook OFF (it would run yt-dlp against every loadfile
            // URL), default key bindings OFF (all real input arrives as
            // forwarded pointer events from the webview — mpv_pointer).
            // load-scripts=no suppresses every autoload path (the user's
            // ~/.config/mpv/scripts dir, ytdl_hook's own autoload) — the
            // explicit `scripts` entry below is NOT gated by it (verified
            // against libmpv 0.40: with load-scripts=no, a scripts= entry
            // still loads and dispatches).
            init.set_property("load-scripts", false)?;
            init.set_property("osc", false)?;
            // NOTE: the CLI's `--scripts-append` is a command-line-only
            // variant — the client API rejects the name ("option not
            // found", probed against this exact libmpv) — so the base
            // `scripts` list option carries our script instead.
            init.set_property("scripts", osc_script.as_str())?;
            init.set_property("ytdl", false)?;
            init.set_property("input-default-bindings", false)?;
            // The render signal runs on the GTK main thread (WebKitGTK's UI
            // thread, also where every sync invoke lands). mpv_render_context_
            // render() blocks until a frame's target display time unless this
            // option is 0 (render.h's documented remedy for render-API
            // embedders — MPV_RENDER_PARAM_BLOCK_FOR_TARGET_TIME defaults to
            // enabled, and libmpv2's render() wrapper passes no override), so
            // with the default 50 ms headroom every frame parks the whole UI
            // until its display time — up to a full frame interval per render
            // at video FPS, once per tile.
            init.set_property("video-timing-offset", 0.0)?;
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
        // The OSD/render size, cached for mpv_pointer's coordinate rescale
        // (observed instead of two get_property calls per pointermove).
        ("osd-width", libmpv2::Format::Int64),
        ("osd-height", libmpv2::Format::Int64),
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
        surface: Arc::from(surface),
        core_gate: Arc::new(AsyncMutex::new(())),
        overlay_suppressed: false,
        active: false,
        osd: (0, 0),
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

/// `mpv://aspect` — the display aspect of the current video, or None while
/// no video params exist (the consumer falls back to 16/9).
#[derive(Serialize, Clone)]
struct AspectPayload {
    id: u32,
    aspect: Option<f64>,
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

/// The display aspect (width/height) of the current video, normalized for
/// presentation. `video-params/aspect` IS the display aspect (DAR) — chosen
/// over dwidth/dheight, which would add two reads and a division for the
/// same number and become (un)available at exactly the same moments.
/// Rotation is applied at presentation, so 90/270 swap the displayed axes.
/// Returns None while no video is configured (callers fall back to 16/9).
fn video_display_aspect(mpv: &Mpv) -> Option<f64> {
    let a = mpv.get_property::<f64>("video-params/aspect").ok()?;
    if !a.is_finite() || a <= 0.0 {
        return None;
    }
    match mpv.get_property::<i64>("video-params/rotate").unwrap_or(0) {
        90 | 270 => Some(1.0 / a),
        _ => Some(a),
    }
}

fn spawn_event_thread(app: AppHandle, mpv: &'static Mpv, id: u32) {
    std::thread::spawn(move || {
        let mut throttle = TimeThrottle::new(TIME_EMIT_INTERVAL);
        let mut duration = 0f64;
        let mut last_state: DerivedState = None;
        let mut state_dirty = true;
        let mut last_aspect: Option<f64> = None;
        // The emit helper shared by the property path, the trailing flush
        // and the PlaybackRestart force-flush (`duration` is passed in so
        // the closure does not borrow the loop's mutable local).
        let emit_time = |position: f64, duration: f64| {
            let _ = app.emit(
                "mpv://time",
                TimePayload {
                    id,
                    position,
                    duration,
                },
            );
        };
        loop {
            // While a throttled value is pending, the wait ends no later
            // than its flush deadline (wait_event returns None on timeout),
            // so the trailing emit cannot strand on a quiet core.
            let event = mpv.wait_event(throttle.wait_timeout(Instant::now()));
            if let Some(v) = throttle.poll_flush(Instant::now()) {
                emit_time(v, duration);
            }
            let Some(event) = event else {
                continue;
            };
            match event {
                Ok(Event::PropertyChange { name, change, .. }) => match (name, change) {
                    ("time-pos", PropertyData::Double(p)) => {
                        if let Some(v) = throttle.offer(Instant::now(), p.max(0.0)) {
                            emit_time(v, duration);
                        }
                    }
                    ("duration", PropertyData::Double(d)) if d.is_finite() && d > 0.0 => {
                        duration = d;
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
                    // The cached OSD size mpv_pointer rescales by (observed
                    // instead of polled — a change arrives with every render
                    // size change). Brief locked writes only.
                    ("osd-width", PropertyData::Int64(w)) => {
                        if let Some(engine) = lock_or_recover(engines()).get_mut(&id) {
                            engine.osd.0 = w.max(0);
                        }
                    }
                    ("osd-height", PropertyData::Int64(h)) => {
                        if let Some(engine) = lock_or_recover(engines()).get_mut(&id) {
                            engine.osd.1 = h.max(0);
                        }
                    }
                    _ => {}
                },
                Ok(Event::Seek) => {
                    let _ = app.emit("mpv://seeking", id);
                    state_dirty = true;
                }
                Ok(Event::PlaybackRestart) => {
                    let _ = app.emit("mpv://seeked", id);
                    state_dirty = true;
                    // The position must land NOW, not at window expiry: a
                    // seek changes time-pos exactly once while paused (the
                    // change arrives just before this event), and the
                    // leading-edge throttle may have swallowed it — without
                    // this flush the UI would sit on the pre-seek position
                    // until playback resumes. force_flush emits the held
                    // value; if nothing was held (the property change lost
                    // the race), a fresh read takes its place.
                    let now = Instant::now();
                    let flushed = throttle.force_flush(now).or_else(|| {
                        mpv.get_property::<f64>("time-pos")
                            .ok()
                            .filter(|v| v.is_finite())
                            .map(|v| v.max(0.0))
                    });
                    if let Some(p) = flushed {
                        emit_time(p, duration);
                    }
                    // First frame presented (also fires on seeks/unpause —
                    // the surface's show path collapses repeats): reveal the
                    // native video surface. Until now it stayed hidden so
                    // the page's loading spinner / error overlays render
                    // normally instead of being covered by a black box.
                    // Suppressed while a blocking overlay owns the screen
                    // (mpv_set_surface_visible re-shows on its dismissal).
                    // The surface call runs OUTSIDE the lock (it dispatches
                    // to the GTK main thread).
                    let reveal = {
                        let mut engines = lock_or_recover(engines());
                        engines.get_mut(&id).and_then(|engine| {
                            engine.active = true;
                            if engine.overlay_suppressed {
                                None
                            } else {
                                Some(Arc::clone(&engine.surface))
                            }
                        })
                    };
                    if let Some(surface) = reveal {
                        surface.show();
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
                Ok(Event::VideoReconfig) => {
                    // The display aspect drives the shared content rect (the
                    // mpv surface rect AND every page overlay aligned to the
                    // video). Read it fresh on every reconfig instead of
                    // observing the property: an observed property's
                    // "became unavailable" change arrives with a NULL payload
                    // that libmpv2 maps to NO event, so observation could
                    // never see the params disappear — but a reconfig always
                    // fires when video appears, changes shape, or goes away.
                    // Deduped: reconfigs burst during startup.
                    let aspect = video_display_aspect(mpv);
                    if aspect != last_aspect {
                        last_aspect = aspect;
                        let _ = app.emit("mpv://aspect", AspectPayload { id, aspect });
                    }
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
                        // mpv composites via overlay-add. Two-phase on
                        // purpose: PREPARE under the engines lock (state
                        // mutation + pixel clones, no libmpv), then
                        // resample + overlay-add with NO lock held — a
                        // synchronous core call under the lock would stall
                        // every other command and worker behind the OSD's
                        // 16 Hz message stream. Best-effort — a failed
                        // overlay is a visual no-op, not an error the user
                        // can act on.
                        let cmds = {
                            let mut engines = lock_or_recover(engines());
                            match engines.get_mut(&id) {
                                Some(engine) => {
                                    engine.prepare_ks_overlay(&args[1..]).unwrap_or_default()
                                }
                                None => Vec::new(),
                            }
                        };
                        for cmd in cmds {
                            match cmd {
                                OverlayCmd::Issue(issue) => {
                                    match execute_overlay_issue(mpv, &issue) {
                                        Ok(entry) => record_overlay(id, issue.id, entry),
                                        Err(err) => eprintln!("[mpv] overlay-add: {err}"),
                                    }
                                }
                                OverlayCmd::Hide(overlay_id) => {
                                    let id_s = overlay_id.to_string();
                                    if let Err(err) =
                                        mpv.command("overlay-remove", &[id_s.as_str()])
                                    {
                                        eprintln!("[mpv] overlay-remove {overlay_id}: {err}");
                                    }
                                }
                            }
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
                // (a broadcast re-show must not un-hide a stopped engine),
                // and the cached OSD size is stale — clear it so pointer
                // events drop until it is re-established (a property-change
                // when the render size changes, or the one-shot live read
                // in mpv_pointer; a reload at an UNCHANGED size re-fires
                // nothing — libmpv2 maps the NULL payload to no event).
                if state.is_none() {
                    if let Some(engine) = lock_or_recover(engines()).get_mut(&id) {
                        engine.active = false;
                        engine.osd = (0, 0);
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

/// One overlay action prepared under the engines lock. `Issue` carries the
/// source pixels as an Arc clone plus the dedupe bookkeeping, so the
/// resample and the synchronous overlay-add run with NO lock held;
/// `record_overlay` re-takes it briefly to store the dedupe entry.
enum OverlayCmd {
    Issue(OverlayIssue),
    Hide(u8),
}

struct OverlayIssue {
    id: u8,
    /// Bitmap generation the issue is based on (part of the dedupe key).
    gen: u64,
    /// Content tag (thumbnail strip/tile indices); separates same-geometry
    /// different-content issuances.
    tag: u64,
    pos: (i32, i32),
    dims: (u32, u32),
    src: Arc<Vec<u8>>,
    src_dims: (u32, u32),
}

/// Resample `issue`'s source to the target dims and issue overlay-add —
/// lock-free by contract (see OverlayCmd). Returns the dedupe entry to
/// record on success.
///
/// overlay-add reads the bitmap straight from OUR memory: the `&<address>`
/// source (docs: aimed at libmpv embedders). mpv copies it during the
/// command and holds no reference after it returns — guaranteed since mpv
/// 0.18.1 and every libmpv we ship against is >= 0.35 (bookworm) — and
/// libmpv2's command() wraps the SYNCHRONOUS mpv_command, so `scaled` is
/// guaranteed alive for the whole copy window and free to drop right after.
/// No bitmap file ever touches disk.
fn execute_overlay_issue(
    mpv: &'static Mpv,
    issue: &OverlayIssue,
) -> Result<(u64, u64, i32, i32, u32, u32), String> {
    let OverlayIssue {
        id,
        gen,
        tag,
        pos: (x, y),
        dims: (w, h),
        src,
        src_dims: (sw, sh),
    } = issue;
    let scaled = resample_bgra(src, *sw, *sh, *w, *h);
    let addr = format!("&{}", scaled.as_ptr() as usize);
    let args = [
        id.to_string(),
        x.to_string(),
        y.to_string(),
        addr,
        "0".to_string(),
        "bgra".to_string(),
        w.to_string(),
        h.to_string(),
        (w * 4).to_string(),
    ];
    let argv: Vec<&str> = args.iter().map(String::as_str).collect();
    mpv.command("overlay-add", &argv)
        .map_err(|e| format!("overlay-add: {e}"))?;
    Ok((*gen, *tag, *x, *y, *w, *h))
}

/// Record a successful overlay issuance in the engine's dedupe map (brief
/// lock; a vanished engine just drops the entry).
fn record_overlay(id: u32, overlay_id: u8, entry: (u64, u64, i32, i32, u32, u32)) {
    if let Some(engine) = lock_or_recover(engines()).get_mut(&id) {
        engine.overlays.insert(overlay_id, entry);
    }
}

/// Dedupe + source lookup for one overlay (re)issuance. Ok(None) = nothing
/// to do (the OSD's 16 Hz render tick sent identical geometry); Err = the
/// bitmap is not decoded yet.
#[allow(clippy::too_many_arguments)] // the issue's full parameter set, mirroring show/issue
fn prepare_overlay_issue(
    overlays: &HashMap<u8, (u64, u64, i32, i32, u32, u32)>,
    bitmaps: &HashMap<String, CachedBitmap>,
    id: u8,
    key: &str,
    tag: u64,
    pos: (i32, i32),
    dims: (u32, u32),
    gen: u64,
) -> Result<Option<OverlayIssue>, String> {
    let (x, y) = pos;
    let (w, h) = dims;
    if overlays.get(&id) == Some(&(gen, tag, x, y, w, h)) {
        return Ok(None); // the OSD's 16 Hz render tick sends identical geometry
    }
    let bmp = bitmaps
        .get(key)
        .ok_or_else(|| format!("no bitmap '{key}' (not decoded yet)"))?;
    Ok(Some(OverlayIssue {
        id,
        gen,
        tag,
        pos,
        dims,
        src: Arc::clone(&bmp.bgra),
        src_dims: (bmp.w, bmp.h),
    }))
}

impl Engine {
    /// `ks-overlay <thumb|page|infoblock> <show args…|hide>` — see ks-osc.lua.
    /// PREPARE ONLY: mutates engine state and returns the actions to run
    /// OUTSIDE the engines lock (resample + overlay-add via
    /// OverlayCmd::Issue; overlay-remove via OverlayCmd::Hide). The one
    /// piece of pixel work kept in here is the storyboard tile CROP —
    /// bounded by the tile size (a few hundred KB at most), unlike the
    /// display-sized resample it feeds.
    fn prepare_ks_overlay(&mut self, p: &[&str]) -> Result<Vec<OverlayCmd>, String> {
        let geti = |i: usize| -> Result<i64, String> {
            p.get(i)
                .and_then(|s| s.parse::<i64>().ok())
                .ok_or_else(|| format!("bad ks-overlay arg {i}: {p:?}"))
        };
        match (p.first().copied(), p.get(1).copied()) {
            (Some("thumb"), Some("show")) => self.prepare_thumb(
                geti(2)? as i32,
                geti(3)? as i32,
                geti(4)?.max(1) as u32,
                geti(5)?.max(1) as u32,
                geti(6)?.max(0) as u32,
                geti(7)?.max(0) as u32,
            ),
            (Some("thumb"), Some("hide")) => self.prepare_hide(OVERLAY_THUMB),
            (Some("page"), Some("show")) => {
                let pos = (geti(2)? as i32, geti(3)? as i32);
                let dims = (geti(4)?.max(1) as u32, geti(5)?.max(1) as u32);
                self.page_geo = Some((pos, dims));
                match prepare_overlay_issue(
                    &self.overlays,
                    &self.bitmaps,
                    OVERLAY_PAGE,
                    "page",
                    0,
                    pos,
                    dims,
                    self.bitmap_gen,
                ) {
                    // Expected ONCE per dialog: the geometry message races
                    // the first snapshot; the snapshot's completion re-issues
                    // from page_geo.
                    Err(_) if !self.bitmaps.contains_key("page") => Ok(Vec::new()),
                    res => res.map(|issue| issue.into_iter().map(OverlayCmd::Issue).collect()),
                }
            }
            (Some("page"), Some("hide")) => {
                self.page_geo = None;
                self.prepare_hide(OVERLAY_PAGE)
            }
            (Some("infoblock"), Some("show")) => {
                let pos = (geti(2)? as i32, geti(3)? as i32);
                let dims = (geti(4)?.max(1) as u32, geti(5)?.max(1) as u32);
                prepare_overlay_issue(
                    &self.overlays,
                    &self.bitmaps,
                    OVERLAY_INFOBLOCK,
                    "infoblock",
                    0,
                    pos,
                    dims,
                    self.bitmap_gen,
                )
                .map(|issue| issue.into_iter().map(OverlayCmd::Issue).collect())
            }
            (Some("infoblock"), Some("hide")) => self.prepare_hide(OVERLAY_INFOBLOCK),
            _ => Err(format!("bad ks-overlay: {p:?}")),
        }
    }

    fn prepare_thumb(
        &mut self,
        x: i32,
        y: i32,
        w: u32,
        h: u32,
        strip: u32,
        tile: u32,
    ) -> Result<Vec<OverlayCmd>, String> {
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
        // Stage the crop as a transient bitmap under a private key, then
        // issue through the common path.
        let staged = Arc::new(cropped);
        self.bitmaps.insert(
            "thumb:current".to_string(),
            CachedBitmap {
                bgra: Arc::clone(&staged),
                w: tw,
                h: th,
                grid: None,
            },
        );
        // Any bitmap insert bumps the generation; make sure THIS one is the
        // latest so the dedupe below sees it as current.
        self.bitmap_gen += 1;
        prepare_overlay_issue(
            &self.overlays,
            &self.bitmaps,
            OVERLAY_THUMB,
            "thumb:current",
            (u64::from(strip) << 32) | u64::from(tile),
            (x, y),
            (w, h),
            self.bitmap_gen,
        )
        .map(|issue| issue.into_iter().map(OverlayCmd::Issue).collect())
    }

    /// Hide bookkeeping: drop the dedupe entry now (so a later show cannot
    /// dedupe against it) and return the removal action.
    fn prepare_hide(&mut self, id: u8) -> Result<Vec<OverlayCmd>, String> {
        Ok(if self.overlays.remove(&id).is_some() {
            vec![OverlayCmd::Hide(id)]
        } else {
            Vec::new()
        })
    }

    /// Prepare the page-overlay re-issue a fresh snapshot completes into
    /// (see linux::store_page_snapshot). Called with the NEW bitmap already
    /// staged and `gen` set to the generation that insert bumped to.
    fn prepare_page_reissue(&mut self, gen: u64) -> Option<OverlayIssue> {
        let (pos, dims) = self.page_geo?;
        prepare_overlay_issue(
            &self.overlays,
            &self.bitmaps,
            OVERLAY_PAGE,
            "page",
            0,
            pos,
            dims,
            gen,
        )
        .ok()
        .flatten()
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

/// Crop a rect out of a cairo ARGB32 image surface and pack it into
/// row-major BGRA. This is a PURE COPY of the pixel bytes: cairo ARGB32 is
/// little-endian `[B, G, R, A]` with PREMULTIPLIED alpha, and overlay-add's
/// `bgra` expects premultiplied pixels too (mpv input.rst: "every color
/// component is already multiplied with the alpha component"; straight-alpha
/// data violates that invariant and blends unpredictably per VO — darkened,
/// speckled fringes on antialiased edges). Only the crop/clamp/stride logic
/// lives here. The webview snapshot hands us the page exactly in that cairo
/// format. `crop` is (x, y, w, h) in snapshot pixels; it is clamped to the
/// image and an empty intersection yields an empty vec.
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
        out.extend_from_slice(&data[base..base + w * 4]);
    }
    out
}

/// One keep rect in BITMAP px, plus the element's uniform corner radius and
/// a bitset of the rect's corners that are the ELEMENT'S own (unclipped by
/// the surface) rounded corners — those get carved out of the mask, because
/// a rounded pill's bounding box shows the opaque page backdrop in its
/// corner wedges, which over the video composites as small dark corners.
struct KeepPx {
    x: usize,
    y: usize,
    w: usize,
    h: usize,
    r: usize,
    corners: u8,
}

/// Zero every packed premultiplied-BGRA pixel OUTSIDE the union of `keeps`
/// (bitmap px, clamped), carving flagged corners outside their rounding
/// radius. The page snapshot's crop box is the UNION BBOX of the
/// overlapping elements — regions inside the box but outside the elements
/// show the page's empty player, which would composite as an opaque dark
/// border around the UI. ALL FOUR bytes go to zero, not just alpha:
/// overlay-add blends premultiplied, where a pixel with a=0 but nonzero
/// color channels ADDS that color to the video (a dark haze box around the
/// tooltip). The corner carve exists because the mask is rectangular while
/// the elements are rounded pills; a corner the surface CLIPPED off is not
/// the element's own corner and is never carved, and a carved pixel
/// covered by a DIFFERENT keep survives (sibling strips may overlap).
/// Empty `keeps` leaves the bitmap untouched.
fn mask_keep_rects(bgra: &mut [u8], w: usize, h: usize, keeps: &[KeepPx]) {
    if keeps.is_empty() || w == 0 || h == 0 || bgra.len() < w * h * 4 {
        return;
    }
    let rects: Vec<(usize, usize, usize, usize)> = keeps
        .iter()
        .map(|k| {
            let x1 = k.x.min(w);
            let y1 = k.y.min(h);
            let x2 = k.x.saturating_add(k.w).min(w);
            let y2 = k.y.saturating_add(k.h).min(h);
            (x1, y1, x2, y2)
        })
        .collect();
    let mut mask = vec![0u8; w * h];
    for &(x1, y1, x2, y2) in &rects {
        for row in mask.chunks_exact_mut(w).skip(y1).take(y2 - y1) {
            row[x1..x2].fill(1);
        }
    }
    // Corner carve: pixel centers inside an r×r corner box but outside the
    // corner circle go, unless a different keep covers them.
    let inside_other = |px: usize, py: usize, skip: usize| -> bool {
        rects
            .iter()
            .enumerate()
            .any(|(i, &(x1, y1, x2, y2))| i != skip && px >= x1 && px < x2 && py >= y1 && py < y2)
    };
    for (i, k) in keeps.iter().enumerate() {
        let (x1, y1, x2, y2) = rects[i];
        // The radius cannot eat more than half the (possibly clamped) rect.
        let r = k.r.min((x2 - x1) / 2).min((y2 - y1) / 2);
        if r == 0 {
            continue;
        }
        let rf = r as f64;
        let corners = [
            ((k.corners & 1) != 0, x1 + r, y1 + r, x1, y1),
            ((k.corners & 2) != 0, x2 - r, y1 + r, x2 - r, y1),
            ((k.corners & 4) != 0, x1 + r, y2 - r, x1, y2 - r),
            ((k.corners & 8) != 0, x2 - r, y2 - r, x2 - r, y2 - r),
        ];
        for &(on, cx, cy, bx, by) in &corners {
            if !on {
                continue;
            }
            for py in by..by + r {
                for px in bx..bx + r {
                    if px >= w || py >= h {
                        continue;
                    }
                    let idx = py * w + px;
                    if mask[idx] == 0 || inside_other(px, py, i) {
                        continue;
                    }
                    let dx = px as f64 + 0.5 - cx as f64;
                    let dy = py as f64 + 0.5 - cy as f64;
                    if dx * dx + dy * dy > rf * rf {
                        mask[idx] = 0;
                    }
                }
            }
        }
    }
    for (px, keep) in bgra.as_chunks_mut::<4>().0.iter_mut().zip(mask) {
        if keep == 0 {
            *px = [0, 0, 0, 0];
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
    let x0 = (col * tile_w) as usize;
    // All offset math in checked usize: the row-offset product can exceed
    // u32 for corrupt strip dims, and a wrapped offset would slip a bogus
    // in-range slice past the src.len() guard below.
    let tile_len = (tile_w as usize).checked_mul(4)?;
    let cap = (tile_w as usize)
        .checked_mul(tile_h as usize)?
        .checked_mul(4)?;
    let mut out = Vec::with_capacity(cap);
    for y in 0..tile_h {
        let base = (row as usize * tile_h as usize + y as usize)
            .checked_mul(strip_w as usize)?
            .checked_add(x0)?
            .checked_mul(4)?;
        let end = base.checked_add(tile_len)?;
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
    let mut engines = lock_or_recover(engines());
    let engine = engines
        .get_mut(&id)
        .ok_or_else(|| "mpv engine unavailable".to_string())?;
    f(engine)
}

/// Run `f` against the engine's mpv core ON THE CALLING ASYNC-RUNTIME
/// THREAD — never the GTK main thread, which is the render thread (the
/// GLArea render callback) and WebKitGTK's UI thread, and per libmpv's
/// render.h threading contract must not call non-render core APIs or wait
/// behind threads that do. The per-engine gate serializes concurrent
/// commands (a tokio Mutex hands out lock() in request order); the strict
/// invoke-order the sync commands had still holds where it matters because
/// the frontend awaits every load, while the fire-and-forget commands
/// (pointer, volume, script feeds) are last-wins. Quick, synchronous
/// core calls are exactly what async Tauri commands are for; the surface
/// bootstrap (which needs the main thread) is separate — see
/// `ensure_engine`.
async fn with_core<R: Send>(
    id: u32,
    f: impl FnOnce(&'static Mpv) -> Result<R, String> + Send,
) -> Result<R, String> {
    let (gate, mpv) = {
        let engines = lock_or_recover(engines());
        let Some(engine) = engines.get(&id) else {
            return Err("mpv engine unavailable".to_string());
        };
        (Arc::clone(&engine.core_gate), engine.mpv)
    };
    let _guard = gate.lock().await;
    f(mpv)
}

/// Runtime availability probe result for the frontend. The probe always
/// RESOLVES — when the surface fails to init the `reason` carries the exact
/// error so Settings can display it instead of silently hiding the feature.
#[derive(Serialize, Clone)]
pub struct AvailabilityPayload {
    pub available: bool,
    pub reason: Option<String>,
}

/// Runtime availability probe for the frontend (also engine 0's eager
/// bootstrap: a first call creates the single-player core + surface). This
/// command only exists in Linux mpv-embed builds; every other build
/// registers the lib.rs `mpv_unavailable` stub, which resolves
/// available:false with a "not supported on this platform" reason (the
/// frontend also treats a missing command as "not available" for good
/// measure). The engine cannot be force-enabled anywhere it isn't
/// compiled in — there is no escape hatch by design.
///
/// Mixed command: the bootstrap builds GTK widgets + creates the render
/// context (main-thread work inside `with_webview`, which may block on the
/// GTK loop), so it runs through `spawn_blocking` instead of parking an
/// async worker.
#[tauri::command]
pub async fn mpv_available(app: AppHandle) -> AvailabilityPayload {
    let probe = tauri::async_runtime::spawn_blocking(move || ensure_engine(&app, 0)).await;
    match probe {
        Ok(Ok(())) => AvailabilityPayload {
            available: true,
            reason: None,
        },
        Ok(Err(reason)) => AvailabilityPayload {
            available: false,
            reason: Some(reason),
        },
        Err(join) => AvailabilityPayload {
            available: false,
            reason: Some(format!("engine bootstrap task failed: {join}")),
        },
    }
}

/// Load a media URL on the engine `id` (0 = single player, 1..=4 = tiles)
/// and show the surface. The URL is the STREAMLINK-RESOLVED one, passed
/// THROUGH directly — mpv is not a browser, so no ksvod proxy, no CORS.
/// `start_at` (VOD resume) becomes mpv's `start` load option — written on
/// every load ("none" without a resume) so a failed load can never leave a
/// stale offset armed; FileLoaded clears it too. Volume/muted are applied at
/// load (the engine may have been created by a bare availability probe
/// before the frontend ever set them), and `pause` is cleared at load so a
/// core paused for a previous item cannot start the new one frozen.
#[tauri::command]
#[allow(clippy::too_many_arguments)] // the load's full parameter set, mirroring mpv's own loadfile+options
pub async fn mpv_load(
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
    // host-family predicate the resolvers apply to streamlink's output —
    // and what reaches it is the validator's own serialization, never
    // the raw input: FFmpeg does not read URLs the way the WHATWG parser
    // validated them, so only the normalized form keeps both parsers on
    // the same host.
    let media_url = crate::resolve::validate_media_url(&url, &kind)?;
    // The engine (and the surface) must be up; a lazy first call is fine —
    // the frontend probes mpv_available at startup, which normally already
    // built engine 0, but a first-ever load (or a tile's first stream) must
    // also work. The bootstrap may block on the GTK main thread (widget
    // tree + render context), hence spawn_blocking.
    let id = engine_id(id)?;
    let app2 = app.clone();
    tauri::async_runtime::spawn_blocking(move || ensure_engine(&app2, id))
        .await
        .map_err(|e| format!("engine bootstrap task failed: {e}"))??;
    // All libmpv, no registry state: runs on the async runtime thread (off
    // the GTK main/render thread), FIFO per engine.
    with_core(id, move |mpv| {
        mpv.set_property("hwdec", hwdec.as_str())
            .map_err(|err| format!("set hwdec: {err}"))?;
        mpv.set_property("volume", volume.clamp(0.0, 1.0) * 100.0)
            .map_err(|err| format!("set volume: {err}"))?;
        mpv.set_property("mute", muted)
            .map_err(|err| format!("set mute: {err}"))?;
        // `pause` survives both `stop` and `loadfile … replace`, so a core
        // paused for the PREVIOUS item (user pause, then another channel /
        // VOD / quality, or a tile reusing the engine) would present the new
        // one as a frozen first frame while the frontend believes it is
        // playing. Every load implies the user wants playback — the
        // frontend clears its own pause-intent when a load starts.
        mpv.set_property("pause", false)
            .map_err(|err| format!("set pause: {err}"))?;
        // `start` is set EXPLICITLY on every load, "none" included: the
        // property is otherwise only cleared on FileLoaded, so a load that
        // fails before FileLoaded would leave a stale +N armed for the NEXT
        // loadfile — a live stream inheriting a dead VOD's resume offset.
        let start_prop = match start_at {
            Some(s) if s.is_finite() && s > 0.5 => format!("+{s:.3}"),
            _ => "none".to_string(),
        };
        mpv.set_property("start", start_prop)
            .map_err(|err| format!("set start: {err}"))?;
        mpv.command("loadfile", &[media_url.as_str(), "replace"])
            .map_err(|err| format!("loadfile: {err}"))?;
        // NOTE: the surface is NOT revealed here — the event thread shows it
        // on the first PlaybackRestart (first frame presented), so the page's
        // loading/error overlays aren't covered by a black video box during
        // load.
        Ok(())
    })
    .await
}

/// Stop playback and hide the surface (the transparent page region goes back
/// to opaque). Safe (and a no-op) when the engine never came up — the
/// frontend calls this on every teardown.
#[tauri::command]
pub async fn mpv_stop(id: Option<u32>) -> Result<(), String> {
    let id = engine_id(id)?;
    // Quiet no-op without an engine. The core call runs on the async
    // runtime thread; the GTK-side hide marshals itself.
    if engine_handle_opt(id).is_none() {
        return Ok(());
    }
    if let Some(e) = lock_or_recover(engines()).get_mut(&id) {
        e.active = false;
    }
    // The stop is best-effort like before (teardown paths call this
    // unconditionally; a core that is already idle must not turn into an
    // error the frontend would surface).
    if let Err(err) = with_core(id, move |mpv| {
        mpv.command("stop", &[]).map_err(|e| e.to_string())
    })
    .await
    {
        eprintln!("[mpv] stop: {err}");
    }
    if let Some(engine) = engine_handle_opt(id) {
        engine.surface.hide();
    }
    Ok(())
}

#[tauri::command]
pub async fn mpv_set_paused(id: Option<u32>, paused: bool) -> Result<(), String> {
    with_core(engine_id(id)?, move |mpv| {
        mpv.set_property("pause", paused)
            .map_err(|err| format!("set pause: {err}"))
    })
    .await
}

/// Absolute seek in seconds.
#[tauri::command]
pub async fn mpv_seek(id: Option<u32>, seconds: f64) -> Result<(), String> {
    let target = format!("{:.3}", seconds.max(0.0));
    with_core(engine_id(id)?, move |mpv| {
        mpv.command("seek", &[target.as_str(), "absolute"])
            .map_err(|err| format!("seek: {err}"))
    })
    .await
}

/// Volume 0..1 (mpv's property is 0..100).
#[tauri::command]
pub async fn mpv_set_volume(id: Option<u32>, volume: f64) -> Result<(), String> {
    let v = volume.clamp(0.0, 1.0) * 100.0;
    with_core(engine_id(id)?, move |mpv| {
        mpv.set_property("volume", v)
            .map_err(|err| format!("set volume: {err}"))
    })
    .await
}

#[tauri::command]
pub async fn mpv_set_muted(id: Option<u32>, muted: bool) -> Result<(), String> {
    with_core(engine_id(id)?, move |mpv| {
        mpv.set_property("mute", muted)
            .map_err(|err| format!("set mute: {err}"))
    })
    .await
}

/// Position the surface (logical px, window-relative, zoom-adjusted by the
/// frontend). Cheap: the surface marshals to the UI thread itself, so this
/// never blocks the caller. GTK-ONLY (no libmpv): stays a sync command —
/// running on the main thread is correct for it. `fold_top` is the number
/// of picture rows hidden ABOVE the rect: the page scrolled the fold under
/// the top bar, and the surface — a native window ABOVE the page, blind to
/// the page's overflow clip — was sized to the still-visible part. The
/// engine clips those rows at PRESENTATION time (Linux: mpv renders the
/// full unfolded picture into a constant-size offscreen and a 1:1 blit
/// presents only the visible band — see OffscreenTarget in linux.rs), so
/// the clip always lands on the same frame as the window resize: the same
/// pixels the webview engine shows under the bar, with no mis-fitted
/// transitional frame.
#[tauri::command]
pub fn mpv_set_rect(
    id: Option<u32>,
    x: i32,
    y: i32,
    w: i32,
    h: i32,
    fold_top: Option<i32>,
) -> Result<(), String> {
    // Pure GTK marshaling (the surface dispatches to the UI thread itself):
    // a brief lock to clone the surface handle, never held across the call.
    let surface = engine_handle(engine_id(id)?)?.surface;
    surface.set_rect(x, y, w, h, fold_top.unwrap_or(0));
    Ok(())
}

/// Forward a pointer event over the native video into mpv's input queue —
/// the ONLY way to interact with mpv's on-screen controller (the OSC lives
/// in mpv's OSD; the webview's pointer events land on the page UNDER the
/// native surface). Coordinates are NORMALIZED within the video surface
/// rect (0..1) and rescaled here by mpv's own OSD dimensions (== the
/// render size), so a webview-vs-GDK scale mismatch can never desync the
/// mapping. `kind`: "move" | "click" (button 0) | "wheel-up" | "wheel-down".
/// Pointer-normalization size: the cached pair when valid, else the freshly
/// read one. `None` = unusable, the event drops. Pure, unit-tested.
fn resolve_osd_dims(cached: (i64, i64), live: Result<(i64, i64), String>) -> Option<(i64, i64)> {
    if cached.0 > 0 && cached.1 > 0 {
        return Some(cached);
    }
    match live {
        Ok((w, h)) if w > 0 && h > 0 => Some((w, h)),
        _ => None,
    }
}

#[tauri::command]
pub async fn mpv_pointer(id: Option<u32>, x: f64, y: f64, kind: String) -> Result<(), String> {
    let id = engine_id(id)?;
    let engine = engine_handle(id)?;
    // The cached osd-width/height (observed by the event thread) replaces
    // the two get_property calls this used to make per event. A cache of 0
    // needs healing, not just dropping: idle clears it, and a reload at an
    // UNCHANGED render size never re-fires the property (1920→1920 is no
    // change; the idle NULL payload maps to no event at all) — the first
    // event after the reload reads the live pair once, and a valid result
    // caches itself so later events take the cached path again. Both
    // unavailable = nothing to hit-test yet, drop. (Deliberately NOT a
    // fallback to the window rect: if the vo ever reports 0x0 while
    // rendering, the CORRECT source has to be established first, not
    // papered over.)
    let mut osd = engine.osd;
    if osd.0 <= 0 || osd.1 <= 0 {
        let live = with_core(id, |mpv| {
            let w = mpv
                .get_property::<i64>("osd-width")
                .map_err(|e| e.to_string())?;
            let h = mpv
                .get_property::<i64>("osd-height")
                .map_err(|e| e.to_string())?;
            Ok((w, h))
        })
        .await;
        match resolve_osd_dims(osd, live) {
            Some(pair) => {
                if let Some(e) = lock_or_recover(engines()).get_mut(&id) {
                    e.osd = pair;
                }
                osd = pair;
            }
            None => return Ok(()),
        }
    }
    let osd_w = osd.0;
    let osd_h = osd.1;
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
    with_core(id, move |mpv| {
        let argv: Vec<&str> = args.iter().map(String::as_str).collect();
        mpv.command(cmd, &argv)
            .map_err(|err| format!("{cmd}: {err}"))
    })
    .await
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
/// unconditionally). GTK-ONLY (no libmpv): stays a sync command — the
/// surface calls dispatch to the main thread from wherever they run.
#[tauri::command]
pub fn mpv_set_surface_visible(visible: bool) -> Result<(), String> {
    // Under the lock: flip each engine's suppression flag + collect the
    // show/hide decisions. The surface calls run OUTSIDE it (each dispatches
    // to the GTK main thread).
    let actions: Vec<(Arc<dyn VideoSurface>, bool)> = {
        let mut engines = lock_or_recover(engines());
        engines
            .values_mut()
            .map(|engine| {
                engine.overlay_suppressed = !visible;
                (Arc::clone(&engine.surface), visible && engine.active)
            })
            .collect()
    };
    for (surface, show) in actions {
        if show {
            surface.show();
        } else {
            surface.hide();
        }
    }
    Ok(())
}

/// Send a script message to the embedded OSD script (ks-osc.lua) — the
/// app-side data feed: stream info, theme colors, the quality list, and
/// the pip/theater/fullscreen highlight states. Args pass through
/// verbatim; args[0] is the message name ("ks-info", "ks-theme", …).
#[tauri::command]
pub async fn mpv_script_msg(id: Option<u32>, args: Vec<String>) -> Result<(), String> {
    if args.is_empty() {
        return Err("empty script message".to_string());
    }
    with_core(engine_id(id)?, move |mpv| {
        let argv: Vec<&str> = args.iter().map(String::as_str).collect();
        mpv.command("script-message", &argv)
            .map_err(|err| format!("script-message: {err}"))
    })
    .await
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
/// elements. Each keep is flat `x, y, w, h, radius, corners`: the corner
/// radius and a bitset (1=TL 2=TR 4=BL 8=BR) of the element's own
/// (unclipped) rounded corners, carved out of the mask so a rounded
/// pill's bounding-box wedges can't composite as dark corners over the
/// video. Empty/absent = keep everything.
///
/// Returns Ok(false) when the request was COALESCED (per-engine window,
/// see linux::PAGE_SNAPSHOT_LAST): the frontend retries after the window
/// expires, so a dropped FINAL request of a move can never strand the
/// overlay on stale geometry. Ok(true) = accepted (the store dedupes an
/// identical frame); Ok(false) = coalesced, retry.
///
/// GTK/WEBVIEW-ONLY (no libmpv): stays a sync command — on the main
/// thread, `with_webview` runs its closure inline, which is exactly where
/// the WebKit snapshot API wants to be called.
#[tauri::command]
pub fn mpv_page_snapshot(
    app: AppHandle,
    id: Option<u32>,
    x: i32,
    y: i32,
    w: i32,
    h: i32,
    keep: Option<Vec<i32>>,
) -> Result<bool, String> {
    if x < 0 || y < 0 || w < 1 || h < 1 {
        return Err("snapshot rect must be non-negative with w/h >= 1".to_string());
    }
    if let Some(flat) = &keep {
        if flat.len() % 6 != 0 {
            return Err("keep must be flat x,y,w,h,radius,corners rects".to_string());
        }
    }
    linux::page_snapshot(&app, engine_id(id)?, x, y, w, h, keep.unwrap_or_default())
}

/// Upload an OSD image bitmap (base64 BGRA + dims; storyboard strips also
/// carry their cols × rows tile grid). The webview decodes what it already
/// has (the info block; storyboard strips via the ksvod proxy) — Rust
/// never fetches anything. ks-osc.lua later drives the actual on-screen
/// overlay geometry via `ks-overlay` script messages.
///
/// STATE-ONLY (no libmpv, no GTK — a decode plus a brief locked insert):
/// stays a sync command.
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
    // The w*h*4 product must be checked, not wrapped: e.g. w == h == 2^31
    // wraps to exactly 0 on a 64-bit usize, an empty payload then passes
    // the length check, and the composite-time resample indexes out of
    // range on the absurd cached dims.
    let expected = (w as usize)
        .checked_mul(h as usize)
        .and_then(|px| px.checked_mul(4))
        .ok_or_else(|| format!("bitmap '{key}' dims {w}x{h} overflow"))?;
    if bgra.len() != expected {
        return Err(format!(
            "bitmap '{}' payload {} B does not match {w}x{h} BGRA",
            key,
            bgra.len()
        ));
    }
    // A brief locked section stages the bitmap (the generation bump is what
    // forces the next overlay message to re-issue with the new pixels).
    with_engine(engine_id(id)?, |e| {
        e.bitmap_gen += 1;
        e.bitmaps.insert(
            key,
            CachedBitmap {
                bgra: Arc::new(bgra),
                w,
                h,
                grid,
            },
        );
        Ok(())
    })
}

#[cfg(all(test, feature = "mpv-embed"))]
mod tests {
    use super::*;

    #[test]
    fn mpv_user_agent_is_the_shared_browser_const() {
        // The engine must present the SAME UA as the GQL proxy — a second,
        // app-specific string (the old "streamlink/7.2.0") would be sent by
        // nobody else and fingerprint every install at Twitch's CDN.
        assert_eq!(MPV_USER_AGENT, crate::gql::USER_AGENT);
        assert!(crate::gql::USER_AGENT.starts_with("Mozilla/5.0"));
        assert!(!crate::gql::USER_AGENT.to_lowercase().contains("streamlink"));
        assert!(!crate::gql::USER_AGENT.contains("Kappastream"));
    }

    #[test]
    fn osd_dims_prefer_the_cache_and_heal_from_a_live_read() {
        // Steady state: a valid cache wins without touching the core.
        assert_eq!(
            resolve_osd_dims((1920, 1080), Err("engine gone".into())),
            Some((1920, 1080))
        );
        // The stranded-after-reload case: idle cleared the cache, but the
        // live read still knows the render size — use and re-cache it.
        assert_eq!(resolve_osd_dims((0, 0), Ok((1280, 720))), Some((1280, 720)));
        assert_eq!(
            resolve_osd_dims((1920, 0), Ok((1280, 720))),
            Some((1280, 720))
        );
        // Genuinely nothing to hit-test (fresh engine, never rendered).
        assert_eq!(resolve_osd_dims((0, 0), Ok((0, 0))), None);
        assert_eq!(resolve_osd_dims((0, 0), Err("unavailable".into())), None);
    }

    #[test]
    #[cfg(target_os = "linux")]
    fn runtime_base_prefers_a_live_xdg_dir() {
        let tmp = std::env::temp_dir().join(format!("ks-mpv-xdg-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&tmp);
        std::fs::create_dir_all(&tmp).unwrap();
        let cache = PathBuf::from("/nonexistent-cache");
        // set + absolute + existing → XDG wins
        assert_eq!(
            select_runtime_base(Some(tmp.to_str().unwrap()), cache.clone()),
            tmp.join("kappastream")
        );
        // relative, nonexistent or unset → the app cache dir
        assert_eq!(
            select_runtime_base(Some("relative/run"), cache.clone()),
            cache.join("mpv")
        );
        assert_eq!(
            select_runtime_base(Some("/definitely/not/here"), cache.clone()),
            cache.join("mpv")
        );
        assert_eq!(select_runtime_base(None, cache.clone()), cache.join("mpv"));
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    #[cfg(unix)]
    fn private_dir_is_restricted_and_refuses_symlinks() {
        use std::os::unix::fs::PermissionsExt;
        let base = std::env::temp_dir().join(format!("ks-mpv-privdir-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        std::fs::create_dir_all(&base).unwrap();

        // fresh creation lands 0700, not a symlink
        let dir = setup_private_dir(&base.join("rt")).unwrap();
        let meta = std::fs::symlink_metadata(&dir).unwrap();
        assert!(!meta.file_type().is_symlink());
        assert_eq!(meta.permissions().mode() & 0o777, 0o700);

        // files land 0600 — even when the path pre-exists with a wider mode
        let file = dir.join("f.bin");
        std::fs::write(&file, b"x").unwrap();
        std::fs::set_permissions(&file, std::fs::Permissions::from_mode(0o644)).unwrap();
        write_private_file(&file, b"y").unwrap();
        assert_eq!(
            std::fs::metadata(&file).unwrap().permissions().mode() & 0o777,
            0o600
        );

        // a symlinked runtime dir is refused outright (pre-create race)
        let real = base.join("real");
        std::fs::create_dir_all(&real).unwrap();
        let link = base.join("link");
        std::os::unix::fs::symlink(&real, &link).unwrap();
        assert!(setup_private_dir(&link).is_err());

        let _ = std::fs::remove_dir_all(&base);
    }

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
        // keeps its existing quiet no-op contract. mpv_stop is async
        // (off-main-thread core calls) — block_on drives it in tests.
        assert!(tauri::async_runtime::block_on(mpv_stop(None)).is_ok());
        assert!(tauri::async_runtime::block_on(mpv_stop(Some(u32::MAX))).is_err());
        assert!(tauri::async_runtime::block_on(mpv_stop(Some(5))).is_err());
        assert!(tauri::async_runtime::block_on(mpv_stop(Some(MAX_ENGINE_ID))).is_ok());
    }

    #[test]
    fn commands_fail_cleanly_without_an_engine() {
        // No engine exists in a test process (build_engine needs a Tauri
        // app handle): the registry must read empty and every command helper
        // must fail cleanly rather than panic. mpv_stop is the deliberate
        // exception — teardown paths call it unconditionally, so it must be
        // a quiet no-op (for every id).
        assert!(lock_or_recover(engines()).is_empty());
        assert!(with_engine(0, |_| Ok(())).is_err());
        assert!(with_engine(2, |_| Ok(())).is_err());
        assert!(tauri::async_runtime::block_on(mpv_stop(None)).is_ok());
        assert!(tauri::async_runtime::block_on(mpv_stop(Some(3))).is_ok());
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
        assert!(
            tauri::async_runtime::block_on(mpv_pointer(None, 0.5, 0.5, "move".to_string()))
                .is_err()
        );
        assert!(
            tauri::async_runtime::block_on(mpv_script_msg(None, Vec::<String>::new())).is_err()
        );
        assert!(
            tauri::async_runtime::block_on(mpv_script_msg(None, vec!["ks-page".to_string()]))
                .is_err()
        );
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

    fn keep(x: usize, y: usize, w: usize, h: usize, r: usize, corners: u8) -> KeepPx {
        KeepPx {
            x,
            y,
            w,
            h,
            r,
            corners,
        }
    }

    #[test]
    fn keep_rect_masking_zeroes_outside_pixels_whole() {
        // 3x2 bitmap, all opaque; keep the left column and the bottom-right
        // pixel — everything else must end FULLY zeroed. All four bytes, not
        // just alpha: overlay-add blends premultiplied, and a=0 pixels with
        // leftover color channels add that color to the video.
        let mut bgra = vec![0xEEu8; 3 * 2 * 4];
        mask_keep_rects(
            &mut bgra,
            3,
            2,
            &[keep(0, 0, 1, 2, 0, 0), keep(2, 1, 1, 1, 0, 0)],
        );
        let px = |i: usize| &bgra[i * 4..i * 4 + 4];
        assert_eq!(px(0), &[0xEE; 4]); // (0,0) kept
        assert_eq!(px(1), &[0, 0, 0, 0]); // (1,0) outside
        assert_eq!(px(2), &[0, 0, 0, 0]); // (2,0) outside
        assert_eq!(px(3), &[0xEE; 4]); // (0,1) kept
        assert_eq!(px(4), &[0, 0, 0, 0]); // (1,1) outside
        assert_eq!(px(5), &[0xEE; 4]); // (2,1) kept — overlapping/clamped rect
                                       // Out-of-bounds keeps clamp; empty keeps leave everything opaque.
        let mut untouched = vec![0xEEu8; 4];
        mask_keep_rects(&mut untouched, 1, 1, &[]);
        assert_eq!(untouched, vec![0xEE; 4]);
        mask_keep_rects(&mut untouched, 1, 1, &[keep(9, 9, 5, 5, 0, 0)]);
        assert_eq!(untouched, vec![0, 0, 0, 0]);
    }

    #[test]
    fn keep_rect_masking_carves_flagged_rounded_corners() {
        // 7x7 keep, r=3, ONLY the top-left corner flagged: pixel centers
        // outside the corner circle (center (3,3), radius 3) get carved,
        // the other three corners stay square.
        let mut bgra = vec![0xEEu8; 7 * 7 * 4];
        mask_keep_rects(&mut bgra, 7, 7, &[keep(0, 0, 7, 7, 3, 1)]);
        let kept = |x: usize, y: usize| bgra[(y * 7 + x) * 4..(y * 7 + x) * 4 + 4] == [0xEE; 4];
        assert!(!kept(0, 0)); // dx=dy=-2.5 → 12.5 > 9
        assert!(kept(1, 0)); // 8.5 ≤ 9 — inside the circle
        assert!(kept(0, 1));
        assert!(kept(1, 1));
        assert!(kept(0, 2)); // 6.5 ≤ 9
        assert!(kept(2, 0));
        assert!(kept(6, 0)); // TR not flagged — square
        assert!(kept(0, 6)); // BL not flagged
        assert!(kept(6, 6)); // BR not flagged
        assert!(kept(3, 3)); // deep inside

        // Radius caps at half the clamped extent: r=3 on a 3x2 keep acts as
        // r=1, whose only corner pixel center (0.5,0.5) sits inside the
        // circle — nothing is carved.
        let mut capped = vec![0xEEu8; 3 * 2 * 4];
        mask_keep_rects(&mut capped, 3, 2, &[keep(0, 0, 3, 2, 3, 15)]);
        assert!(capped.iter().all(|&b| b == 0xEE));

        // A carved corner covered by a DIFFERENT keep survives (sibling
        // strips may overlap): B's 2x2 rect covers A's top-left notch.
        let mut overlap = vec![0xEEu8; 7 * 7 * 4];
        mask_keep_rects(
            &mut overlap,
            7,
            7,
            &[keep(0, 0, 7, 7, 3, 1), keep(0, 0, 2, 2, 0, 0)],
        );
        let still_kept =
            |x: usize, y: usize| overlap[(y * 7 + x) * 4..(y * 7 + x) * 4 + 4] == [0xEE; 4];
        for &(x, y) in &[(0, 0), (1, 0), (0, 1), (1, 1)] {
            assert!(still_kept(x, y), "sibling-covered pixel ({x},{y}) carved");
        }
    }

    #[test]
    fn argb32_crop_passes_premultiplied_and_clamps() {
        // 2x2 ARGB32 image, stride padded to 12 B (one phantom column):
        //   opaque red | 50% blue (premult b=64,a=128)
        //   transparent| opaque white
        let mut data = vec![0u8; 2 * 12];
        data[0..4].copy_from_slice(&[0x00, 0x00, 0xFF, 0xFF]); // red, opaque
        data[4..8].copy_from_slice(&[0x40, 0x00, 0x00, 0x80]); // premult blue
        let row2 = &mut data[12..]; // second row (past the 12 B stride)
        row2[0..4].copy_from_slice(&[0x00, 0x00, 0x00, 0x00]); // empty
        row2[4..8].copy_from_slice(&[0xFF, 0xFF, 0xFF, 0xFF]); // white
                                                               // Full crop: the premultiplied bytes pass through UNTOUCHED —
                                                               // cairo ARGB32 and overlay-add's bgra are the same
                                                               // (premultiplied) format, so converting alpha would break
                                                               // antialiased pixels for every consumer.
        assert_eq!(
            argb32_crop_to_bgra(&data, 12, 2, 2, (0, 0, 2, 2)),
            vec![
                0x00, 0x00, 0xFF, 0xFF, //
                0x40, 0x00, 0x00, 0x80, //
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

    #[test]
    fn crop_tile_rejects_offsets_that_wrap_or_exceed_src() {
        // 1px tiles in a 65536-wide strip: row 16384's true byte offset is
        // 2^32, which wraps to 0 in u32 arithmetic — the guard must see the
        // REAL offset and reject, not slice row 0's bytes as if they were
        // row 16384's.
        let src = [1u8, 2, 3, 4];
        assert!(crop_tile_bgra(&src, 65536, 16385, 1, 1, 16384 * 65536).is_none());
        // Absurd tile dims that overflow the capacity math: rejected, never
        // a wrapped under-allocation.
        assert!(crop_tile_bgra(&src, 1 << 31, 1 << 31, 1 << 31, 1 << 31, 0).is_none());
    }

    #[test]
    fn time_throttle_leads_immediately_and_holds_the_last_dropped_value() {
        let t0 = Instant::now();
        let mut th = TimeThrottle::new(TIME_EMIT_INTERVAL);
        // The very first value emits immediately.
        assert_eq!(th.offer(t0, 1.0), Some(1.0));
        // Values inside the window are held; only the LAST survives.
        assert_eq!(th.offer(t0 + Duration::from_millis(50), 2.0), None);
        assert_eq!(th.offer(t0 + Duration::from_millis(100), 3.0), None);
        assert_eq!(th.offer(t0 + Duration::from_millis(150), 4.0), None);
        // Still inside the window: nothing to flush.
        assert_eq!(th.poll_flush(t0 + Duration::from_millis(150)), None);
        // At expiry the held value emits; a second poll is empty.
        assert_eq!(th.poll_flush(t0 + TIME_EMIT_INTERVAL), Some(4.0));
        assert_eq!(th.poll_flush(t0 + TIME_EMIT_INTERVAL * 2), None);
        // After the window, an offer emits immediately again.
        assert_eq!(th.offer(t0 + TIME_EMIT_INTERVAL * 2, 5.0), Some(5.0));
    }

    #[test]
    fn time_throttle_waits_only_while_a_value_is_pending() {
        let t0 = Instant::now();
        let mut th = TimeThrottle::new(TIME_EMIT_INTERVAL);
        // No emit yet: block indefinitely.
        assert_eq!(th.wait_timeout(t0), -1.0);
        th.offer(t0, 1.0);
        // Emitted immediately, nothing held: still indefinite.
        assert_eq!(th.wait_timeout(t0 + Duration::from_millis(10)), -1.0);
        th.offer(t0 + Duration::from_millis(10), 2.0);
        // Held value: wait at most the rest of the window.
        let remaining = th.wait_timeout(t0 + Duration::from_millis(60));
        assert!(
            remaining > 0.0 && remaining <= 0.191, // window rest + the 1 ms wait epsilon
            "remaining: {remaining}"
        );
        // Once flushed, back to indefinite.
        assert!(th.poll_flush(t0 + TIME_EMIT_INTERVAL).is_some());
        assert_eq!(th.wait_timeout(t0 + TIME_EMIT_INTERVAL), -1.0);
    }

    #[test]
    fn time_throttle_force_flush_emits_a_held_value_immediately() {
        // The PlaybackRestart path: a seek while paused lands while the
        // window is still open; the UI must not wait for the window to
        // expire.
        let t0 = Instant::now();
        let mut th = TimeThrottle::new(TIME_EMIT_INTERVAL);
        assert_eq!(th.offer(t0, 20.0), Some(20.0));
        assert_eq!(th.offer(t0 + Duration::from_millis(30), 26.0), None);
        assert_eq!(th.force_flush(t0 + Duration::from_millis(40)), Some(26.0));
        // The flush consumed the pending value AND reset the window.
        assert_eq!(th.force_flush(t0 + Duration::from_millis(45)), None);
        assert_eq!(th.offer(t0 + Duration::from_millis(50), 27.0), None);
        assert_eq!(th.force_flush(t0 + Duration::from_millis(60)), Some(27.0));
    }

    #[test]
    fn set_bitmap_rejects_dimension_products_that_wrap() {
        // w == h == 2^31 wraps w*h*4 to exactly 0 on a 64-bit usize, so an
        // empty payload used to pass the length check and hand the absurd
        // dims to the composite-time resample. The dims themselves must be
        // rejected up front (the engine-unavailable error would mean the
        // payload check passed).
        let err = mpv_set_bitmap(
            None,
            "infoblock".into(),
            String::new(),
            1 << 31,
            1 << 31,
            None,
            None,
        )
        .unwrap_err();
        assert!(err.contains("overflow"), "unexpected error: {err}");
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
