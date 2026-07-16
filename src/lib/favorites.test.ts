import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

/*
 * Unit tests for src/lib/favorites.svelte.
 *
 * The DecAPI network layer is fully mocked: every `invoke('decapi_fetch')`
 * call is routed through `decapi.handler`, and each call is recorded (with the
 * fake/real clock timestamp) in `decapi.calls`. `./settings.svelte.ts` and
 * `./notifications.svelte.ts` are stubbed so the module under test is the only
 * real code exercised. Each test re-imports the module (`vi.resetModules`) so
 * the global limiter state (lastFetchAt) and the store singleton start clean.
 */

const decapi = vi.hoisted(() => ({
  handler: async (_path: string): Promise<string> => {
    throw new Error('decapi handler not configured for this test')
  },
  calls: [] as { path: string; ts: number }[],
}))

vi.mock('@tauri-apps/api/core', () => ({
  invoke: (cmd: string, args: Record<string, unknown>): Promise<unknown> => {
    if (cmd !== 'decapi_fetch') return Promise.reject(new Error('unexpected invoke: ' + cmd))
    const path = String(args.path ?? '')
    decapi.calls.push({ path, ts: Date.now() })
    return Promise.resolve(decapi.handler(path))
  },
  isTauri: () => false,
}))
vi.mock('./notifications.svelte.ts', () => ({ notifications: { record: () => {} } }))
vi.mock('./settings.svelte.ts', () => ({ settings: { sortMode: 'manual' } }))

type FavMod = typeof import('./favorites.svelte')
let F: FavMod

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

function seedFavorites(names: string[]): void {
  const now = Date.now()
  localStorage.setItem(
    'twitch-favorites-v1',
    JSON.stringify(names.map((name, i) => ({ name, addedAt: now + i, order: i + 1 }))),
  )
}

function seedStatusCache(
  entries: Record<string, { live?: boolean; avatar?: string; title?: string; viewers?: number; game?: string }>,
  ageMs = 60_000,
): void {
  const ts = Date.now() - ageMs
  const obj: Record<string, unknown> = {}
  for (const [name, e] of Object.entries(entries)) {
    const status = e.live
      ? {
          state: 'live',
          title: e.title ?? 'title-' + name,
          viewers: e.viewers ?? 7,
          uptime: '1h',
          game: e.game ?? 'game-' + name,
          avatarUrl: e.avatar ?? 'https://img/' + name + '.png',
        }
      : { state: 'offline', avatarUrl: e.avatar ?? 'https://img/' + name + '.png' }
    obj[name] = { name, status, lastFetched: ts }
  }
  localStorage.setItem('fav-status-cache-v1', JSON.stringify(obj))
  localStorage.setItem('fav-status-cache-ts-v1', String(ts))
}

/** Build a handler that resolves canned responses per channel. */
function multiHandler(
  channels: Record<string, { live?: boolean; avatar?: string }>,
): (path: string) => Promise<string> {
  return async (path) => {
    const [, endpoint, ch] = path.split('/')
    const cfg = channels[ch]
    if (!cfg) throw new Error('HTTP 404 unknown channel ' + ch)
    if (endpoint === 'uptime') return cfg.live ? '1h 2m' : ch + ' is offline'
    if (endpoint === 'avatar') return cfg.avatar ?? 'https://img/' + ch + '.png'
    if (endpoint === 'title') return 'title-' + ch
    if (endpoint === 'viewercount') return '11'
    if (endpoint === 'game') return 'game-' + ch
    throw new Error('HTTP 500 unknown endpoint ' + endpoint)
  }
}

function invokes(filter: { channel?: string; endpoint?: string }): { path: string; ts: number }[] {
  return decapi.calls.filter((c) => {
    const [, endpoint, ch] = c.path.split('/')
    if (filter.channel && ch !== filter.channel) return false
    if (filter.endpoint && endpoint !== filter.endpoint) return false
    return true
  })
}

beforeEach(async () => {
  vi.resetModules()
  localStorage.clear()
  decapi.calls.length = 0
  decapi.handler = async () => {
    throw new Error('decapi handler not configured')
  }
  F = await import('./favorites.svelte')
})

afterEach(() => {
  vi.useRealTimers()
})

