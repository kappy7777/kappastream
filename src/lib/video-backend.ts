// The video BACKEND abstraction: one interface over "something that plays a
// video and reports its state", so the player UI can drive either the
// in-webview <video> element (hls.js / native MP4 — HtmlVideoBackend) or a
// native engine underneath the webview (the experimental libmpv surface —
// MpvBackend, feature-gated). Everything that used to read the <video>
// element directly (App's stall/seek handlers, PlayerControls, the VOD
// resume machinery, the VOD chat replay) talks to this interface instead.
//
// The shape mirrors the HTMLMediaElement API it generalizes — currentTime /
// duration / paused reads, play/pause/seek/volume/mute writes, and the same
// event names the element fires — so HtmlVideoBackend is pure delegation and
// migrating the call sites changed no behaviour. The event set is exactly
// what the consumers listened for on the element (plus 'seeked'/'ended'/
// 'error', which the native backend needs); every listener in this codebase
// ignores the event object, so callbacks take no arguments.
//
// Buffering note: `buffered` is the element's buffered-end in seconds (the
// scrub bar's grey fill). The native backend reports 0 — there is no
// equivalent single number worth inventing for the experiment.

import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'

/** Events a backend can report. Same names as the HTMLMediaElement events. */
export type VideoBackendEvent =
  | 'timeupdate'
  | 'seeking'
  | 'seeked'
  | 'pause'
  | 'play'
  | 'playing'
  | 'waiting'
  | 'ended'
  | 'error'
  | 'durationchange'
  | 'volumechange'
  | 'progress'

export interface VideoBackend {
  /** Playback position in seconds (0 when unknown). */
  readonly currentTime: number
  /** Duration in seconds — NaN/Infinity for live streams, like the element. */
  readonly duration: number
  /** True while paused (or not yet started). */
  readonly paused: boolean
  /** Volume 0..1. */
  readonly volume: number
  readonly muted: boolean
  /** Seconds of buffered playback (end of the buffered range); 0 when none. */
  readonly buffered: number

  play(): Promise<void>
  pause(): void
  /** Seek to an absolute position in seconds (caller clamps). */
  seek(t: number): void
  setVolume(v: number): void
  setMuted(m: boolean): void

  /**
   * Subscribe to one event. Returns the unsubscribe function. The backend
   * keeps no registry of its own beyond what delegation requires; callers
   * own the subscription lifetime (Svelte $effect cleanup holds the handles).
   */
  on(event: VideoBackendEvent, cb: () => void): () => void

  /** Release backend-side resources. The <video> wrapper is a no-op. */
  dispose(): void
}

/**
 * The no-behaviour-change backend: pure delegation to the existing
 * <video> element. Events are the element's own DOM events (the names in
 * VideoBackendEvent are all standard MediaElement events), so `on` is
 * addEventListener and the getters are property reads — nothing is cached,
 * mirrored or synthesized.
 */
export class HtmlVideoBackend implements VideoBackend {
  /** The wrapped element (input surface + hls.js attach target). */
  readonly element: HTMLVideoElement

  constructor(element: HTMLVideoElement) {
    this.element = element
  }

  get currentTime(): number {
    return this.element.currentTime
  }
  get duration(): number {
    return this.element.duration
  }
  get paused(): boolean {
    return this.element.paused
  }
  get volume(): number {
    return this.element.volume
  }
  get muted(): boolean {
    return this.element.muted
  }
  get buffered(): number {
    const b = this.element.buffered
    try {
      return b.length > 0 ? b.end(b.length - 1) : 0
    } catch {
      return 0
    }
  }

  play(): Promise<void> {
    return this.element.play()
  }
  pause(): void {
    this.element.pause()
  }
  seek(t: number): void {
    this.element.currentTime = t
  }
  setVolume(v: number): void {
    this.element.volume = v
  }
  setMuted(m: boolean): void {
    this.element.muted = m
  }

  on(event: VideoBackendEvent, cb: () => void): () => void {
    this.element.addEventListener(event, cb)
    return () => {
      this.element.removeEventListener(event, cb)
    }
  }

  dispose(): void {
    // No backend-side state to release — subscriptions are element
    // listeners the callers unsubscribe themselves.
  }
}

// ---------------------------------------------------------------------------
// The native (embedded libmpv) backend — only reachable when the app shell
// is a LINUX mpv-embed build AND its surface initialized
// (invoke('mpv_available') === true). The engine is Linux-only (owner
// scope decision 2026-09-18): everywhere else the probe resolves false
// ("not supported on this platform") or the commands are not registered
// at all, so this backend is never selected and any invoke below would
// simply reject and be swallowed. See src-tauri/src/mpv/ for the Rust side.
//
// MULTI-ENGINE: the Rust host keeps one mpv core per surface id (0 = the
// single-stream player, 1..4 = multi-view tiles). Every `mpv://…` event
// payload carries the engine id; a backend instance is bound to ONE id and
// ignores every other engine's events.
// ---------------------------------------------------------------------------

