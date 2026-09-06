import { describe, it, expect, beforeEach, vi } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'

/*
 * Unit tests for the pinned-chat controller + pure helpers
 * (src/lib/pinned-chat.svelte.ts). The GQL fetch, the toggle, the login→id
 * fallback and the clock are all injected deps, so these tests never touch
 * the network, Tauri, or the settings singleton.
 *
 * Core rules under test (mirroring the feature contract):
 *   - toggle OFF ⇒ NO query is issued at all (not fetched-and-hidden);
 *   - toggle ON  ⇒ exactly ONE request per poll cycle for the ACTIVE
 *     channel only;
 *   - dismissal is keyed to the PIN id and persists; a NEW pin id still
 *     appears;
 *   - an endsAt that lapses between polls hides the pin locally;
 *   - unknown `type` values are kept and render generically (never dropped);
 *   - empty is a success and a transport failure degrades to no pin without
 *     throwing into the chat path;
 *   - the render path contains no raw-HTML injection.
 */

import {
  PinnedChatStore,
  toDisplayPin,
  isPinExpired,
  type PinnedChatPin,
} from './pinned-chat.svelte'
import type { PinnedChatMessageData } from './gql'

function fixturePin(over: Partial<PinnedChatMessageData> = {}): PinnedChatMessageData {
  return {
    pinId: 'pin-1',
    messageId: 'msg-1', // deliberately distinct from the pin id
    type: 'MOD',
    startsAt: '2026-09-05T21:33:21Z',
    updatedAt: '2026-09-05T21:33:23Z',
    endsAt: '',
    pinnedBy: { login: 'syanitv', displayName: 'SyaniTV' },
    message: {
      sentAt: '2026-09-05T21:33:18Z',
      text: 'check this https://bit.ly/x',
      fragments: [{ text: 'check this https://bit.ly/x', emoteId: null }],
      sender: { login: 'streamlabs', displayName: 'Streamlabs', chatColor: '#32C3A2', badges: [] },
    },
    ...over,
  }
}

interface Harness {
  store: PinnedChatStore
  fetch: ReturnType<typeof vi.fn>
  resolveUserId: ReturnType<typeof vi.fn>
  setEnabled(v: boolean): void
  advance(ms: number): void
}

// Build a store with spy deps + a controlled clock. `now` is a plain holder
// the deps' now() closes over, so tests can move time deterministically.
function makeHarness(initial: PinnedChatMessageData[][] = []): Harness {
  let enabled = true
  let now = 1_000_000
  const queue = [...initial]
  const fetch = vi.fn(async () => queue.shift() ?? [])
  const resolveUserId = vi.fn(async () => '999')
  const store = new PinnedChatStore({
    fetch: fetch as unknown as (id: string) => Promise<PinnedChatMessageData[]>,
    enabled: () => enabled,
    resolveUserId: resolveUserId as unknown as (login: string) => Promise<string | null>,
    now: () => now,
    intervalMs: 150_000,
  })
  return {
    store,
    fetch,
    resolveUserId,
    setEnabled(v: boolean) { enabled = v },
    advance(ms: number) { now += ms },
  }
}

/** Let the void-refresh() chain settle (fetch + assignment microtasks). */
async function flush(): Promise<void> {
  await new Promise((r) => setTimeout(r, 0))
  await new Promise((r) => setTimeout(r, 0))
}

beforeEach(() => {
  localStorage.clear()
  vi.restoreAllMocks()
})