describe('fetchLiveStatus ordering', () => {
  it('resolves uptime (status) before fetching the avatar', async () => {
    decapi.handler = multiHandler({ foo: {} })
    await F.fetchLiveStatus('foo')
    const ordered = decapi.calls.map((c) => c.path)
    const upIdx = ordered.findIndex((p) => p.includes('/uptime/'))
    const avIdx = ordered.findIndex((p) => p.includes('/avatar/'))
    expect(upIdx).toBeGreaterThanOrEqual(0)
    expect(avIdx).toBeGreaterThanOrEqual(0)
    expect(upIdx).toBeLessThan(avIdx)
  })

  it('returns an error for uptime without making any avatar request', async () => {
    decapi.handler = async (path) => {
      if (path.includes('/uptime/')) throw new Error('HTTP 503')
      throw new Error('should not be called')
    }
    const status = await F.fetchLiveStatus('bar')
    expect(status.state).toBe('error')
    expect(invokes({ endpoint: 'avatar' })).toHaveLength(0)
  })
})

describe('avatar / metadata cache hydration', () => {
  it('reuses a persisted avatar after store hydration (no avatar request)', async () => {
    seedFavorites(['cached'])
    seedStatusCache({ cached: { avatar: 'https://img/cached.png' } }) // offline, fresh
    decapi.handler = multiHandler({ cached: {} })
    const store = new F.FavoritesStore()
    store.start()
    await delay(1500) // uptime-only (avatar cached) -> ~1 limiter slot
    expect(invokes({ channel: 'cached', endpoint: 'avatar' })).toHaveLength(0)
    expect(invokes({ channel: 'cached', endpoint: 'uptime' })).toHaveLength(1)
    const s = store.getStatus('cached')!.status
    expect(s.state).toBe('offline')
    if (s.state === 'offline') expect(s.avatarUrl).toBe('https://img/cached.png')
  })
})

describe('stale-response guard', () => {
  it('an older in-flight request cannot overwrite a newer result', async () => {
    seedFavorites(['stale'])
    seedStatusCache({ stale: { live: true } }) // live+fresh -> metadata cached, avatar cached
    let staleCalls = 0
    let resolveOld!: (v: string) => void
    const oldPromise = new Promise<string>((r) => {
      resolveOld = r
    })
    decapi.handler = async (path) => {
      const [, endpoint, ch] = path.split('/')
      if (endpoint === 'uptime' && ch === 'stale') {
        staleCalls++
        if (staleCalls === 1) return oldPromise // old fetch hangs...
        return '1h' // ...re-added fetch resolves LIVE
      }
      throw new Error('unexpected endpoint ' + endpoint)
    }
    const store = new F.FavoritesStore()
    store.start()
    await delay(80) // let the old uptime call fire & hang
    store.remove('stale') // bumps version, invalidates the old fetch
    store.add('stale') // new version, fresh fetch resolves to live
    await delay(1200) // new uptime resolves -> live
    resolveOld('stale is offline') // now the OLD response finally lands (offline)
    await delay(1200) // ...and must be discarded
    const s = store.getStatus('stale')!.status
    expect(s.state).toBe('live') // newer result wins
  })
})

describe('rate limiter', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  it('spaces every request at least MIN_FETCH_GAP_MS apart (no bursts)', async () => {
    const channels: Record<string, { live?: boolean }> = {}
    for (let i = 0; i < 30; i++) channels['ch' + i] = {}
    decapi.handler = multiHandler(channels)
    const pending: Promise<unknown>[] = []
    for (const name of Object.keys(channels)) pending.push(F.fetchLiveStatus(name))
    await vi.advanceTimersByTimeAsync(60_000)
    const ts = [...decapi.calls].sort((a, b) => a.ts - b.ts).map((c) => c.ts)
    expect(ts.length).toBeGreaterThan(0)
    for (let i = 1; i < ts.length; i++) {
      expect(ts[i] - ts[i - 1]).toBeGreaterThanOrEqual(650)
    }
  })

  it('keeps the 60s request count within DecAPI budget (~100/min)', async () => {
    const channels: Record<string, { live?: boolean }> = {}
    for (let i = 0; i < 50; i++) channels['ch' + i] = {}
    decapi.handler = multiHandler(channels)
    for (const name of Object.keys(channels)) void F.fetchLiveStatus(name)
    await vi.advanceTimersByTimeAsync(90_000)
    const ts = decapi.calls.map((c) => c.ts).sort((a, b) => a - b)
    // Max requests in any rolling 60s window. 650ms gap => <= 93/min.
    let worst = 0
    for (let i = 0; i < ts.length; i++) {
      const lo = ts[i]
      const inWindow = ts.filter((t) => t >= lo && t < lo + 60_000).length
      worst = Math.max(worst, inWindow)
    }
    expect(worst).toBeLessThanOrEqual(100)
    expect(worst).toBeLessThanOrEqual(93)
  })
})

