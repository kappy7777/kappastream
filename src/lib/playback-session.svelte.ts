// One hls.js playback engine — the attach / manifest-timeout / stall-recovery
// / teardown machinery that used to exist as near-verbatim copies inside
// App.svelte (live + VOD paths), Tile.svelte and PipWindow.svelte. Modelled
// on ChatSession (chat-session.svelte.ts): each video SURFACE constructs one
// session, couples in via the attach options (a staleness predicate, error
// formatting, status callbacks) and disposes it when the surface unmounts.
//
// MECHANISM lives here; POLICY stays at the call sites. The live path (which
// URL — the Windows ksvod routing —, quality fallbacks, playerStatus
// transitions), the VOD path (non-low-latency config, no generation coupling,
// resume callbacks) and the clip path (plain MP4, no hls.js at all) are
// genuinely different policies over this one shared mechanism. Do NOT fold
// them into one mega-attach with mode flags.
//
// Error strings are produced BY THE CALL SITE (formatError / staleError /
// errorPrefix) so each surface keeps its exact historical strings.

import Hls from 'hls.js'
import { invoke } from '@tauri-apps/api/core'
import { buildHlsConfig } from './hls-config'
import { isFatalNetworkishError, liveEdgeSeekTarget, STALL_RECOVER_GRACE_MS } from './playback'

const MANIFEST_TIMEOUT_MS = 20_000

/**
 * The one stale-attach error string, shared by every call site (App's
 * historical form — the more descriptive of the two pre-refactor variants;
 * Tile's shorter 'stale' was never displayed anywhere).
 */
export const STALE_STREAM_REQUEST = 'stale stream request'

/**
 * The one fatal hls.js error string: the networkish or generic prefix chosen
 * by isFatalNetworkishError, with the (details) suffix. Unified on App's
 * historical form — Tile's copy dropped the suffix, but these strings only
 * ever reach error state/console, so the more informative form wins.
 */
export function formatFatalHlsError(data: HlsErrorData): string {
  return isFatalNetworkishError(data)
    ? 'network/manifest error: ' + data.type + ' (' + (data.details ?? '') + ')'
    : 'hls error: ' + data.type + ' (' + (data.details ?? '') + ')'
}

export type PlaybackAttachResult = { ok: true } | { ok: false; error: string }

export type ResolveLiveResult =
  | { ok: true; url: string }
  | { ok: false; offline: boolean; unavailable?: boolean; error?: string }

/**
 * resolve_stream invoke wrapper + payload normalization — the transport half
 * of what used to be duplicated as `resolveStream` in App.svelte and
 * Tile.svelte. POLICY (quality fallback, offline handling, error surfacing)
 * stays at the call sites.
 */
export async function resolveLiveStream(channel: string, q: string, lowLatency: boolean): Promise<ResolveLiveResult> {
  type ResolveRaw = { ok?: boolean; url?: string | null; offline?: boolean; error?: string | null; unavailable?: boolean; quality?: string | null }
  let raw: ResolveRaw
  try {
    raw = (await invoke('resolve_stream', { channel, quality: q, lowLatency })) as ResolveRaw
  } catch (err) {
    const msg = typeof err === 'string' ? err : err instanceof Error ? err.message : JSON.stringify(err)
    return { ok: false, offline: false, error: 'invoke failed: ' + msg }
  }
  if (raw.offline) return { ok: false, offline: true }
  if (!raw.ok || !raw.url) {
    return { ok: false, offline: false, unavailable: raw.unavailable === true, error: raw.error ?? 'unknown resolve error' }
  }
  return { ok: true, url: raw.url }
}

/** The shape hls.js hands to its ERROR listeners (structural subset). */
export interface HlsErrorData {
  fatal: boolean
  type: string
  details?: string
}

