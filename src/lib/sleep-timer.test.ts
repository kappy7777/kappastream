import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { SleepTimerStore, formatSleepRemaining } from './sleep-timer.svelte'

/*
 * Sleep timer — pause playback after N minutes. Three behaviours are load-
 * bearing and tested here: the timer FIRES (pauses via the onFire callback) on
 * expiry, an explicit CANCEL prevents it firing, and it AUTO-CANCELS when the
 * stream identity changes (channel / playback-kind / stream generation) so a
 * stale armed timer can never fire against a different stream than the one it
 * was set for. Uses fake timers (setTimeout + Date.now are both mocked).
 */

let store: SleepTimerStore
let fired: number

beforeEach(() => {
  vi.useFakeTimers()
  fired = 0
  store = new SleepTimerStore()
  store.setOnFire(() => { fired++ })
})

afterEach(() => {
  vi.useRealTimers()
})

const ctxA = { channel: 'alpha', playbackKind: 'live' as const, streamGen: 1 }
const ctxB = { channel: 'beta', playbackKind: 'live' as const, streamGen: 2 }

describe('sleep timer fires on expiry', () => {
  it('calls onFire once after the armed duration and disarms', () => {
    store.arm(ctxA, 1) // 1 minute
    expect(store.armed).toBe(true)
    expect(store.armedMinutes).toBe(1)
    vi.advanceTimersByTime(59_000)
    expect(fired).toBe(0) // not yet
    vi.advanceTimersByTime(2_000) // past 60s
    expect(fired).toBe(1)
    expect(store.armed).toBe(false)
    expect(store.armedMinutes).toBeNull()
  })

  it('ticks the remaining-time countdown toward zero', () => {
    store.arm(ctxA, 1)
    expect(store.remainingMs).toBe(60_000)
    vi.advanceTimersByTime(30_000)
    expect(store.remainingMs).toBeLessThanOrEqual(30_000)
    vi.advanceTimersByTime(35_000)
    expect(store.remainingMs).toBe(0)
  })
})

describe('sleep timer explicit cancel', () => {
  it('cancel() prevents onFire from firing', () => {
    store.arm(ctxA, 1)
    store.cancel()
    expect(store.armed).toBe(false)
    vi.advanceTimersByTime(120_000)
    expect(fired).toBe(0)
  })

  it('cancel() is a no-op when not armed', () => {
    store.cancel() // must not throw
    expect(store.armed).toBe(false)
  })

  it('re-arming replaces the previous timer (no double fire)', () => {
    store.arm(ctxA, 1)
    store.arm(ctxA, 5) // replace
    vi.advanceTimersByTime(65_000) // past the first (1m) duration
    expect(fired).toBe(0) // the 1m timer was cleared by re-arm
    vi.advanceTimersByTime(240_000) // complete the 5m duration
    expect(fired).toBe(1)
  })
})

describe('sleep timer auto-cancels on stream-identity change', () => {
  it('cancelIfStale disarms when the channel changes', () => {
    store.arm(ctxA, 30)
    store.cancelIfStale('beta', 'live', 1) // different channel
    expect(store.armed).toBe(false)
    vi.advanceTimersByTime(60 * 60_000)
    expect(fired).toBe(0) // never fires against the new stream
  })

  it('cancelIfStale disarms when playback-kind changes (live -> vod)', () => {
    store.arm(ctxA, 30)
    store.cancelIfStale('alpha', 'vod', 1)
    expect(store.armed).toBe(false)
  })

  it('cancelIfStale disarms when the stream generation changes (teardown)', () => {
    store.arm(ctxA, 30)
    store.cancelIfStale('alpha', 'live', 99)
    expect(store.armed).toBe(false)
  })

  it('cancelIfStale leaves the timer armed when the identity matches', () => {
    store.arm(ctxA, 30)
    store.cancelIfStale('alpha', 'live', 1)
    expect(store.armed).toBe(true)
    vi.advanceTimersByTime(30 * 60_000)
    expect(fired).toBe(1)
  })

  it('cancelIfStale is a no-op when not armed', () => {
    store.cancelIfStale('alpha', 'live', 1) // must not throw
    expect(store.armed).toBe(false)
  })
})

describe('formatSleepRemaining', () => {
  it('formats mm:ss with a zero-padded seconds field', () => {
    expect(formatSleepRemaining(0)).toBe('0:00')
    expect(formatSleepRemaining(1_000)).toBe('0:01')
    expect(formatSleepRemaining(59_999)).toBe('1:00') // ceiling (60s)
    expect(formatSleepRemaining(60_000)).toBe('1:00')
    expect(formatSleepRemaining(90_000)).toBe('1:30')
    expect(formatSleepRemaining(15 * 60_000)).toBe('15:00')
  })

  it('clamps negative input to zero', () => {
    expect(formatSleepRemaining(-5_000)).toBe('0:00')
  })
})
