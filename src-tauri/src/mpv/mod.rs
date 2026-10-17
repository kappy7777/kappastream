// Embedded-libmpv video engine — LINUX-ONLY. Windows and macOS build no
// mpv code at all and run the hls.js engine exclusively; off-Linux support
// is out of scope rather than pending.
//
// When the `mpv-embed` Cargo feature is on AND the runtime toggle is on, the
// player renders through libmpv into a native surface layered BENEATH the
// webview (see linux.rs): the webview's backing goes alpha-transparent and
// the page carves "aperture" holes where video should show, so the HTML
// controls, banners and overlays paint over the video as ordinary DOM — the
// SAME markup on both engines; the engine draws no on-screen controller of
// its own. Multi-view tiles run the SAME engine (one mpv core per tile, ids
// 1..=4) under the same hole scheme. The PiP window stays on hls.js (out of
// scope by design).
//
// (History: the ORIGINAL original design drew the video ABOVE the opaque
// page with an input-transparent window. The later desktop-through approach
// — a transparent OS window plus a transparent page — is dead on this stack:
// WebKitGTK's webview surface never clears between frames, leaving stale
// copies wherever UI moved. The intra-window layout sidesteps that verdict
// entirely: the OS window stays opaque, only the webview layer above the
// video goes transparent.)
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
//     concurrent commands (fire-and-forget calls may arrive out of call
//     order — see `with_core`). The GTK-only mpv_set_rect stays sync —
//     running on the main thread is what it wants; the engine bootstrap
//     (widgets + render-context creation) runs on the main thread inside
//     `with_webview` by construction.
//   - The platform surface (the native window region mpv draws into) is
//     linux.rs behind the `VideoSurface` trait. Rects are LOGICAL (GDK)
//     pixels, already zoom-adjusted by the frontend.

use std::collections::HashMap;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

use libmpv2::events::{Event, PropertyData};
use libmpv2::Mpv;
use serde::Serialize;
use tauri::async_runtime::Mutex as AsyncMutex;
use tauri::{AppHandle, Emitter};

#[cfg(target_os = "linux")]
mod linux;
#[cfg(target_os = "linux")]
use linux as platform;
#[cfg(target_os = "linux")]
mod mpris;

/// The UA mpv presents when fetching the resolved media URLs: THE SAME
/// shared browser const the GQL proxy sends (gql::USER_AGENT) — an alias,
/// not a second copy. The previous "streamlink/7.2.0" was never streamlink's
/// session default (its http session sends a Firefox UA), nobody else sent
/// that exact string, and it fingerprinted every kappastream install at
/// Twitch's CDN. The alias exists so the drift test has two names to
/// compare.
const MPV_USER_AGENT: &str = crate::gql::USER_AGENT;

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
    /// (playback-session's attachMpv), and the fire-and-forget volume
    /// writes are last-wins by design.
    core_gate: Arc<AsyncMutex<()>>,
}

/// A cheaply-cloned handle to an engine's surface, copied out under the
/// engines lock in one brief grab. Callers must NOT hold the registry lock
/// across a libmpv call: the lock also guards the per-engine event threads
/// (wait_event), and one synchronous core call held under it stalls all of
/// them — and, for commands that run on the GTK main thread, squeezes the
/// render callback's own scheduling window. (The mpv core itself is
/// deliberately NOT part of this handle: core calls go through `with_core`,
/// which serializes per engine and runs off the main thread.)
#[derive(Clone)]
struct EngineHandle {
    surface: Arc<dyn VideoSurface>,
}

fn engine_handle(id: u32) -> Result<EngineHandle, String> {
    engine_handle_opt(id).ok_or_else(|| "mpv engine unavailable".to_string())
}

fn engine_handle_opt(id: u32) -> Option<EngineHandle> {
    lock_or_recover(engines()).get(&id).map(|e| EngineHandle {
        surface: Arc::clone(&e.surface),
    })
}

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
            mpris::ensure_started();
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

