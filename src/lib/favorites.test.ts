import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import type { ChannelStatus } from './gql'

/*
 * Unit tests for src/lib/favorites.svelte.
 *
 * GQL is the ONLY data source, so the Tauri `gql_fetch` transport is the sole
 * thing mocked: every `invoke('gql_fetch')` routes through `gql.handler`
 * (swappable per test), and each call is recorded in `gql.calls`.
 * `./settings.svelte.ts` and `./notifications.svelte.ts` are stubbed so the
 * module under test is the only real code exercised. Each test re-imports the
 * module (`vi.resetModules`) so the store singleton + breaker state start clean.
 *
 * The central behaviors under test:
 *  - one batched GQL request resolves the whole list (live/offline/null = ok);
 *  - on a GQL transport failure there is NO fallback — channels keep their
 *    last-known status, the circuit breaker trips (rateLimited banner), and a
 *    backoff retry of the SAME batch is scheduled;
 *  - a successful retry clears the breaker and refreshes statuses;
 *  - fetchLiveStatus resolves a single channel via the same transport.
 */

const gql = vi.hoisted(() => ({
  handler: async (_body: string): Promise<string> => {
    throw new Error('gql handler not configured for this test')
  },
  calls: [] as { body: string; ts: number }[],
}))

vi.mock('@tauri-apps/api/core', () => ({
  invoke: (cmd: string, args: Record<string, unknown>): Promise<unknown> => {
    if (cmd === 'gql_fetch') {
      const body = String(args.body ?? '')
      gql.calls.push({ body, ts: Date.now() })
      return Promise.resolve(gql.handler(body))
    }
    return Promise.reject(new Error('unexpected invoke: ' + cmd))
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

interface ChanCfg {
  live?: boolean
  viewers?: number
  title?: string
  game?: string
  avatar?: string
  // Numeric Twitch user id (needed for the collaboration roster follow-up;
  // non-numeric defaults never trigger it).
  id?: string
  collabViewers?: number
  collabOthers?: number
  collabAvatar?: string
}

/**
 * Build a gql_fetch handler returning a canned users(logins:) response.
 * The follow-up collaboration roster request (one aliased channel(id:)
 * query for the poll's session channels) is answered with "no session" for
 * every alias unless a per-test `roster` handler overrides it.
 */
function gqlStatusHandler(
  cfg: Record<string, ChanCfg | null>,
  opts: { fail?: 'transport'; roster?: (id: string) => unknown } = {},
): (body: string) => Promise<string> {
  return async (body) => {
    if (opts.fail === 'transport') throw new Error('HTTP 500')
    const parsed = JSON.parse(body)
    // Match the roster query by its OPERATION name — a bare
    // 'collaboration' substring would also hit collaborationViewersCount
    // in the status query.
    if (typeof parsed.query === 'string' && parsed.query.includes('CollaborationRoster')) {
      // CollaborationRoster(ids...) — alias c0, c1, ... keyed by id0, id1...
      const data: Record<string, unknown> = {}
      for (const [k, v] of Object.entries(parsed.variables as Record<string, string>)) {
        data[k.replace('id', 'c')] = {
          collaboration: opts.roster ? opts.roster(v) : null,
        }
      }
      return JSON.stringify({ data })
    }
    const logins: string[] = parsed.variables.logins
    const users = logins.map((login) => {
      const c = cfg[login]
      if (!c) return null // nonexistent login -> positional null entry
      if (!c.live) {
        return {
          id: c.id ?? 'id-' + login,
          login,
          displayName: login,
          profileImageURL: c.avatar ?? 'https://img/' + login + '.png',
          stream: null,
        }
      }
      return {
        id: c.id ?? 'id-' + login,
        login,
        displayName: login,
        profileImageURL: c.avatar ?? 'https://img/' + login + '.png',
        stream: {
          id: 's-' + login,
          title: c.title ?? 'title-' + login,
          type: 'live',
          viewersCount: c.viewers ?? 11,
          createdAt: new Date(Date.now() - 3600_000).toISOString(),
          previewImageURL: 'https://thumb/' + login + '.jpg',
          collaborationViewersCount: c.collabViewers ?? null,
          costreamDetails: c.collabOthers
            ? {
                costreamersCount: c.collabOthers,
                totalViewersCount: c.collabViewers ?? null,
                topCostreamers: c.collabAvatar ? [{ profileImageURL: c.collabAvatar }] : [],
              }
            : null,
          game: { id: 'g', name: c.game ?? 'game-' + login, displayName: c.game ?? 'game-' + login, boxArtURL: 'https://box/' + login + '.jpg' },
        },
      }
    })
    return JSON.stringify({ data: { users } })
  }
}

beforeEach(async () => {
  vi.resetModules()
  localStorage.clear()
  gql.calls.length = 0
  gql.handler = async () => {
    throw new Error('gql handler not configured')
  }
  F = await import('./favorites.svelte')
})

afterEach(() => {
  vi.useRealTimers()
})

describe('GQL batch resolves the whole list', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.spyOn(Math, 'random').mockReturnValue(0)
  })

  it('resolves every favorite from a SINGLE GQL request', async () => {
    seedFavorites(['alpha', 'beta', 'gamma'])
    gql.handler = gqlStatusHandler({
      alpha: { live: true, viewers: 42, title: 'AlphaTitle', game: 'AlphaGame' },
      beta: { live: false },
      gamma: { live: true },
    })
    const store = new F.FavoritesStore()
    store.start()
    await vi.advanceTimersByTimeAsync(5_000)
    const a = store.getStatus('alpha')!.status
    const b = store.getStatus('beta')!.status
    const g = store.getStatus('gamma')!.status
    expect(a.state).toBe('live')
    if (a.state === 'live') {
      expect(a.title).toBe('AlphaTitle')
      expect(a.game).toBe('AlphaGame')
      expect(a.viewers).toBe(42)
      expect(a.avatarUrl).toBe('https://img/alpha.png')
      expect(a.uptime).toBeTruthy() // derived from createdAt
    }
    expect(b.state).toBe('offline')
    if (b.state === 'offline') expect(b.avatarUrl).toBe('https://img/beta.png')
    expect(g.state).toBe('live')
    expect(store.rateLimited).toBe(false)
    // Exactly one batched gql_fetch for the whole list.
    expect(gql.calls).toHaveLength(1)
  })

  it('an offline channel (stream: null) and a nonexistent login are both successes', async () => {
    seedFavorites(['liveone', 'offone', 'ghost'])
    gql.handler = gqlStatusHandler({
      liveone: { live: true },
      offone: { live: false }, // stream: null
      ghost: null, // positional null (nonexistent)
    })
    const store = new F.FavoritesStore()
    store.start()
    await vi.advanceTimersByTimeAsync(5_000)
    expect(store.getStatus('liveone')!.status.state).toBe('live')
    expect(store.getStatus('offone')!.status.state).toBe('offline')
    // A null entry keeps its input login + empty fields; treated as offline.
    expect(store.getStatus('ghost')!.status.state).toBe('offline')
    expect(store.rateLimited).toBe(false)
    expect(gql.calls).toHaveLength(1)
  })
})

describe('GQL transport failure — no fallback', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.spyOn(Math, 'random').mockReturnValue(0)
  })

  it('keeps last-known status, trips the breaker, and shows rateLimited', async () => {
    seedFavorites(['alpha', 'beta'])
    // First poll succeeds: alpha live, beta offline.
    gql.handler = gqlStatusHandler({ alpha: { live: true }, beta: { live: false } })
    const store = new F.FavoritesStore()
    store.start()
    await vi.advanceTimersByTimeAsync(5_000)
    expect(store.getStatus('alpha')!.status.state).toBe('live')
    expect(store.getStatus('beta')!.status.state).toBe('offline')
    expect(store.rateLimited).toBe(false)
    const callsAfterSuccess = gql.calls.length

    // Now GQL goes down. retryFetch forces a poll (no per-channel fetch
    // exists anymore — it just re-runs the batch), which fails.
    gql.handler = gqlStatusHandler({}, { fail: 'transport' })
    store.retryFetch('alpha')
    await vi.advanceTimersByTimeAsync(2_000)
    expect(store.rateLimited).toBe(true) // breaker tripped
    // Last-known statuses are RETAINED — never reset to error/unknown.
    expect(store.getStatus('alpha')!.status.state).toBe('live')
    expect(store.getStatus('beta')!.status.state).toBe('offline')
    expect(gql.calls.length).toBeGreaterThan(callsAfterSuccess) // GQL was attempted
  })

  it('a backoff retry of the SAME batch recovers and clears the breaker', async () => {
    seedFavorites(['alpha', 'beta'])
    // Initial poll fails -> breaker trips (30s cooldown), retry scheduled.
    gql.handler = gqlStatusHandler({}, { fail: 'transport' })
    const store = new F.FavoritesStore()
    store.start()
    await vi.advanceTimersByTimeAsync(2_000)
    expect(store.rateLimited).toBe(true)
    expect(store.getStatus('alpha')!.status.state).toBe('unknown') // never resolved yet
    const failedCalls = gql.calls.length

    // GQL recovers; advance past the 30s cooldown + jitter so the scheduled
    // batch retry fires.
    gql.handler = gqlStatusHandler({ alpha: { live: true }, beta: { live: false } })
    await vi.advanceTimersByTimeAsync(60_000)
    expect(store.getStatus('alpha')!.status.state).toBe('live')
    expect(store.getStatus('beta')!.status.state).toBe('offline')
    expect(store.rateLimited).toBe(false) // successful batch cleared the breaker
    expect(gql.calls.length).toBeGreaterThan(failedCalls) // retry actually ran
  })

  it('sustained failure keeps the breaker tripped (no silent recovery)', async () => {
    seedFavorites(['solo'])
    gql.handler = gqlStatusHandler({}, { fail: 'transport' })
    const store = new F.FavoritesStore()
    store.start()
    await vi.advanceTimersByTimeAsync(2_000)
    expect(store.rateLimited).toBe(true)
    // Advance through several backoff cycles; GQL keeps failing.
    await vi.advanceTimersByTimeAsync(600_000) // 10 min
    expect(store.rateLimited).toBe(true) // still backed off
    expect(store.getStatus('solo')!.status.state).toBe('unknown') // still last-known
  })

  it('does NOT schedule duplicate batch retries while one is pending', async () => {
    seedFavorites(['x'])
    gql.handler = gqlStatusHandler({}, { fail: 'transport' })
    const store = new F.FavoritesStore()
    store.start()
    await vi.advanceTimersByTimeAsync(2_000) // first failure -> one retry scheduled
    const afterFirst = gql.calls.length
    // Hammer retryFetch while a retry is already pending + cooldown active.
    store.retryFetch('x')
    store.retryFetch('x')
    store.retryFetch('x')
    await vi.advanceTimersByTimeAsync(2_000)
    // No additional requests got out during the cooldown (isOnCooldown gate).
    expect(gql.calls.length).toBe(afterFirst)
  })
})