/** The media kinds the Rust mpv_load command accepts. */
export type MpvMediaKind = 'live' | 'vod' | 'clip'

/** Result of the `mpv_available` probe. It always RESOLVES in builds that
 *  carry the Linux engine: on a failed init `reason` carries the
 *  Rust-side error (surfaced on a disabled Settings row). Builds without
 *  the engine resolve false with "not supported on this platform" — and a
 *  rejected invoke (a Linux build with the feature compiled out entirely)
 *  maps to the same conclusion. */
export interface MpvAvailability {
  available: boolean
  reason?: string | null
}

interface MpvStateEvent {
  id: number
  state: 'loading' | 'playing' | 'paused' | 'buffering' | 'ended' | 'error'
  error?: string
}

interface MpvTimeEvent {
  id: number
  position: number
  duration: number
}

/** `mpv://volume` payload — the OSC-driven volume/mute mirror (see below). */
interface MpvVolumeEvent {
  id: number
  volume: number
  muted: boolean
}

/** `mpv://action` payload — an OSD button press on engine `id`. */
export interface MpvActionEvent {
  id: number
  action: string
}

/** `mpv://seeking` / `mpv://seeked` payloads — just the engine id. */
type MpvIdEvent = number

function invokeErrorMessage(err: unknown): string {
  if (typeof err === 'string') return err
  if (err instanceof Error) return err.message
  return JSON.stringify(err)
}

export interface MpvLoadOptions {
  kind: MpvMediaKind
  /** mpv hwdec mode ('no' | 'auto-safe' | … — validated by Settings). */
  hwdec: string
  /** Resume position for VODs (mpv's `start` load option). */
  startAt?: number
  /**
   * Load-time audio state. Defaults to the backend's local mirror (which
   * call sites that keep a persistent backend — the single player — keep
   * current). Surfaces whose model lives elsewhere (tiles) MUST pass the
   * model-driven values: a load with the local default (unmuted) both plays
   * audio prematurely and echoes back as a "user unmute".
   */
  volume?: number
  muted?: boolean
}

/**
 * The native-engine backend: keeps currentTime/duration/paused (and volume/
 * mute) as LOCAL state updated from the three `mpv://…` event streams, and
 * translates transport writes into invoke calls. Volume/mute are mirrored
 * locally and passed along with every load (the engine may have been created
 * by a bare availability probe before any user gesture).
 *
 * Bound to ONE engine `id` (0 = single player, 1..4 = multi-view tiles):
 * every invoke carries it and every event listener filters on it, so
 * several backends can coexist over the shared event bus.
 */
export class MpvBackend implements VideoBackend {
  /** The last mid-playback error string (read by App's 'error' subscriber). */
  lastError: string | null = null

  private readonly id: number
  private curTime = 0
  private dur = Number.NaN
  private isPaused = true
  private vol = 1
  private mut = false
  private readonly unlisteners: Array<() => void> = []
  private readonly subs = new Map<VideoBackendEvent, Set<() => void>>()
  private disposed = false

  constructor(id = 0) {
    this.id = id
    const track = <T>(name: string, handler: (payload: T) => void): void => {
      void listen(name, (e) => handler(e.payload as T))
        .then((un) => {
          if (this.disposed) un()
          else this.unlisteners.push(un)
        })
        .catch(() => {
          /* not under Tauri / command missing — every invoke also no-ops */
        })
    }
    track<MpvStateEvent>('mpv://state', (s) => {
      if (s.id !== this.id) return
      this.onState(s)
    })
    track<MpvTimeEvent>('mpv://time', (t) => {
      if (t.id !== this.id) return
      this.onTime(t)
    })
    track<MpvVolumeEvent>('mpv://volume', (v) => {
      if (v.id !== this.id) return
      this.onVolume(v)
    })
    track<MpvIdEvent>('mpv://seeking', (pid) => {
      if (pid !== this.id) return
      this.emit('seeking')
    })
    track<MpvIdEvent>('mpv://seeked', (pid) => {
      if (pid !== this.id) return
      this.emit('seeked')
    })
  }

  private emit(event: VideoBackendEvent): void {
    for (const cb of this.subs.get(event) ?? []) cb()
  }

  private onState(s: MpvStateEvent): void {
    switch (s.state) {
      case 'playing':
        this.isPaused = false
        this.emit('play')
        this.emit('playing')
        return
      case 'paused':
        this.isPaused = true
        this.emit('pause')
        return
      case 'buffering':
        this.emit('waiting')
        return
      case 'loading':
        // Not yet rendering: keep the paused-ish default; PlayerControls'
        // `playing` flag flips on the first 'playing'.
        this.isPaused = true
        return
      case 'ended':
        this.isPaused = true
        this.emit('ended')
        return
      case 'error':
        this.lastError = s.error ?? 'mpv playback error'
        this.isPaused = true
        this.emit('error')
        return
    }
  }

  private onTime(t: MpvTimeEvent): void {
    this.curTime = t.position
    if (Number.isFinite(t.duration) && t.duration > 0 && t.duration !== this.dur) {
      this.dur = t.duration
      this.emit('durationchange')
    }
    this.emit('timeupdate')
  }