describe('FavoritesStore — circuit breaker & retries', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.spyOn(Math, 'random').mockReturnValue(0) // deterministic jitter
  })

  it('a 429 activates the cooldown (rateLimited flag)', async () => {
    seedFavorites(['alpha'])
    let count = 0
    decapi.handler = async (path) => {
      if (path.includes('/uptime/')) {
        count++
        if (count === 1) throw new Error('HTTP 429')
        return 'alpha is offline'
      }
      if (path.includes('/avatar/')) return 'https://img/alpha.png'
      throw new Error('HTTP 500')
    }
    const store = new F.FavoritesStore()
    store.start()
    await vi.advanceTimersByTimeAsync(2_000)
    expect(store.rateLimited).toBe(true)
  })

  it('a request skipped during a global cooldown is eventually retried', async () => {
    seedFavorites(['alpha', 'beta'])
    let count = 0
    decapi.handler = async (path) => {
      const [, endpoint, ch] = path.split('/')
      if (endpoint === 'uptime') {
        count++
        if (count === 1) throw new Error('HTTP 429') // alpha trips the breaker
        return ch + ' is offline' // everyone else resolves offline
      }
      if (endpoint === 'avatar') return 'https://img/' + ch + '.png'
      throw new Error('HTTP 500')
    }
    const store = new F.FavoritesStore()
    store.start()
    await vi.advanceTimersByTimeAsync(1_000) // alpha 429s + trips breaker; beta is skipped
    expect(store.getStatus('beta')!.status.state).toBe('unknown') // not yet resolved
    // advance well past the 30s cooldown + jitter; the skipped channel retries
    await vi.advanceTimersByTimeAsync(60_000)
    expect(store.getStatus('beta')!.status.state).toBe('offline')
    expect(store.getStatus('alpha')!.status.state).toBe('offline')
    expect(store.rateLimited).toBe(false)
    expect(invokes({ channel: 'beta', endpoint: 'uptime' }).length).toBeGreaterThanOrEqual(1)
  })

  it('rapid re-triggering does not create duplicate work (single retry path)', async () => {
    seedFavorites(['solo'])
    let count = 0
    decapi.handler = async (path) => {
      if (path.includes('/uptime/')) {
        count++
        if (count === 1) throw new Error('HTTP 429')
        return 'solo is offline'
      }
      if (path.includes('/avatar/')) return 'https://img/solo.png'
      throw new Error('HTTP 500')
    }
    const store = new F.FavoritesStore()
    store.start()
    await vi.advanceTimersByTimeAsync(1_000) // breaker tripped, retry scheduled
    // hammer it while a retry is pending + cooldown active
    store.retryFetch('solo')
    store.retryFetch('solo')
    store.retryFetch('solo')
    await vi.advanceTimersByTimeAsync(60_000) // past cooldown -> single retry fires
    expect(store.getStatus('solo')!.status.state).toBe('offline')
    // exactly one 429 + one success, never duplicated
    expect(invokes({ channel: 'solo', endpoint: 'uptime' })).toHaveLength(2)
  })

  it('removing a favorite cancels its pending retry', async () => {
    seedFavorites(['gone'])
    decapi.handler = async (path) => {
      if (path.includes('/uptime/')) throw new Error('HTTP 429')
      if (path.includes('/avatar/')) return 'https://img/gone.png'
      throw new Error('HTTP 500')
    }
    const store = new F.FavoritesStore()
    store.start()
    await vi.advanceTimersByTimeAsync(1_000) // 429 -> breaker + retry scheduled
    store.remove('gone')
    const before = invokes({ channel: 'gone' }).length
    await vi.advanceTimersByTimeAsync(60_000) // well past cooldown
    expect(invokes({ channel: 'gone' }).length).toBe(before) // no further fetch
    expect(store.getStatus('gone')).toBeUndefined()
  })

  it('disposing the store clears timers and prevents further requests', async () => {
    seedFavorites(['d1'])
    decapi.handler = async (path) => {
      if (path.includes('/uptime/')) throw new Error('HTTP 429')
      if (path.includes('/avatar/')) return 'https://img/d1.png'
      throw new Error('HTTP 500')
    }
    const store = new F.FavoritesStore()
    store.start()
    await vi.advanceTimersByTimeAsync(1_000) // 429 -> retry scheduled
    store.dispose()
    const before = invokes({ channel: 'd1' }).length
    await vi.advanceTimersByTimeAsync(60_000)
    expect(invokes({ channel: 'd1' }).length).toBe(before)
  })
})