describe('fetchLiveStatus (active channel, via GQL)', () => {
  it('resolves a live channel with full metadata', async () => {
    gql.handler = gqlStatusHandler({ foo: { live: true, viewers: 7, title: 'T', game: 'G' } })
    const s = await F.fetchLiveStatus('foo')
    expect(s.state).toBe('live')
    if (s.state === 'live') {
      expect(s.title).toBe('T')
      expect(s.game).toBe('G')
      expect(s.viewers).toBe(7)
      expect(s.uptime).toBeTruthy()
    }
  })

  it('resolves an offline channel', async () => {
    gql.handler = gqlStatusHandler({ bar: { live: false } })
    const s = await F.fetchLiveStatus('bar')
    expect(s.state).toBe('offline')
  })

  it('returns an error status on a transport failure', async () => {
    gql.handler = gqlStatusHandler({}, { fail: 'transport' })
    const s = await F.fetchLiveStatus('baz')
    expect(s.state).toBe('error')
  })
})

describe('add() immediate resolve', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.spyOn(Math, 'random').mockReturnValue(0)
  })

  it('resolves a freshly-added favorite via a single-channel GQL batch', async () => {
    gql.handler = gqlStatusHandler({ newchan: { live: true, title: 'Fresh' } })
    const store = new F.FavoritesStore()
    store.add('newchan')
    await vi.advanceTimersByTimeAsync(5_000)
    const s = store.getStatus('newchan')!.status
    expect(s.state).toBe('live')
    if (s.state === 'live') expect(s.title).toBe('Fresh')
    // Exactly one single-login gql_fetch (the add() resolveSingle).
    expect(gql.calls).toHaveLength(1)
  })
})