  /**
   * OSC-driven volume/mute (mpv's own in-video slider/buttons) mirrored into
   * the backend's state — the 'volumechange' emit makes PlayerControls' onVol
   * pick it up like an element-side change (UI + persisted settings follow).
   * The app-side writes echo back through this with the same value and are
   * absorbed (the emit is idempotent), so there is no feedback loop.
   */
  private onVolume(v: MpvVolumeEvent): void {
    this.vol = Math.max(0, Math.min(1, v.volume))
    this.mut = v.muted
    this.emit('volumechange')
  }

  get currentTime(): number {
    return this.curTime
  }
  get duration(): number {
    return this.dur
  }
  get paused(): boolean {
    return this.isPaused
  }
  get volume(): number {
    return this.vol
  }
  get muted(): boolean {
    return this.mut
  }
  get buffered(): number {
    return 0
  }

  play(): Promise<void> {
    this.isPaused = false
    return invoke('mpv_set_paused', { id: this.id, paused: false })
      .then(() => undefined)
      .catch(() => undefined)
  }

  pause(): void {
    this.isPaused = true
    void invoke('mpv_set_paused', { id: this.id, paused: true }).catch(() => {})
  }

  seek(t: number): void {
    void invoke('mpv_seek', { id: this.id, seconds: Math.max(0, t) }).catch(() => {})
  }

  setVolume(v: number): void {
    this.vol = Math.max(0, Math.min(1, v))
    void invoke('mpv_set_volume', { id: this.id, volume: this.vol }).catch(() => {})
    // Local mirror → PlayerControls persists it to settings, exactly like
    // the element's volumechange round-trip.
    this.emit('volumechange')
  }

  setMuted(m: boolean): void {
    this.mut = m
    void invoke('mpv_set_muted', { id: this.id, muted: m }).catch(() => {})
    this.emit('volumechange')
  }

  /**
   * Load a media URL on the native engine (shows the surface). The URL must
   * be the STREAMLINK-RESOLVED one — no ksvod proxy (mpv is not a browser).
   */
  async load(url: string, opts: MpvLoadOptions): Promise<{ ok: true } | { ok: false; error: string }> {
    try {
      await invoke('mpv_load', {
        id: this.id,
        url,
        kind: opts.kind,
        startAt: opts.startAt ?? null,
        hwdec: opts.hwdec,
        volume: opts.volume ?? this.vol,
        muted: opts.muted ?? this.mut,
      })
      this.lastError = null
      return { ok: true }
    } catch (err) {
      return { ok: false, error: invokeErrorMessage(err) }
    }
  }

  /** Stop playback + hide the surface, but keep subscriptions (per-stream). */
  async stop(): Promise<void> {
    try {
      await invoke('mpv_stop', { id: this.id })
    } catch {
      /* engine may never have come up */
    }
  }

  on(event: VideoBackendEvent, cb: () => void): () => void {
    let set = this.subs.get(event)
    if (!set) {
      set = new Set()
      this.subs.set(event, set)
    }
    set.add(cb)
    return () => {
      set.delete(cb)
    }
  }

  /** Final teardown: unsubscribe + stop. The engine object itself persists. */
  async dispose(): Promise<void> {
    this.disposed = true
    for (const un of this.unlisteners.splice(0)) {
      try {
        un()
      } catch {
        /* ignore */
      }
    }
    this.subs.clear()
    await this.stop()
  }
}

// ---------------------------------------------------------------------------
// Backend selection
// ---------------------------------------------------------------------------

/**
 * The inputs that decide which backend the SINGLE-stream player uses. Pure
 * on purpose — every fallback transition (multi-view, PiP, the settings
 * toggle, an unavailable engine) is a row in the unit tests. Multi-view
 * TILES pick their own backend inside Tile.svelte (one MpvBackend per
 * tile, ids 1..4) — this selector only governs the main player, which
 * steps aside entirely while the tile grid is up.
 */
export interface VideoBackendChoiceInputs {
  /** The experimental-engine setting (Settings → Player). */
  mpvEngineOn: boolean
  /** invoke('mpv_available') resolved true (feature build + surface live). */
  mpvAvailable: boolean
  /** Multi-view is on: the tile grid replaces the single player. */
  multiView: boolean
  /** The floating PiP window is open: main-player playback steps aside. */
  pipOpen: boolean
}

/**
 * 'mpv' only when EVERY gate holds: the user opted in, the native engine is
 * actually available, and the main single-stream player is the active
 * surface (not while the multi-view grid or the PiP window owns playback).
 * Anything else — including every default build, where mpvAvailable can
 * never be true — gets the HTML backend.
 */
export function selectVideoBackend(inputs: VideoBackendChoiceInputs): 'mpv' | 'html' {
  const { mpvEngineOn, mpvAvailable, multiView, pipOpen } = inputs
  return mpvEngineOn && mpvAvailable && !multiView && !pipOpen ? 'mpv' : 'html'
}