describe('pinned chat: fetch gating', () => {
  it('issues NO query while the toggle is off (not fetched-and-hidden)', async () => {
    const h = makeHarness()
    h.setEnabled(false)
    h.store.setTarget('trymacs', '64342766')
    h.store.tick()
    h.store.tick()
    await flush()
    expect(h.fetch).not.toHaveBeenCalled()
    expect(h.store.visiblePin).toBeNull()
  })

  it('hides an already-shown pin the moment the toggle turns off', async () => {
    const h = makeHarness([[fixturePin()]])
    h.store.setTarget('trymacs', '64342766')
    await flush()
    expect(h.store.visiblePin).not.toBeNull()
    h.setEnabled(false)
    h.store.tick()
    await flush()
    expect(h.store.visiblePin).toBeNull()
    expect(h.fetch).toHaveBeenCalledTimes(1) // no extra request to hide it
  })

  it('issues exactly one request per poll cycle for the active channel only', async () => {
    const h = makeHarness([[fixturePin()]])
    h.store.setTarget('trymacs', '64342766')
    await flush()
    expect(h.fetch).toHaveBeenCalledTimes(1)
    expect(h.fetch).toHaveBeenCalledWith('64342766')

    // Extra notify() bursts within the same cycle window stay at one request.
    h.store.tick()
    h.store.tick()
    h.store.tick()
    await flush()
    expect(h.fetch).toHaveBeenCalledTimes(1)

    // Past the cycle length the next tick fetches again.
    h.advance(150_001)
    h.store.tick()
    await flush()
    expect(h.fetch).toHaveBeenCalledTimes(2)
  })

  it('a channel switch bypasses the throttle (returning to a channel re-fetches)', async () => {
    const h = makeHarness([[fixturePin()]])
    h.store.setTarget('trymacs', '1')
    await flush()
    h.store.setTarget(null, null)
    h.store.setTarget('trymacs', '1')
    await flush()
    expect(h.fetch).toHaveBeenCalledTimes(2)
  })

  it('falls back to one memoized login→id resolution for callers without a userId', async () => {
    const h = makeHarness([[fixturePin()]])
    h.resolveUserId.mockClear()
    h.store.setTarget('schradin', null) // multi-view path: no status batch
    await flush()
    expect(h.resolveUserId).toHaveBeenCalledTimes(1)
    expect(h.fetch).toHaveBeenCalledWith('999')

    // Next cycle + a channel round-trip reuse the memo — never re-resolve.
    h.advance(150_001)
    h.store.tick()
    h.store.setTarget(null, null)
    h.store.setTarget('schradin', null)
    await flush()
    expect(h.resolveUserId).toHaveBeenCalledTimes(1)
    expect(h.fetch).toHaveBeenCalledTimes(2)
  })
})

describe('pinned chat: response handling', () => {
  it('an empty pin list is a success, not an error', async () => {
    const h = makeHarness([[]])
    h.store.setTarget('chan', '1')
    await flush()
    expect(h.store.pins).toEqual([])
    expect(h.store.visiblePin).toBeNull()
  })

  it('a transport failure degrades to no pin without breaking chat', async () => {
    const h = makeHarness([])
    h.fetch.mockRejectedValue(new Error('HTTP 503'))
    h.store.setTarget('chan', '1')
    await expect(flush()).resolves.toBeUndefined()
    expect(h.store.pins).toEqual([])

    // And it never wipes a pin that was already shown (last-known survives).
    h.fetch.mockResolvedValue([fixturePin()])
    h.advance(150_001)
    h.store.tick()
    await flush()
    expect(h.store.visiblePin).not.toBeNull()
    h.fetch.mockRejectedValue(new Error('HTTP 503'))
    h.advance(150_001)
    h.store.tick()
    await expect(flush()).resolves.toBeUndefined()
    expect(h.store.visiblePin).not.toBeNull()
  })

  it('keeps unknown `type` values (generic rendering, never dropped)', async () => {
    const h = makeHarness([[fixturePin({ type: 'SOME_FUTURE_PAID_TYPE' })]])
    h.store.setTarget('chan', '1')
    await flush()
    const pin = h.store.visiblePin
    expect(pin).not.toBeNull()
    expect(pin!.type).toBe('SOME_FUTURE_PAID_TYPE')
  })
})

describe('pinned chat: expiry between polls', () => {
  it('hides a pin the moment its endsAt passes, without a new fetch', async () => {
    // endsAt is relative to the injected clock (now starts at 1_000_000).
    const endsAt = new Date(1_000_000 + 5 * 60_000).toISOString()
    const h = makeHarness([[fixturePin({ endsAt })]])
    h.store.setTarget('chan', '1')
    await flush()
    const pin = h.store.visiblePin
    expect(pin).not.toBeNull()
    expect(isPinExpired(pin!, h.store.nowMs)).toBe(false)

    // Clock passes endsAt → the visible pin vanishes with no new request.
    const before = h.fetch.mock.calls.length
    h.advance(10 * 60 * 1000)
    h.store.refreshNow()
    expect(h.store.visiblePin).toBeNull()
    expect(h.fetch.mock.calls.length).toBe(before)
  })

  it('a null endsAt (no expiry) never hides the pin', async () => {
    const h = makeHarness([[fixturePin({ endsAt: '' })]])
    h.store.setTarget('chan', '1')
    await flush()
    h.advance(365 * 24 * 60 * 60 * 1000)
    h.store.refreshNow()
    expect(h.store.visiblePin).not.toBeNull()
  })
})