describe('removed channels are skipped', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.spyOn(Math, 'random').mockReturnValue(0)
  })

  it('a channel removed mid-flight is not applied from a late response', async () => {
    // Two channels; the GQL handler defers so we can remove one while the
    // batch is in flight, then let it resolve.
    seedFavorites(['keep', 'gone'])
    let resolveGql!: (v: string) => void
    const pending = new Promise<string>((r) => { resolveGql = r })
    gql.handler = async () => pending
    const store = new F.FavoritesStore()
    store.start()
    await vi.advanceTimersByTimeAsync(2_000) // poll in flight, hanging
    store.remove('gone') // removed while the batch is pending
    // Now let the batch resolve with BOTH channels live.
    resolveGql(
      JSON.stringify({
        data: {
          users: [
            { id: '1', login: 'keep', displayName: 'keep', profileImageURL: '', stream: { id: 's', title: 'K', type: 'live', viewersCount: 1, createdAt: new Date().toISOString(), previewImageURL: '', game: { id: 'g', name: 'gg', displayName: 'gg', boxArtURL: '' } } },
            { id: '2', login: 'gone', displayName: 'gone', profileImageURL: '', stream: { id: 's2', title: 'G', type: 'live', viewersCount: 2, createdAt: new Date().toISOString(), previewImageURL: '', game: { id: 'g', name: 'gg', displayName: 'gg', boxArtURL: '' } } },
          ],
        },
      }),
    )
    await vi.advanceTimersByTimeAsync(2_000)
    expect(store.getStatus('gone')).toBeUndefined() // removed stays removed
    expect(store.getStatus('keep')!.status.state).toBe('live') // kept channel applied
  })
})

