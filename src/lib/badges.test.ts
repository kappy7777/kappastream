import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

/*
 * Tests for src/lib/badges.ts — the weekly global-badge refresh.
 *
 * Only the GQL transport function (fetchGlobalBadgeSets) is mocked; the rest
 * runs for real: localStorage (happy-dom), the real setGlobalBadges (mutating
 * irc.ts's module state, observed via parseIrcLine), and the real merge logic.
 * globalBadges is restored to the baseline after each test.
 */

vi.mock('./gql', () => ({
  fetchGlobalBadgeSets: vi.fn(),
}))

import { initBadgeRefresh, mergeRefreshedBadges, __test } from './badges'
import { BASELINE_BADGES, BASELINE_GENERATED_AT } from './badges.generated'
import { setGlobalBadges, parseIrcLine } from './irc'
import { fetchGlobalBadgeSets, type GlobalBadgeRow } from './gql'

const mockedFetch = vi.mocked(fetchGlobalBadgeSets)

const CACHED_MAP = {
  broadcaster: { label: 'Cached Host', uuid: 'c0c0c0c0-c0c0-c0c0-c0c0-c0c0c0c0c0c0' },
}
const DAY = 24 * 60 * 60 * 1000

function writeCache(opts: { ageDays?: number; badges?: unknown; baselineAt?: string; v?: number }) {
  const ageDays = opts.ageDays ?? 0
  const entry = {
    v: opts.v ?? __test.BADGE_CACHE_VERSION,
    fetchedAt: Date.now() - ageDays * DAY,
    baselineAt: opts.baselineAt ?? BASELINE_GENERATED_AT,
    badges: opts.badges ?? CACHED_MAP,
  }
  localStorage.setItem(__test.BADGE_CACHE_KEY, JSON.stringify(entry))
}

// Parse broadcaster/1 and return its image URL (a sentinel for which global map
// is active: cached uuid -> CACHED_MAP, baseline uuid -> baseline, null -> none).
function hostUrl(): string | null {
  const b = parseIrcLine('@badges=broadcaster/1;id=x;tmi-sent-ts=0 :u!u@u PRIVMSG #c :hi')!.badges
  return b[0]?.imageUrl ?? null
}

describe('mergeRefreshedBadges', () => {
  it('inherits the baseline label and refreshes UUIDs', () => {
    const rows: GlobalBadgeRow[] = [
      { setID: 'broadcaster', version: '1', title: 'Broadcaster', imageURL: 'https://static-cdn.jtvnw.net/badges/v1/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa/1' },
    ]
    const merged = mergeRefreshedBadges(BASELINE_BADGES, rows)
    expect(merged.broadcaster.label).toBe('Host') // baseline label preserved
    expect(merged.broadcaster.uuid).toBe('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa') // refreshed
  })

  it('adds a brand-new set not in the baseline', () => {
    const rows: GlobalBadgeRow[] = [
      { setID: 'brand-new-badge', version: '1', title: 'Brand New', imageURL: 'https://static-cdn.jtvnw.net/badges/v1/bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb/1' },
    ]
    const merged = mergeRefreshedBadges(BASELINE_BADGES, rows)
    expect(merged['brand-new-badge'].uuid).toBe('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb')
    expect(typeof merged['brand-new-badge'].label).toBe('string')
  })

  it('keeps baseline entries Twitch no longer serves (legacy aliases survive)', () => {
    // Empty refresh -> still a superset of baseline.
    const merged = mergeRefreshedBadges(BASELINE_BADGES, [])
    expect(merged.broadcaster).toEqual(BASELINE_BADGES.broadcaster)
  })

  it('builds perVersion for multi-version sets and preserves curated labels', () => {
    const rows: GlobalBadgeRow[] = [
      { setID: 'bits', version: '1', title: 'cheer 1', imageURL: 'https://static-cdn.jtvnw.net/badges/v1/11111111-1111-1111-1111-111111111111/1' },
      { setID: 'bits', version: '100', title: 'cheer 100', imageURL: 'https://static-cdn.jtvnw.net/badges/v1/22222222-2222-2222-2222-222222222222/1' },
    ]
    const merged = mergeRefreshedBadges(BASELINE_BADGES, rows)
    expect(merged.bits.label).toBe('Bits')
    expect(merged.bits.perVersion).toEqual({
      '1': '11111111-1111-1111-1111-111111111111',
      '100': '22222222-2222-2222-2222-222222222222',
    })
    expect(merged.bits.perVersionLabel?.['100']).toBe('100 bits') // baseline curated label kept
  })
})