describe('FavoritesStore — startup polling', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.spyOn(Math, 'random').mockReturnValue(0) // deterministic jitter
  })

  it('does not re-poll already-live channels during the aggressive phase', async () => {
    seedFavorites(['live1'])
    seedStatusCache({ live1: { live: true } }) // fresh metadata -> uptime-only at startup
    decapi.handler = multiHandler({ live1: { live: true } })
    const store = new F.FavoritesStore()
    store.start()
    await vi.advanceTimersByTimeAsync(135_000) // startup fetch + 120s aggressive poll
    // live => excluded from the aggressive poll: only the startup fetch fires
    expect(invokes({ channel: 'live1', endpoint: 'uptime' })).toHaveLength(1)
  })

  it('no favorite is left unknown after a startup breaker trip', async () => {
    // The first uptime call 429s and trips the 30s breaker; every later
    // channel's initial fetch lands during the cooldown and is skipped. With
    // the fix those skipped fetches are retried after the cooldown and every
    // channel resolves; without it they stay 'unknown' until the ~10-min poll.
    const names = ['c0', 'c1', 'c2', 'c3', 'c4', 'c5']
    seedFavorites(names)
    let first = true
    decapi.handler = async (path) => {
      const [, endpoint, ch] = path.split('/')
      if (endpoint === 'uptime') {
        if (first) {
          first = false
          throw new Error('HTTP 429')
        }
        return ch + ' is offline'
      }
      if (endpoint === 'avatar') return 'https://img/' + ch + '.png'
      throw new Error('HTTP 500')
    }
    const store = new F.FavoritesStore()
    store.start()
    await vi.advanceTimersByTimeAsync(1_000) // breaker tripped, c1..c5 skipped
    const stuckEarly = names.filter((n) => store.getStatus(n)!.status.state === 'unknown')
    expect(stuckEarly.length).toBeGreaterThan(0) // confirms the skip actually happened
    await vi.advanceTimersByTimeAsync(60_000) // past cooldown -> retries resolve them
    for (const n of names) {
      expect(store.getStatus(n)!.status.state).toBe('offline')
    }
    expect(store.rateLimited).toBe(false)
  })
})