describe('dispose', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.spyOn(Math, 'random').mockReturnValue(0)
  })

  it('clears timers and prevents further requests after a failure', async () => {
    seedFavorites(['d1'])
    gql.handler = gqlStatusHandler({}, { fail: 'transport' })
    const store = new F.FavoritesStore()
    store.start()
    await vi.advanceTimersByTimeAsync(2_000) // failure -> retry scheduled
    store.dispose()
    const before = gql.calls.length
    await vi.advanceTimersByTimeAsync(120_000) // well past the cooldown
    expect(gql.calls.length).toBe(before) // the batch retry never fired
  })
})

describe('startup polling cadence', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.spyOn(Math, 'random').mockReturnValue(0)
  })

  it('does not re-poll within one GQL_REFRESH_INTERVAL after a successful resolve', async () => {
    seedFavorites(['live1'])
    gql.handler = gqlStatusHandler({ live1: { live: true } })
    const store = new F.FavoritesStore()
    store.start()
    await vi.advanceTimersByTimeAsync(135_000) // < 150s interval
    expect(gql.calls).toHaveLength(1) // only the initial poll
  })
})

describe('stale-response guard', () => {
  it('a channel removed + re-added resolves with the newer result (version isolation)', async () => {
    // With a single batch transport there is no per-channel version counter,
    // but a removed channel's late response is skipped (has() check) and a
    // re-added channel gets a fresh poll. Verify the re-added channel lands on
    // the live result rather than a stale offline one.
    seedFavorites(['stale'])
    let firstResolve!: (v: string) => void
    const firstPending = new Promise<string>((r) => { firstResolve = r })
    let first = true
    gql.handler = async (body) => {
      if (first) {
        first = false
        return firstPending // old poll hangs...
      }
      // re-added poll resolves LIVE
      return gqlStatusHandler({ stale: { live: true } })(body)
    }
    const store = new F.FavoritesStore()
    store.start()
    await delay(80) // let the old poll fire & hang
    store.remove('stale')
    store.add('stale') // fresh poll resolves to live
    await delay(1200)
    firstResolve(
      // ...now the OLD (pre-remove) response finally lands, reporting offline.
      JSON.stringify({ data: { users: [{ id: '1', login: 'stale', displayName: 'stale', profileImageURL: '', stream: null }] } }),
    )
    await delay(1200)
    const s = store.getStatus('stale')!.status
    expect(s.state).toBe('live') // newer result wins; the stale offline was skipped
  })
})


describe('collabBadge (LiveStatus → badge data)', () => {
  it('returns null unless live and in a session', async () => {
    const { collabBadge } = await import('./favorites.svelte')
    expect(collabBadge({ state: 'unknown' })).toBeNull()
    expect(collabBadge({ state: 'offline', avatarUrl: '' })).toBeNull()
    expect(collabBadge({ state: 'error', message: 'x' })).toBeNull()
    expect(collabBadge({ state: 'live', title: '', viewers: 1, uptime: '', game: '', avatarUrl: '' })).toBeNull()
    expect(
      collabBadge({ state: 'live', title: '', viewers: 1, uptime: '', game: '', avatarUrl: '', collabViewers: null }),
    ).toBeNull()
  })

  it('exposes the roster when present, and the guest-star fallback shape when not', async () => {
    const { collabBadge } = await import('./favorites.svelte')
    expect(
      collabBadge({
        state: 'live', title: '', viewers: 1, uptime: '', game: '', avatarUrl: '',
        collabViewers: 14986, collabOthers: 5, collabAvatar: 'https://img/jaime.png',
      }),
    ).toEqual({ others: 5, avatar: 'https://img/jaime.png' })
    expect(
      collabBadge({ state: 'live', title: '', viewers: 1, uptime: '', game: '', avatarUrl: '', collabViewers: 41103 }),
    ).toEqual({ others: 0, avatar: '' })
  })
})