describe('isValidCache (cache schema guard)', () => {
  const { isValidCache } = __test
  const valid = {
    v: __test.BADGE_CACHE_VERSION,
    fetchedAt: 1,
    baselineAt: BASELINE_GENERATED_AT,
    badges: { x: { label: 'X', uuid: 'u' } },
  }
  it('accepts a well-formed cache', () => {
    expect(isValidCache(valid)).toBe(true)
  })
  it('rejects a wrong schema version', () => {
    expect(isValidCache({ ...valid, v: 999 })).toBe(false)
  })
  it('rejects a cache built against a different baseline', () => {
    expect(isValidCache({ ...valid, baselineAt: '1999-01-01' })).toBe(false)
  })
  it('rejects a missing/non-number fetchedAt', () => {
    expect(isValidCache({ ...valid, fetchedAt: undefined })).toBe(false)
  })
  it('rejects a missing/non-object badges map', () => {
    expect(isValidCache({ ...valid, badges: null })).toBe(false)
    expect(isValidCache({ ...valid, badges: 'nope' })).toBe(false)
  })
  it('rejects null / non-object input', () => {
    expect(isValidCache(null)).toBe(false)
    expect(isValidCache('string')).toBe(false)
  })
})

describe('initBadgeRefresh (cache + background refresh)', () => {
  beforeEach(() => {
    localStorage.clear()
    mockedFetch.mockReset()
    setGlobalBadges(BASELINE_BADGES)
  })
  afterEach(() => {
    setGlobalBadges(BASELINE_BADGES)
    localStorage.clear()
  })

  it('a fresh cache is installed and NO refresh fires', async () => {
    writeCache({ ageDays: 1 }) // < 7 days
    initBadgeRefresh()
    expect(hostUrl()).toBe('https://static-cdn.jtvnw.net/badges/v1/c0c0c0c0-c0c0-c0c0-c0c0-c0c0c0c0c0c0/1')
    // No background fetch for a fresh cache.
    await Promise.resolve()
    expect(mockedFetch).not.toHaveBeenCalled()
  })

  it('a stale cache triggers a background refresh', async () => {
    writeCache({ ageDays: 8 }) // > 7 days
    mockedFetch.mockResolvedValue([
      { setID: 'broadcaster', version: '1', title: 'Broadcaster', imageURL: 'https://static-cdn.jtvnw.net/badges/v1/11111111-1111-1111-1111-111111111111/1' },
    ])
    initBadgeRefresh()
    // Stale cache is installed immediately (beats baseline)...
    expect(hostUrl()).toBe('https://static-cdn.jtvnw.net/badges/v1/c0c0c0c0-c0c0-c0c0-c0c0-c0c0c0c0c0c0/1')
    // ...then the background refresh swaps in the refreshed UUID.
    await vi.waitFor(() => {
      expect(hostUrl()).toBe('https://static-cdn.jtvnw.net/badges/v1/11111111-1111-1111-1111-111111111111/1')
    })
    expect(mockedFetch).toHaveBeenCalledTimes(1)
  })

  it('a fetch failure falls back to the baseline, never to empty (no throw)', async () => {
    expect(localStorage.getItem(__test.BADGE_CACHE_KEY)).toBeNull()
    mockedFetch.mockRejectedValue(new Error('network down'))
    expect(() => initBadgeRefresh()).not.toThrow()
    // Baseline is the floor -> broadcaster still resolves (NOT empty).
    await vi.waitFor(() => expect(mockedFetch).toHaveBeenCalled())
    const url = hostUrl()
    expect(url).not.toBeNull()
    expect(url).toBe('https://static-cdn.jtvnw.net/badges/v1/' + BASELINE_BADGES.broadcaster.uuid + '/1')
  })

  it('a corrupt / wrong-schema cache is discarded (no throw) and refreshes', async () => {
    localStorage.setItem(__test.BADGE_CACHE_KEY, '{this is not json')
    mockedFetch.mockResolvedValue([])
    expect(() => initBadgeRefresh()).not.toThrow()
    // Corrupt cache -> baseline active (not the cached sentinel).
    expect(hostUrl()).toBe(
      'https://static-cdn.jtvnw.net/badges/v1/' + BASELINE_BADGES.broadcaster.uuid + '/1',
    )
    await vi.waitFor(() => expect(mockedFetch).toHaveBeenCalled())
  })

  it('a cache from an older baseline is discarded and refreshes', async () => {
    writeCache({ ageDays: 1, baselineAt: '1999-01-01' }) // fresh age, stale baseline
    mockedFetch.mockResolvedValue([])
    initBadgeRefresh()
    expect(mockedFetch).toHaveBeenCalledTimes(1) // discarded -> refresh despite fresh age
    // Baseline active (old cache discarded).
    expect(hostUrl()).toBe(
      'https://static-cdn.jtvnw.net/badges/v1/' + BASELINE_BADGES.broadcaster.uuid + '/1',
    )
  })
})