describe('pinned chat: dismissal', () => {
  it('is keyed to the PIN id and survives the next poll', async () => {
    const h = makeHarness([[fixturePin({ pinId: 'pin-a', messageId: 'msg-a' })]])
    h.store.setTarget('chan', '1')
    await flush()
    expect(h.store.visiblePin?.pinId).toBe('pin-a')

    h.store.dismiss('pin-a')
    expect(h.store.visiblePin).toBeNull()

    // Same pin re-served by the next poll stays dismissed…
    h.fetch.mockResolvedValue([fixturePin({ pinId: 'pin-a', messageId: 'msg-a' })])
    h.advance(150_001)
    h.store.tick()
    await flush()
    expect(h.store.visiblePin).toBeNull()

    // …but a NEW pin id appears normally.
    h.fetch.mockResolvedValue([
      fixturePin({ pinId: 'pin-a', messageId: 'msg-a' }),
      fixturePin({ pinId: 'pin-b', messageId: 'msg-b' }),
    ])
    h.advance(150_001)
    h.store.tick()
    await flush()
    expect(h.store.visiblePin?.pinId).toBe('pin-b')
  })

  it('dismissal survives an app restart (persisted, bounded)', async () => {
    const h = makeHarness([[fixturePin({ pinId: 'pin-a' })]])
    h.store.setTarget('chan', '1')
    await flush()
    h.store.dismiss('pin-a')

    // A fresh instance (same localStorage) keeps the dismissal.
    const h2 = makeHarness([])
    expect(h2.store.isDismissed('pin-a')).toBe(true)

    // The persisted store is bounded: MAX_DISMISSED_PINS ids, oldest evicted.
    for (let i = 0; i < 25; i++) h2.store.dismiss('pin-' + i)
    expect(h2.store.isDismissed('pin-a')).toBe(false)
    expect(h2.store.isDismissed('pin-24')).toBe(true)
  })
})

describe('pinned chat: display model', () => {
  it('toDisplayPin keeps pin/message ids distinct and normalizes sender + emote offsets', () => {
    const data = fixturePin({
      pinId: 'pin-1',
      messageId: 'msg-1',
      message: {
        sentAt: '2026-09-05T21:33:18Z',
        text: 'check this Kappa https://bit.ly/x',
        fragments: [
          { text: 'check this ', emoteId: null },
          { text: 'Kappa', emoteId: '1712' },
          { text: ' https://bit.ly/x', emoteId: null },
        ],
        sender: {
          login: 'streamlabs',
          displayName: 'Streamlabs',
          chatColor: 'not-a-color',
          badges: [{ setID: 'moderator', version: '1' }],
        },
      },
    })
    const pin = toDisplayPin(data)
    expect(pin.pinId).toBe('pin-1')
    expect(pin.messageId).toBe('msg-1')
    expect(pin.sender.color).toBe('#ffffff') // normalizeColor fallback
    expect(pin.emoteRanges).toEqual([{ start: 11, end: 15, id: '1712' }])
    // displayBadges go through the IRC badge path (setID/version keys).
    expect(pin.badges.map((b) => b.id + '/' + b.version)).toEqual(['moderator/1'])
    expect(pin.endsAtMs).toBeNull()
    expect(pin.sentAtMs).toBe(Date.parse('2026-09-05T21:33:18Z'))
  })

  it('isPinExpired only fires for a lapsed endsAt', () => {
    const base: PinnedChatPin = {
      pinId: 'p', messageId: 'm', type: 'MOD',
      startsAtMs: null, endsAtMs: null, updatedAtMs: null, sentAtMs: null,
      pinnedBy: { login: 'a', displayName: 'A' },
      sender: { login: 's', displayName: 'S', color: '#ffffff' },
      badges: [], text: 'x', emoteRanges: [],
    }
    expect(isPinExpired(base, 1000)).toBe(false)
    expect(isPinExpired({ ...base, endsAtMs: 999 }, 1000)).toBe(true)
    expect(isPinExpired({ ...base, endsAtMs: 1001 }, 1000)).toBe(false)
  })
})

describe('pinned chat: render path hardening', () => {
  it('contains no raw-HTML injection anywhere in src/', () => {
    // Zero `{@ht` + `ml` injection is a repo-wide invariant (the pin text is
    // remote content); assert it over the whole source tree so a future
    // regression anywhere fails here, not in review. Test files are skipped
    // (this assertion's own source contains the literal).
    const needle = '{@' + 'html'
    const offenders: string[] = []
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = `${dir}/${entry.name}`
        if (entry.isDirectory()) {
          // A stray vitest/vite cache (node_modules) can appear under src/
          // after an odd-cwd run; it is not source and its sourcemaps false-
          // positive the needle.
          if (entry.name === 'node_modules' || entry.name === '.vite') continue
          walk(full); continue
        }
        if (!/\.(svelte|ts|js)$/.test(entry.name) || entry.name.includes('.test.')) continue
        if (readFileSync(full, 'utf8').includes(needle)) offenders.push(full)
      }
    }
    walk('src')
    expect(offenders).toEqual([])
  })
})