describe('auto-sort uses the combined session viewership', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.spyOn(Math, 'random').mockReturnValue(0)
  })

  it('a session channel sorts by collabViewers, not its own viewers', async () => {
    const { settings } = await import('./settings.svelte.ts')
    settings.sortMode = 'auto'
    try {
      seedFavorites(['solo', 'costreamer', 'offline1'])
      gql.handler = gqlStatusHandler({
        // costreamer's OWN viewers are the lowest of the live channels, but
        // its session total is the highest number in the list.
        costreamer: { live: true, viewers: 500, collabViewers: 40_000, collabOthers: 3, collabAvatar: 'https://img/other.png' },
        solo: { live: true, viewers: 5_000 },
        offline1: { live: false },
      })
      const store = new F.FavoritesStore()
      store.start()
      await vi.advanceTimersByTimeAsync(5_000)
      const snap = store.snapshot()
      expect(snap.map((s) => s.name)).toEqual(['costreamer', 'solo', 'offline1'])
      const live = snap[0].status
      if (live.state === 'live') {
        expect(live.collabViewers).toBe(40_000)
        expect(live.collabOthers).toBe(3)
        expect(live.collabAvatar).toBe('https://img/other.png')
      }
    } finally {
      settings.sortMode = 'manual'
    }
  })
})

describe('Stream Together batch session grouping (groupCollabSessions)', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.spyOn(Math, 'random').mockReturnValue(0)
  })

  function cs(login: string, over: Partial<ChannelStatus> = {}): ChannelStatus {
    return {
      login,
      userId: 'uid-' + login,
      displayName: login,
      live: true,
      title: 't',
      game: 'GeoGuessr',
      viewersCount: 100,
      startedAt: new Date().toISOString(),
      thumbnailUrl: '',
      avatarUrl: 'https://img/' + login + '.png',
      collabViewers: null,
      collabOthers: 0,
      collabAvatar: '',
      followers: null,
      ...over,
    }
  }

  it('groups live channels with matching combined counts + game; members exclude self', () => {
    const groups = F.groupCollabSessions([
      cs('bastighg', { collabViewers: 5368, viewersCount: 4702 }),
      cs('lennli', { collabViewers: 5368, viewersCount: 600 }),
      cs('solo', { viewersCount: 10 }),
    ])
    expect(groups.get('bastighg')).toEqual([{ login: 'lennli', avatarUrl: 'https://img/lennli.png', viewers: 600 }])
    expect(groups.get('lennli')).toEqual([{ login: 'bastighg', avatarUrl: 'https://img/bastighg.png', viewers: 4702 }])
    expect(groups.has('solo')).toBe(false)
  })

  it('tolerates ~1% drift in the combined count within a session', () => {
    const groups = F.groupCollabSessions([
      cs('trymacs', { game: 'ore factory squad', collabViewers: 37837, viewersCount: 11109 }),
      cs('rumathra', { game: 'Ore Factory Squad', collabViewers: 37696, viewersCount: 1814 }),
    ])
    expect(groups.get('trymacs')?.[0].login).toBe('rumathra')
    expect(groups.get('rumathra')?.[0].login).toBe('trymacs')
  })

  it('never groups across games, without a game, or non-session channels', () => {
    const groups = F.groupCollabSessions([
      cs('a', { game: 'Game One', collabViewers: 5000 }),
      cs('b', { game: 'Game Two', collabViewers: 5000 }),
      cs('c', { game: '', collabViewers: 5000 }),
      cs('d', { game: 'Game One' }), // collabViewers null
      cs('e', { game: 'Game One', collabViewers: 90000 }),
    ])
    expect(groups.size).toBe(0)
  })

  it('composes the badge fields in applyGqlStatuses (roster fallback -> grouping)', async () => {
    seedFavorites(['host', 'mate', 'unrelated'])
    gql.handler = gqlStatusHandler({
      host: { live: true, viewers: 4702, collabViewers: 5368, game: 'GeoGuessr' },
      mate: { live: true, viewers: 600, collabViewers: 5368, game: 'GeoGuessr' },
      unrelated: { live: true, viewers: 99999, game: 'GeoGuessr' },
    })
    const store = new F.FavoritesStore()
    store.start()
    await vi.advanceTimersByTimeAsync(5_000)
    const host = store.getStatus('host')!.status
    if (host.state !== 'live') throw new Error('expected live')
    expect(host.collabMembers?.map((m) => m.login)).toEqual(['mate'])
    expect(host.collabOthers).toBe(1) // grouping fallback (no costreamDetails)
    expect(host.collabAvatar).toBe('https://img/mate.png')
    const mate = store.getStatus('mate')!.status
    if (mate.state !== 'live') throw new Error('expected live')
    expect(mate.collabMembers?.map((m) => m.login)).toEqual(['host'])
    const unrelated = store.getStatus('unrelated')!.status
    if (unrelated.state !== 'live') throw new Error('expected live')
    expect(unrelated.collabMembers).toBeUndefined()
    expect(unrelated.collabOthers).toBe(0)
  })
})