export interface AttachHlsOptions {
  video: HTMLVideoElement
  /** Already policy-routed URL (ksvod rewrite is the call site's decision). */
  url: string
  /** Drives buildHlsConfig: live callers pass settings.lowLatency, VOD passes false. */
  lowLatency: boolean
  /** Staleness predicate, captured per attach (generation + channel/quality policy stays at the call site). */
  isCurrent: () => boolean
  /**
   * Optional override of the unified fatal-error string. Exists ONLY for the
   * VOD path, whose historical shape ('media error: <type>') is a genuinely
   * different error taxonomy, not cosmetic drift. Live surfaces (App, Tile,
   * PiP) must not pass it — they get formatFatalHlsError.
   */
  formatFatalError?: (data: HlsErrorData) => string
  /** Fires after the staleness check passes on MANIFEST_PARSED (e.g. status → loading). */
  onManifestParsed?: () => void
  /** Fires when the autoplay play() resolves and the attach is still current. */
  onPlayed?: () => void
  /** Fires when play() is blocked and the attach is still current. */
  onPlayBlocked?: () => void
}

export interface AttachNativeOptions {
  /** Optional staleness check applied AFTER play() resolves (live paths). */
  isCurrent?: () => boolean
  /**
   * Prefix for the play-failure error (call-site string, includes the
   * separator). Optional: PiP's native fallback has no error-string policy
   * (it shows a gesture button instead of an error message).
   */
  errorPrefix?: string
  /** Fires after the staleness check passes (call-site status transition). */
  onPlayed?: () => void
}

export class PlaybackSession {
  /**
   * Deliberate-pause flag: set by the call site BEFORE pausing so its own
   * pause handler can distinguish a user pause from a stall-induced one
   * (webkit2gtk pauses on underrun). Owned here so every surface shares one
   * discipline; not reactive — only the pause handler reads it.
   */
  userPaused = false
  /**
   * Monotonic staleness counter for THIS surface. Bumped by teardown() and
   * by nextGeneration() (the call site's "new load starts" bump). Call sites
   * build their isCurrent predicate over it, exactly like the old local
   * `streamGeneration` / Tile `generation` counters.
   */
  generation = 0

  private hls: Hls | null = null
  private stallTimer: ReturnType<typeof setTimeout> | null = null
  private cancelPendingAttach: (() => void) | null = null
  private disposed = false

  /** Invalidate all in-flight work and hand out the new generation token. */
  nextGeneration(): number {
    return ++this.generation
  }

  attachHls(opts: AttachHlsOptions): Promise<PlaybackAttachResult> {
    if (this.disposed) return Promise.resolve({ ok: false, error: 'session disposed' })
    this.clearStallRecover()
    // Defensive destroy of a previous instance (a no-op when the call site
    // tore down first, as the VOD path does).
    if (this.hls) {
      try { this.hls.destroy() } catch { /* ignore */ }
      this.hls = null
    }
    const instance = new Hls(buildHlsConfig(opts.lowLatency))
    this.hls = instance
    return new Promise((resolve) => {
      let done = false
      // Local timeout handle (like the historical copies' variable). It is
      // cleared by finish; teardown cancels a still-pending attach through
      // the cancel hook, which runs finish.
      let to: ReturnType<typeof setTimeout> | null = null
      const finish = (r: PlaybackAttachResult): void => {
        if (done) return
        done = true
        if (to) {
          clearTimeout(to)
          to = null
        }
        if (this.cancelPendingAttach === cancel) this.cancelPendingAttach = null
        resolve(r)
      }
      // Cancellation hook (teardown resolves a still-pending attach with the
      // stale error instead of leaving it hanging on a destroyed instance).
      const cancel = () => finish({ ok: false, error: STALE_STREAM_REQUEST })
      this.cancelPendingAttach = cancel

      instance.on(Hls.Events.MANIFEST_PARSED, () => {
        if (!opts.isCurrent()) {
          finish({ ok: false, error: STALE_STREAM_REQUEST })
          return
        }
        opts.onManifestParsed?.()
        void opts.video.play()
          .then(() => { if (opts.isCurrent()) opts.onPlayed?.() })
          .catch(() => { if (opts.isCurrent()) opts.onPlayBlocked?.() })
        finish({ ok: true })
      })

      instance.on(Hls.Events.ERROR, (_event, data) => {
        if (!data.fatal) return
        try { instance.destroy() } catch { /* ignore */ }
        if (!opts.isCurrent()) {
          finish({ ok: false, error: STALE_STREAM_REQUEST })
          return
        }
        finish({ ok: false, error: opts.formatFatalError?.(data) ?? formatFatalHlsError(data) })
      })

      instance.loadSource(opts.url)
      instance.attachMedia(opts.video)

      to = setTimeout(() => {
        to = null
        if (!done) {
          try { instance.destroy() } catch { /* ignore */ }
          finish({ ok: false, error: 'timeout waiting for manifest' })
        }
      }, MANIFEST_TIMEOUT_MS)
    })
  }