describe('status publication before enrichment (Phase 1 / Phase 2)', () => {
  // Real timers + deferred promises: lets us observe the intermediate state
  // where uptime has resolved but cosmetic requests are still pending.
  function callIndex(substr: string): number {
    return decapi.calls.findIndex((c) => c.path.includes(substr))
  }

  it('publishes offline before avatar enrichment completes', async () => {
    seedFavorites(['x']) // cold (no cache)
    let resolveAvatar!: (v: string) => void
    const avatarPending = new Promise<string>((r) => {
      resolveAvatar = r
    })
    decapi.handler = async (path) => {
      if (path.includes('/uptime/')) return 'x is offline'
      if (path.includes('/avatar/')) return avatarPending // hangs
      throw new Error('no')
    }
    const store = new F.FavoritesStore()
    store.start()
    await delay(1200) // uptime resolves + classifies; avatar still pending
    const s = store.getStatus('x')!.status
    expect(s.state).toBe('offline') // classified despite avatar pending
    expect(invokes({ channel: 'x', endpoint: 'avatar' })).toHaveLength(1) // avatar requested
    resolveAvatar('https://img/x.png')
    await delay(1200) // enrichment applies the avatar
    const s2 = store.getStatus('x')!.status
    expect(s2.state).toBe('offline')
    if (s2.state === 'offline') expect(s2.avatarUrl).toBe('https://img/x.png')
  })

  it('publishes live before metadata enrichment completes', async () => {
    seedFavorites(['y']) // cold
    let resolveMeta!: () => void
    const metaPending = new Promise<void>((r) => {
      resolveMeta = r
    })
    decapi.handler = async (path) => {
      if (path.includes('/uptime/')) return '2h' // live
      if (path.includes('/avatar/')) return 'https://img/y.png'
      return metaPending.then(() => 'fresh') // title/viewers/game hang
    }
    const store = new F.FavoritesStore()
    store.start()
    await delay(1500) // uptime + avatar resolve; live metadata hangs
    const s = store.getStatus('y')!.status
    expect(s.state).toBe('live') // classified live, metadata still pending
    resolveMeta()
    await delay(1500)
    expect(store.getStatus('y')!.status.state).toBe('live')
  }, 20000)

  it('enrichment failure does not revert a classified status (offline)', async () => {
    seedFavorites(['z']) // cold
    decapi.handler = async (path) => {
      if (path.includes('/uptime/')) return 'z is offline'
      if (path.includes('/avatar/')) throw new Error('HTTP 500') // avatar fails
      throw new Error('no')
    }
    const store = new F.FavoritesStore()
    store.start()
    await delay(1500)
    const s = store.getStatus('z')!.status
    expect(s.state).toBe('offline') // stays classified, not error/unknown
    if (s.state === 'offline') expect(s.avatarUrl).toBe('') // failure kept empty, not reverted
  })

  it('live metadata enrichment failure keeps the channel classified live', async () => {
    seedFavorites(['w']) // cold
    decapi.handler = async (path) => {
      if (path.includes('/uptime/')) return '1h' // live
      if (path.includes('/avatar/')) return 'https://img/w.png'
      throw new Error('HTTP 500') // title/viewers/game fail
    }
    const store = new F.FavoritesStore()
    store.start()
    await delay(3000)
    const s = store.getStatus('w')!.status
    expect(s.state).toBe('live') // not reverted to error/unknown
  })

  it('a later channel uptime is not delayed by an earlier channel avatar', async () => {
    // Startup enrichment is deferred until all uptime requests are queued, so
    // b's uptime lands before a's (slow) avatar enrichment in the FIFO limiter.
    seedFavorites(['a', 'b'])
    let resolveAAvatar!: (v: string) => void
    const aAvatar = new Promise<string>((r) => {
      resolveAAvatar = r
    })
    decapi.handler = async (path) => {
      const [, endpoint, ch] = path.split('/')
      if (endpoint === 'uptime') return ch + ' is offline'
      if (endpoint === 'avatar') return ch === 'a' ? aAvatar : 'https://img/b.png'
      throw new Error('HTTP 500')
    }
    const store = new F.FavoritesStore()
    store.start()
    await delay(2000)
    expect(callIndex('uptime/b')).toBeGreaterThanOrEqual(0)
    expect(callIndex('avatar/a')).toBeGreaterThanOrEqual(0)
    expect(callIndex('uptime/b')).toBeLessThan(callIndex('avatar/a'))
    resolveAAvatar('https://img/a.png')
    await delay(1500)
  })
})