/// The engine loads NO scripts (the in-video OSD controller is retired —
/// controls are the page's HTML overlay): every mpv script/autoloading
/// option below is off, and nothing is materialized into a runtime dir.
fn build_engine(app: &AppHandle, id: u32) -> Result<Engine, String> {
    // Before ANY libmpv call — mpv_create checks the locale immediately.
    pin_c_numeric_locale();
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
            // No scripts of any kind: the in-video controls are the page's
            // HTML overlay, so every mpv scripting/autoplay option is off —
            // the STOCK osc, ytdl_hook (it would run yt-dlp against every
            // loadfile URL), default key bindings (all real input belongs
            // to the page), and every script autoloading path (the user's
            // ~/.config/mpv/scripts dir included). Builtin scripts (console,
            // stats) still load under load-scripts=no — that option only
            // stops script-directory autoloading — so they are switched off
            // too; tolerantly, because mpv renamed load-osd-console to
            // load-console after 0.40 and an unknown name must never fail
            // engine creation.
            init.set_property("load-scripts", false)?;
            init.set_property("osc", false)?;
            init.set_property("ytdl", false)?;
            init.set_property("input-default-bindings", false)?;
            let _ = init.set_property("load-stats-overlay", false);
            let _ = init.set_property("load-osd-console", false);
            let _ = init.set_property("load-console", false);
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
    /// clamped so the engine can't push the app past full volume).
    volume: f64,
    muted: bool,
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
                    // Engine-side volume/mute changes mirror back into the
                    // app (today just the echo of an app-side write; the
                    // in-engine slider that once drove this is retired).
                    // Read BOTH fresh so either property's change carries a
                    // consistent pair.
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
                    // The surface call runs INSIDE the lock: it only posts
                    // to the GTK main loop.
                    {
                        let engines = lock_or_recover(engines());
                        if let Some(engine) = engines.get(&id) {
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
                    // The ended file's duration must not leak into the next
                    // one: mpv://time payloads keep carrying `duration` until
                    // the next file reports its own, so a stale value would
                    // have the frontend size the next VOD's scrub bar with
                    // the previous VOD's length.
                    duration = 0.0;
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
                Err(e) => {
                    let err = Some(format!("{e}"));
                    if last_state.as_ref().map(|(s, _)| *s) != Some("error") {
                        last_state = Some(("error", err.clone()));
                        mpris::note_state(id, &Some(("error", err.clone())));
                        emit_state(id, &app, Some(("error", err)));
                    }
                }
                _ => {}
            }
            if state_dirty {
                state_dirty = false;
                let state = compute_state(mpv);
                mpris::note_state(id, &state);
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

/// Run `f` against the engine's mpv core ON THE CALLING ASYNC-RUNTIME
/// THREAD — never the GTK main thread, which is the render thread (the
/// GLArea render callback) and WebKitGTK's UI thread, and per libmpv's
/// render.h threading contract must not call non-render core APIs or wait
/// behind threads that do. The per-engine gate serializes concurrent
/// commands; the tokio Mutex is fair among WAITERS, but each async invoke
/// is its own spawned task, so two fire-and-forget volume writes can reach
/// the gate out of JS call order — an accepted window, since only adjacent
/// reordering of such transient inputs is possible. Strict order holds
/// wherever the frontend awaits the invoke (every load does). Quick,
/// synchronous core calls are exactly what async Tauri commands are for;
/// the surface bootstrap (which needs the main thread) is separate — see
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
/// `title` (channel / VOD / clip name) is recorded for the MPRIS metadata —
/// what desktop media widgets display.
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
    title: Option<String>,
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
    mpris::set_title(id, title);
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
    mpris::note_touched(engine_id(id)?);
    with_core(engine_id(id)?, move |mpv| {
        mpv.set_property("pause", paused)
            .map_err(|err| format!("set pause: {err}"))
    })
    .await
}

/// Absolute seek in seconds.
#[tauri::command]
pub async fn mpv_seek(id: Option<u32>, seconds: f64) -> Result<(), String> {
    mpris::note_touched(engine_id(id)?);
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
    mpris::note_touched(engine_id(id)?);
    let v = volume.clamp(0.0, 1.0) * 100.0;
    with_core(engine_id(id)?, move |mpv| {
        mpv.set_property("volume", v)
            .map_err(|err| format!("set volume: {err}"))
    })
    .await
}

#[tauri::command]
pub async fn mpv_set_muted(id: Option<u32>, muted: bool) -> Result<(), String> {
    mpris::note_touched(engine_id(id)?);
    with_core(engine_id(id)?, move |mpv| {
        mpv.set_property("mute", muted)
            .map_err(|err| format!("set mute: {err}"))
    })
    .await
}

/// Name the engine desktop media controls act on: the frontend mirrors the
/// audio-authority pointer here so MPRIS follows the same target as the
/// keyboard shortcuts (0 — the single-view player — is the default).
/// Nothing but a store: works before the MPRIS service ever started, and
/// the service reads the value lazily.
#[tauri::command]
pub fn mpris_set_authority(id: Option<u32>) {
    mpris::set_authority(engine_id(id).unwrap_or(0));
}

/// Cover art for an engine's desktop media-widget entry (MPRIS
/// mpris:artUrl): the frontend sends the channel's avatar URL (null
/// clears). The service downloads it into the app cache and serves a
/// file:// URI — GNOME Shell only renders local art. Best-effort: a
/// failed download leaves widgets on the app icon.
#[tauri::command]
pub fn mpris_set_art(
    app: tauri::AppHandle,
    id: Option<u32>,
    url: Option<String>,
) -> Result<(), String> {
    mpris::note_art(&app, engine_id(id)?, url)
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
        // app handle): the registry must read empty and the core-touching
        // commands must fail cleanly rather than panic. mpv_stop is the
        // deliberate exception — teardown paths call it unconditionally, so
        // it must be a quiet no-op (for every id).
        assert!(lock_or_recover(engines()).is_empty());
        assert!(engine_handle(0).is_err());
        assert!(engine_handle(2).is_err());
        assert!(tauri::async_runtime::block_on(mpv_stop(None)).is_ok());
        assert!(tauri::async_runtime::block_on(mpv_stop(Some(3))).is_ok());
        assert!(tauri::async_runtime::block_on(mpv_set_volume(Some(2), 0.5)).is_err());
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
