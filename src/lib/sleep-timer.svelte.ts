/*
 * Sleep timer — pause PLAYBACK after N minutes. Does NOT close or quit the app
 * (that would be a far more destructive default). Read-only / no-network: it
 * is purely a local countdown that, on expiry, asks the host to pause the
 * current <video>.
 *
 * Identity guard: a timer is armed against a specific stream identity
 * {channel, playbackKind, streamGen}. If the user changes channel, switches to
 * a VOD/clip, or the player is torn down, the armed timer is cancelled so it
 * can never fire against a different stream than the one it was set for. The
 * host wires this via cancelIfStale() inside a $effect that watches the stream
 * identity, plus an explicit cancel() on the player going idle/offline/error.
 */

export type PlaybackKind = 'live' | 'vod' | 'clip'

export interface SleepArmContext {
  channel: string | null
  playbackKind: PlaybackKind
  streamGen: number
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
  // playback-kind change / stream teardown. A matching identity is left armed.
  cancelIfStale(channel: string | null, playbackKind: PlaybackKind, streamGen: number): void {
    if (!this.armed || !this.armCtx) return
    if (
      this.armCtx.channel !== channel ||
      this.armCtx.playbackKind !== playbackKind ||
      this.armCtx.streamGen !== streamGen
    ) {
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