describe('global-cooldown deferrals vs real failures', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.spyOn(Math, 'random').mockReturnValue(0)
  })

  it('a deferred request does not consume the failure budget', async () => {
    seedFavorites(['a', 'b'])
    let first = true
    decapi.handler = async (path) => {
      const [, endpoint, ch] = path.split('/')
      if (endpoint === 'uptime') {
        if (first) {
          first = false
          throw new Error('HTTP 429') // a trips the breaker once
        }
        return ch + ' is offline'
      }
      if (endpoint === 'avatar') return 'https://img/' + ch + '.png'
      throw new Error('HTTP 500')
    }
    const store = new F.FavoritesStore()
    store.start()
    await vi.advanceTimersByTimeAsync(1_000) // a 429s; b deferred (NOT a failure)
    const bEarly = store.getStatus('b')!
    expect(bEarly.updateDelayed).toBe(false) // deferral is not a failure
    expect(bEarly.lastError).toBeNull()
    await vi.advanceTimersByTimeAsync(60_000) // past cooldown -> both resolve
    for (const n of ['a', 'b']) {
      const s = store.getStatus(n)!
      expect(s.status.state).toBe('offline')
      expect(s.updateDelayed).toBe(false)
      expect(s.lastError).toBeNull()
    }
    // b never made a failing request: exactly one (successful) uptime call.
    expect(invokes({ channel: 'b', endpoint: 'uptime' })).toHaveLength(1)
  })

  it('sustained cooldown deferrals do not mark a channel stale (only real failures do)', async () => {
    // a ALWAYS 429s, so it keeps re-tripping the breaker and accumulates real
    // failures until it goes stale. b only ever gets deferred (never reaches
    // the network while the breaker is up). With the fix, b's deferrals do not
    // touch its failure counter, so b must NOT be marked stale even after many
    // deferral cycles — whereas a, which made real failing requests, is stale.
    seedFavorites(['a', 'b'])
    decapi.handler = async (path) => {
      const [, endpoint, ch] = path.split('/')
      if (endpoint === 'uptime') {
        if (ch === 'a') throw new Error('HTTP 429')
        return ch + ' is offline'
      }
      if (endpoint === 'avatar') return 'https://img/' + ch + '.png'
      throw new Error('HTTP 500')
    }
    const store = new F.FavoritesStore()
    store.start()
    await vi.advanceTimersByTimeAsync(1_800_000) // ~30 min: a exhausts its retries
    expect(store.getStatus('a')!.updateDelayed).toBe(true) // real failures -> stale
    const b = store.getStatus('b')!
    expect(b.updateDelayed).toBe(false) // deferrals never counted as failures
    expect(b.lastError).toBeNull()
  }, 30000)
})