describe('Stream Together collaboration roster fetch (per poll)', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.spyOn(Math, 'random').mockReturnValue(0)
  })

  function roster(...specs: [string, string, string, string][]): unknown {
    // [login, displayName, avatarUrl, role] -> ACTIVE collaborators
    return {
      collaborators: specs.map(([login, displayName, avatarUrl, role]) => ({
        role,
        status: 'ACTIVE',
        user: { login, displayName, profileImageURL: avatarUrl },
      })),
    }
  }

  it('fetches one aliased roster request per poll and patches the real members', async () => {
    seedFavorites(['host', 'solo'])
    gql.handler = gqlStatusHandler(
      {
        host: { live: true, viewers: 674, collabViewers: 1865, id: '531019578', game: 'IRL' },
        solo: { live: true, viewers: 50, id: '111', game: 'Other' },
      },
      {
        roster: (id) =>
          id === '531019578'
            ? roster(
                ['host', 'ronnyberger', 'https://img/r.png', 'LEADER'],
                ['nicistemmler', 'Nicistemmler', 'https://img/n.png', 'MEMBER'],
              )
            : null,
      },
    )
    const store = new F.FavoritesStore()
    store.start()
    await vi.advanceTimersByTimeAsync(5_000)
    // one status batch + one collaboration roster request — nothing else
    expect(gql.calls).toHaveLength(2)
    expect(gql.calls[1].body).toContain('collaboration')
    const host = store.getStatus('host')!.status
    if (host.state !== 'live') throw new Error('expected live')
    expect(host.collabMembers).toEqual([
      { login: 'nicistemmler', avatarUrl: 'https://img/n.png', viewers: 0, role: 'MEMBER' },
    ])
    expect(host.collabOthers).toBe(1)
    expect(host.collabAvatar).toBe('https://img/n.png')
    expect(host.userId).toBe('531019578')
    const solo = store.getStatus('solo')!.status
    if (solo.state !== 'live') throw new Error('expected live')
    expect(solo.collabMembers).toBeUndefined()
    expect(solo.collabOthers).toBe(0)
  })

  it('no session channels -> the batch stays the only GQL call', async () => {
    seedFavorites(['solo1', 'solo2'])
    gql.handler = gqlStatusHandler({ solo1: { live: true, id: '1' }, solo2: { live: true, id: '2' } })
    const store = new F.FavoritesStore()
    store.start()
    await vi.advanceTimersByTimeAsync(5_000)
    expect(gql.calls).toHaveLength(1)
  })

  it('a roster transport failure is silent — grouping values remain, breaker NOT tripped', async () => {
    seedFavorites(['host', 'mate'])
    let rosterFailed = false
    gql.handler = gqlStatusHandler(
      {
        host: { live: true, viewers: 4702, collabViewers: 5368, id: '531019578', game: 'GeoGuessr' },
        mate: { live: true, viewers: 600, collabViewers: 5368, id: '531019579', game: 'GeoGuessr' },
      },
      {
        roster: () => {
          rosterFailed = true
          throw new Error('HTTP 500')
        },
      },
    )
    const store = new F.FavoritesStore()
    store.start()
    await vi.advanceTimersByTimeAsync(5_000)
    expect(rosterFailed).toBe(true)
    expect(store.rateLimited).toBe(false)
    const host = store.getStatus('host')!.status
    if (host.state !== 'live') throw new Error('expected live')
    // the batch grouping fallback survives the failed roster fetch
    expect(host.collabMembers?.map((m) => m.login)).toEqual(['mate'])
  })
})