  /** The `canPlayType('application/vnd.apple.mpegurl')` fallback branch. */
  async attachNative(video: HTMLVideoElement, url: string, opts: AttachNativeOptions): Promise<PlaybackAttachResult> {
    if (this.disposed) return { ok: false, error: 'session disposed' }
    video.src = url
    try {
      await video.play()
      if (opts.isCurrent && !opts.isCurrent()) return { ok: false, error: STALE_STREAM_REQUEST }
      opts.onPlayed?.()
      return { ok: true }
    } catch (err) {
      return { ok: false, error: (opts.errorPrefix ?? '') + (err as Error).message }
    }
  }

  /**
   * Arm the live stall self-recovery: after the grace period, snap to the
   * live edge (hls.js's liveSyncPosition, else the seekable end) and resume.
   * Cleared by clearStallRecover() on `playing` and by teardown.
   */
  scheduleStallRecover(video: HTMLVideoElement): void {
    if (this.disposed) return
    this.clearStallRecover()
    this.stallTimer = setTimeout(() => {
      this.stallTimer = null
      const seekableEnd = video.seekable.length > 0 ? video.seekable.end(video.seekable.length - 1) : undefined
      // (`?? undefined` normalizes hls.js's `number | null` liveSyncPosition
      // to the helper's `number | undefined` — null and undefined both mean
      // "absent" here.)
      const target = liveEdgeSeekTarget(this.hls?.liveSyncPosition ?? undefined, seekableEnd)
      if (target !== null) {
        try { video.currentTime = target } catch { /* ignore */ }
      }
      void video.play().catch(() => { /* ignore — user can still press play */ })
    }, STALL_RECOVER_GRACE_MS)
  }

  clearStallRecover(): void {
    if (this.stallTimer) {
      clearTimeout(this.stallTimer)
      this.stallTimer = null
    }
  }

  /**
   * Full teardown: invalidates in-flight attaches (generation bump + the
   * cancel hook), clears every timer, destroys hls.js and resets the video
   * element so no segment fetch outlives the stream. Call-site policy that
   * must ALSO happen on stop (e.g. App's pipController.clearStream) wraps
   * this, not the other way round.
   */
  teardown(video?: HTMLVideoElement): void {
    this.generation++ // invalidate any in-flight attach / staleness predicate
    this.cancelPendingAttach?.()
    this.cancelPendingAttach = null
    this.clearStallRecover()
    if (this.hls) {
      try { this.hls.destroy() } catch { /* ignore */ }
      this.hls = null
    }
    if (video) {
      try {
        video.pause()
        video.removeAttribute('src')
        video.load()
      } catch { /* ignore */ }
    }
  }

  /** Idempotent final teardown for the owning surface's onDestroy. */
  dispose(video?: HTMLVideoElement): void {
    if (this.disposed) return
    this.disposed = true
    this.teardown(video)
  }
}