describe('deferred enrichment priority ordering', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.spyOn(Math, 'random').mockReturnValue(0)
  })

  function paths(): string[] {
    return decapi.calls.map((c) => c.path)
  }

  it('enriches a live channel before an earlier-listed offline channel avatar', async () => {
    // offline is listed FIRST in favorite order; the live channel must still
    // enrich first. Fails under the old "favorite-order, avatar-first" flush.
    seedFavorites(['offchan', 'livechan'])
    decapi.handler = multiHandler({ offchan: {}, livechan: { live: true } })
    const store = new F.FavoritesStore()
    store.start()
    await vi.advanceTimersByTimeAsync(20_000)
    const order = paths()
    const liveMeta = order.findIndex((p) => p.includes('title/livechan'))
    const offAvatar = order.findIndex((p) => p.includes('avatar/offchan'))
    expect(liveMeta).toBeGreaterThanOrEqual(0)
    expect(offAvatar).toBeGreaterThanOrEqual(0)
    expect(liveMeta).toBeLessThan(offAvatar)
  })

  it('queues all live metadata before any offline avatar', async () => {
    seedFavorites(['off1', 'live1', 'off2', 'live2'])
    decapi.handler = multiHandler({
      off1: {},
      live1: { live: true },
      off2: {},
      live2: { live: true },
    })
    const store = new F.FavoritesStore()
    store.start()
    await vi.advanceTimersByTimeAsync(30_000)
    const order = paths()
    const firstOfflineAvatar = order.findIndex((p) => /avatar\/off/.test(p))
    expect(firstOfflineAvatar).toBeGreaterThan(0)
    order.forEach((p, i) => {
      if (/\/(title|viewercount|game)\/live/.test(p)) {
        expect(i).toBeLessThan(firstOfflineAvatar)
      }
    })
  })

  it('queues live metadata before live avatars', async () => {
    seedFavorites(['live1', 'live2'])
    decapi.handler = multiHandler({ live1: { live: true }, live2: { live: true } })
    const store = new F.FavoritesStore()
    store.start()
    await vi.advanceTimersByTimeAsync(20_000)
    const order = paths()
    const firstAvatar = order.findIndex((p) => p.includes('/avatar/'))
    expect(firstAvatar).toBeGreaterThan(0)
    order.forEach((p, i) => {
      if (/\/(title|viewercount|game)\//.test(p)) expect(i).toBeLessThan(firstAvatar)
    })
  })

  it('queues live avatars before offline avatars', async () => {
    // Discriminates the phased flush from a naive favorite-order flush: with
    // offline listed first, the live channel's avatar must still precede the
    // offline channel's avatar.
    seedFavorites(['offchan', 'livechan'])
    decapi.handler = multiHandler({ offchan: {}, livechan: { live: true } })
    const store = new F.FavoritesStore()
    store.start()
    await vi.advanceTimersByTimeAsync(20_000)
    const order = paths()
    const liveAvatar = order.findIndex((p) => p.includes('avatar/livechan'))
    const offAvatar = order.findIndex((p) => p.includes('avatar/offchan'))
    expect(liveAvatar).toBeGreaterThanOrEqual(0)
    expect(offAvatar).toBeGreaterThanOrEqual(0)
    expect(liveAvatar).toBeLessThan(offAvatar)
  })

  it('does not fetch live metadata for offline channels', async () => {
    seedFavorites(['off1'])
    decapi.handler = multiHandler({ off1: {} })
    const store = new F.FavoritesStore()
    store.start()
    await vi.advanceTimersByTimeAsync(10_000)
    expect(decapi.calls.some((c) => /\/(title|viewercount|game)\//.test(c.path))).toBe(false)
  })

  it('a favorite removed before its deferred enrichment runs is never enriched', async () => {
    // Channel classified, queued for deferred enrichment, then removed before
    // the enrichment batch is flushed (before classifyBatchPending hits 0).
    seedFavorites(['keep', 'gone'])
    decapi.handler = multiHandler({ keep: {}, gone: {} })
    const store = new F.FavoritesStore()
    store.start()
    // 'gone' is the 2nd (last) entry; its fetchOne settling flushes enrichment.
    // Remove it first so the deferred entry is invalidated by version.
    store.remove('gone')
    await vi.advanceTimersByTimeAsync(15_000)
    expect(store.getStatus('gone')).toBeUndefined()
    expect(invokes({ channel: 'gone', endpoint: 'avatar' })).toHaveLength(0)
    expect(invokes({ channel: 'gone', endpoint: 'uptime' })).toHaveLength(0)
  })
})

describe('enrichment respects latest state', () => {
  it('does not apply stale live metadata after the channel goes offline', async () => {
    // lc is classified live, its metadata enrichment is launched but hangs.
    // While it hangs, lc is reclassified offline. When the stale metadata
    // resolves, it must NOT be cached (else a later live re-classification
    // would show the stale title instead of refreshing).
    seedFavorites(['lc'])
    let resolveMeta!: () => void
    const metaPending = new Promise<void>((r) => {
      resolveMeta = r
    })
    let upCount = 0
    let titleCalls = 0
    decapi.handler = async (path) => {
      if (path.includes('/uptime/')) return ++upCount === 2 ? 'lc is offline' : '1h'
      if (path.includes('/avatar/')) return 'https://img/lc.png'
      if (path.includes('/title/')) {
        titleCalls++
        return titleCalls === 1 ? metaPending.then(() => 'STALE_TITLE') : 'FRESH_TITLE'
      }
      if (path.includes('/viewercount/')) return '10'
      if (path.includes('/game/')) return 'GAME'
      throw new Error('no')
    }
    const store = new F.FavoritesStore()
    store.start()
    await delay(1500) // classify live; enrichMetadata launched, metadata hangs
    expect(store.getStatus('lc')!.status.state).toBe('live')
    store.retryFetch('lc') // reclassify offline (uptime #2)
    await delay(2500) // -> offline (metadata still hanging)
    expect(store.getStatus('lc')!.status.state).toBe('offline')
    resolveMeta() // stale live metadata lands
    await delay(1000)
    expect(store.getStatus('lc')!.status.state).toBe('offline') // not reverted
    store.retryFetch('lc') // reclassify live (uptime #3)
    await delay(3000) // metadata refreshed
    const s = store.getStatus('lc')!.status
    expect(s.state).toBe('live')
    if (s.state === 'live') expect(s.title).toBe('FRESH_TITLE') // not the stale value
  }, 30000)
})
