import { describe, it, expect, beforeEach, vi } from 'vitest'
import {
  VodPositionsStore,
  shouldSavePosition,
  evictOldest,
  MAX_VOD_POSITIONS,
  VOD_RESUME_MIN_S,
  VOD_RESUME_COMPLETE_FRACTION,
  type VodPosition,
} from './vod-positions.svelte'

/*
 * VOD resume positions. Two behaviours are load-bearing:
 *   - the save THRESHOLDS (nothing below 30s; nothing past 95% — and a past-95%
 *     position drops a prior entry so a finished VOD isn't resumed);
 *   - the bounded map (oldest-first eviction at the cap so localStorage can't
 *     grow without limit).
 * Plus persistence (round-trips through localStorage).
 */

let store: VodPositionsStore
const KEY = 'app-vod-positions-v1'

beforeEach(() => {
  vi.resetModules()
  localStorage.clear()
  store = new VodPositionsStore()
})

describe('shouldSavePosition threshold boundaries', () => {
  it('rejects anything below the 30s floor', () => {
    expect(shouldSavePosition(0, 600)).toBe(false)
    expect(shouldSavePosition(29.9, 600)).toBe(false)
  })

  it('accepts exactly the 30s floor', () => {
    expect(shouldSavePosition(VOD_RESUME_MIN_S, 600)).toBe(true)
  })

  it('rejects anything past the 95% completion line', () => {
    expect(shouldSavePosition(575, 600)).toBe(false) // > 95% of 600
  })

  it('accepts exactly the 95% completion line', () => {
    expect(shouldSavePosition(600 * VOD_RESUME_COMPLETE_FRACTION, 600)).toBe(true)
  })

  it('ignores the completion ceiling when duration is unknown', () => {
    // A live-ish / unknown duration: only the 30s floor applies.
    expect(shouldSavePosition(120, NaN)).toBe(true)
    expect(shouldSavePosition(10, NaN)).toBe(false)
  })

  it('rejects non-finite positions', () => {
    expect(shouldSavePosition(NaN, 600)).toBe(false)
    expect(shouldSavePosition(Infinity, 600)).toBe(false)
  })
})

describe('save respects the thresholds', () => {
  it('does not store a sub-30s position', () => {
    expect(store.save('v1', 5, 600)).toBe(false)
    expect(store.has('v1')).toBe(false)
  })

  it('stores a mid-VOD position and round-trips it', () => {
    expect(store.save('v1', 250, 600)).toBe(true)
    const got = store.get('v1')
    expect(got).not.toBeNull()
    expect(got!.position).toBe(250)
    expect(got!.duration).toBe(600)
    expect(got!.updatedAt).toBeGreaterThan(0)
  })

  it('a past-95% position DROPS a previously-stored entry (finished VOD)', () => {
    store.save('v1', 250, 600)
    expect(store.has('v1')).toBe(true)
    expect(store.save('v1', 590, 600)).toBe(false) // past 95%
    expect(store.has('v1')).toBe(false) // cleared, not updated
  })
})

describe('save updating an existing entry', () => {
  it('refreshes updatedAt and keeps the map size stable', () => {
    store.save('v1', 100, 600)
    const t0 = store.get('v1')!.updatedAt
    store.save('v1', 200, 600)
    const t1 = store.get('v1')!.updatedAt
    expect(t1).toBeGreaterThanOrEqual(t0)
    expect(store.get('v1')!.position).toBe(200)
    expect(Object.keys(store.positions)).toHaveLength(1)
  })
})

describe('bounded storage — oldest-first eviction at the cap', () => {
  it('evicts the single oldest entry when the cap is exceeded', () => {
    // Fill exactly to the cap with increasing timestamps.
    for (let i = 0; i < MAX_VOD_POSITIONS; i++) {
      store.save('v' + i, 100, 600)
      // Force distinct updatedAt ordering deterministically.
      store.positions['v' + i].updatedAt = 1_000_000 + i
    }
    expect(Object.keys(store.positions)).toHaveLength(MAX_VOD_POSITIONS)
    // Add one more — the oldest (v0) should be evicted, the new one kept.
    store.save('vNew', 100, 600)
    expect(Object.keys(store.positions)).toHaveLength(MAX_VOD_POSITIONS)
    expect(store.has('v0')).toBe(false)
    expect(store.has('vNew')).toBe(true)
    expect(store.has('v' + (MAX_VOD_POSITIONS - 1))).toBe(true)
  })

  it('evictOldest drops the right number of oldest entries', () => {
    const map: Record<string, VodPosition> = {}
    for (let i = 0; i < 5; i++) map['k' + i] = { position: 50, duration: 600, updatedAt: i }
    const evicted = evictOldest(map, 3)
    expect(Object.keys(evicted)).toHaveLength(3)
    expect(evicted.k4).toBeDefined() // newest kept
    expect(evicted.k3).toBeDefined()
    expect(evicted.k2).toBeDefined()
    expect(evicted.k0).toBeUndefined() // oldest dropped
    expect(evicted.k1).toBeUndefined()
  })
})

describe('persistence round-trip', () => {
  it('a saved entry survives a fresh store constructed from the same localStorage', async () => {
    store.save('v1', 250, 600)
    expect(localStorage.getItem(KEY)).toBeTruthy()
    vi.resetModules()
    const mod = await import('./vod-positions.svelte')
    const fresh = new mod.VodPositionsStore()
    expect(fresh.get('v1')?.position).toBe(250)
  })

  it('junk in storage is dropped, not crash', async () => {
    localStorage.setItem(KEY, '{not json')
    vi.resetModules()
    const mod = await import('./vod-positions.svelte')
    const fresh = new mod.VodPositionsStore()
    expect(Object.keys(fresh.positions)).toHaveLength(0)
  })
})

describe('clear', () => {
  it('removes an entry and is a no-op for unknown ids', () => {
    store.save('v1', 250, 600)
    store.clear('nobody') // no-op
    expect(store.has('v1')).toBe(true)
    store.clear('v1')
    expect(store.has('v1')).toBe(false)
  })
})
