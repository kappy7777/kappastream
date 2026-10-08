/*
 * Sleep timer — STOP playback after N minutes. Does NOT close or quit the app
 * (that would be a far more destructive default). Read-only / no-network: it
 * is purely a local countdown that, on expiry, fires the host's onFire
 * callback — App stops playback there outright (tears down the player and, on
 * a live stream, the chat connection; multi-view exits every tile) rather
 * than merely pausing the <video>.
 *
 * Identity guard: a timer is armed against the stream identity
 * {channel, playbackKind}. If the user changes channel or switches to a
 * VOD/clip, the armed timer is cancelled so it can never fire against a
 * different stream than the one it was set for. The identity deliberately
 * stops there: a quality switch, a low-latency toggle or a variant fallback
 * reloads the SAME stream (new playback generation), and those must NOT
 * cancel an armed timer. The host wires this via cancelIfStale() inside a
 * $effect that watches the stream identity, plus an explicit cancel() on
 * the player going idle/offline/error.
 */

export type PlaybackKind = 'live' | 'vod' | 'clip'

export interface SleepArmContext {
  channel: string | null
  playbackKind: PlaybackKind
}

export const SLEEP_PRESETS: ReadonlyArray<number> = [15, 30, 45, 60, 90] as const

// mm:ss for the countdown chip / settings row. Ceiling so "12.4s" shows 0:13
// (a tick still counts down) rather than jumping straight to 0:00 early.
export function formatSleepRemaining(ms: number): string {
  const s = Math.max(0, Math.ceil(ms / 1000))
  const m = Math.floor(s / 60)
  const ss = s % 60
  return m + ':' + ss.toString().padStart(2, '0')
}

export class SleepTimerStore {
  armed: boolean = $state(false)
  remainingMs: number = $state(0)
  armedMinutes: number | null = $state(null)

  private fireAt: number | null = null
  private fireTimer: ReturnType<typeof setTimeout> | null = null
  private tickTimer: ReturnType<typeof setInterval> | null = null
  private armCtx: SleepArmContext | null = null
  private onFire: (() => void) | null = null

  setOnFire(cb: () => void): void {
    this.onFire = cb
  }

  arm(ctx: SleepArmContext, minutes: number): void {
    this.clearTimers()
    const ms = Math.max(0, Math.round(minutes)) * 60_000
    this.armCtx = { ...ctx }
    this.fireAt = Date.now() + ms
    this.armed = true
    this.armedMinutes = minutes
    this.remainingMs = ms
    this.fireTimer = setTimeout(() => this.fire(), ms)
    this.tickTimer = setInterval(() => this.tick(), 1000)
  }

  private tick(): void {
    if (this.fireAt === null) return
    const rem = this.fireAt - Date.now()
    this.remainingMs = rem > 0 ? rem : 0
  }

  private fire(): void {
    if (!this.armed) return
    this.clearTimers()
    this.armed = false
    this.armedMinutes = null
    this.remainingMs = 0
    this.fireAt = null
    this.armCtx = null
    if (this.onFire) this.onFire()
  }

  cancel(): void {
    if (!this.armed && this.fireAt === null) return
    this.clearTimers()
    this.armed = false
    this.armedMinutes = null
    this.remainingMs = 0
    this.fireAt = null
    this.armCtx = null
  }

  // Cancel only when the current stream identity no longer matches the one the
  // timer was armed against. This is the auto-cancel on channel change /
  // playback-kind change. A matching identity is left armed — including
  // across a same-stream reload (quality switch, low-latency toggle).
  cancelIfStale(channel: string | null, playbackKind: PlaybackKind): void {
    if (!this.armed || !this.armCtx) return
    if (this.armCtx.channel !== channel || this.armCtx.playbackKind !== playbackKind) {
      this.cancel()
    }
  }

  private clearTimers(): void {
    if (this.fireTimer) {
      clearTimeout(this.fireTimer)
      this.fireTimer = null
    }
    if (this.tickTimer) {
      clearInterval(this.tickTimer)
      this.tickTimer = null
    }
  }
}

export const sleepTimer = new SleepTimerStore()
