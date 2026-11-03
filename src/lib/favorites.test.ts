import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { GQL_REFRESH_INTERVAL_MS } from './gql'

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
 *    last-known status, a quiet backoff retry of the SAME batch is scheduled,
 *    and the circuit breaker (rateLimited banner) trips only on the SECOND
 *    consecutive failure;
 *  - a successful retry clears the breaker and refreshes statuses;
 *  - fetchLiveStatus resolves a single channel via the same transport.
 */

const gql = vi.hoisted(() => ({
  handler: async (_body: string): Promise<string> => {
    throw new Error('gql handler not configured for this test')
  },
  calls: [] as { body: string; ts: number }[],
}))

// Every in-app toast the store fires is recorded here (the OS-notification
// half of fireLiveNotification never runs under isTauri() = false).
const notifLog = vi.hoisted(() => [] as { kind: string; title: string; body: string; channel: string }[])

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
vi.mock('./notifications.svelte.ts', () => ({
  notifications: {
    record: (kind: string, title: string, body: string, channel: string) => {
      notifLog.push({ kind, title, body, channel })
    },
  },
}))
vi.mock('./settings.svelte.ts', () => ({ settings: { sortMode: 'manual' } }))

type FavMod = typeof import('./favorites.svelte')
let F: FavMod

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
          game: {
            id: 'g',
            name: c.game ?? 'game-' + login,
            displayName: c.game ?? 'game-' + login,
            boxArtURL: 'https://box/' + login + '.jpg',
          },
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
  notifLog.length = 0
  gql.handler = async () => {
    throw new Error('gql handler not configured')
  }
  F = await import('./favorites.svelte')
})

afterEach(() => {
  vi.useRealTimers()
})

describe('store membership is reactive', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  // $state.raw entries + SvelteSet: $deriveds/$effects reading has() /
  // hasNotifEnabled() re-run on ANY membership change — the old plain fields
  // left them stale unless the mutating surface bumped a version counter.
  // The runes helper is imported DYNAMICALLY after F: vi.resetModules gives
  // the re-imported store a fresh Svelte runtime, and a statically imported
  // helper would hold the pre-reset one (two signal systems never
  // interoperating).
  it('an effect reading has() re-runs on add() and remove()', async () => {
    const R = await import('./favorites-reactivity.svelte')
    seedFavorites(['alpha'])
    gql.handler = gqlStatusHandler({ alpha: { live: false }, beta: { live: false } })
    const store = new F.FavoritesStore()
    expect(
      R.runsAroundMutation(
        () => store.has('beta'),
        () => void store.add('beta'),
      ),
    ).toBeGreaterThan(1)
    await vi.advanceTimersByTimeAsync(5_000)
    expect(
      R.runsAroundMutation(
        () => store.has('beta'),
        () => store.remove('beta'),
      ),
    ).toBeGreaterThan(1)
  })

  it('an effect reading hasNotifEnabled() re-runs on toggle', async () => {
    const R = await import('./favorites-reactivity.svelte')
    seedFavorites(['alpha'])
    gql.handler = gqlStatusHandler({ alpha: { live: false } })
    const store = new F.FavoritesStore()
    expect(
      R.runsAroundMutation(
        () => store.hasNotifEnabled('alpha'),
        () => store.setNotifEnabled('alpha', true),
      ),
    ).toBeGreaterThan(1)
    expect(
      R.runsAroundMutation(
        () => store.hasNotifEnabled('alpha'),
        () => store.setNotifEnabled('alpha', false),
      ),
    ).toBeGreaterThan(1)
  })

  it('notification opt-ins for non-favorites are dropped on load', () => {
    // Go-live notifications fire only from the favorites batch; an opt-in
    // for a non-favorite can never fire, and the bell UI only renders for
    // favorites — so the persisted entry is dead weight.
    seedFavorites(['alpha'])
    localStorage.setItem('fav-notif-channels-v1', JSON.stringify(['alpha', 'ghostchan']))
    const store = new F.FavoritesStore()
    expect(store.hasNotifEnabled('alpha')).toBe(true)
    expect(store.hasNotifEnabled('ghostchan')).toBe(false)
    // Pruned from storage too, not just memory.
    expect(JSON.parse(localStorage.getItem('fav-notif-channels-v1')!)).toEqual(['alpha'])
  })
})

describe('GQL batch resolves the whole list', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.spyOn(Math, 'random').mockReturnValue(0)
  })

  it('start() is idempotent — a second call never re-polls', async () => {
    // start() is owned by App's onMount; component remounts (the Sidebar
    // cycling through its modes, theater toggles) used to re-fire an
    // immediate full-list poll each time.
    seedFavorites(['alpha'])
    gql.handler = gqlStatusHandler({ alpha: { live: false } })
    const store = new F.FavoritesStore()
    store.start()
    await vi.advanceTimersByTimeAsync(5_000)
    expect(gql.calls).toHaveLength(1)
    store.start()
    store.start()
    await vi.advanceTimersByTimeAsync(5_000)
    expect(gql.calls).toHaveLength(1)
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

  it('a single transient failure stays quiet, keeps last-known status, and retries', async () => {
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

    // GQL fails once (retryFetch forces a poll — no per-channel fetch exists
    // anymore). ONE consecutive failure must NOT trip the banner; a quiet
    // 30s backoff retry is scheduled instead.
    gql.handler = gqlStatusHandler({}, { fail: 'transport' })
    store.retryFetch('alpha')
    await vi.advanceTimersByTimeAsync(2_000)
    expect(store.rateLimited).toBe(false) // first failure stays quiet
    // Last-known statuses are RETAINED — never reset to error/unknown.
    expect(store.getStatus('alpha')!.status.state).toBe('live')
    expect(store.getStatus('beta')!.status.state).toBe('offline')
    expect(gql.calls.length).toBeGreaterThan(callsAfterSuccess) // GQL was attempted

    // GQL recovers; the scheduled quiet retry lands after the 30s backoff.
    gql.handler = gqlStatusHandler({ alpha: { live: true }, beta: { live: false } })
    await vi.advanceTimersByTimeAsync(60_000)
    expect(store.rateLimited).toBe(false)
    expect(gql.calls.length).toBeGreaterThan(callsAfterSuccess + 1) // retry actually ran
  })

  it('the SECOND consecutive failure trips the breaker and shows rateLimited', async () => {
    seedFavorites(['alpha', 'beta'])
    gql.handler = gqlStatusHandler({ alpha: { live: true }, beta: { live: false } })
    const store = new F.FavoritesStore()
    store.start()
    await vi.advanceTimersByTimeAsync(5_000)

    // Two failures in a row with no successful batch between them.
    gql.handler = gqlStatusHandler({}, { fail: 'transport' })
    store.retryFetch('alpha')
    await vi.advanceTimersByTimeAsync(2_000)
    expect(store.rateLimited).toBe(false) // first failure: quiet
    store.retryFetch('alpha')
    await vi.advanceTimersByTimeAsync(2_000)
    expect(store.rateLimited).toBe(true) // breaker tripped on the second
    // Last-known statuses are RETAINED — never reset to error/unknown.
    expect(store.getStatus('alpha')!.status.state).toBe('live')
    expect(store.getStatus('beta')!.status.state).toBe('offline')
  })

  it('a successful poll between failures resets the consecutive count', async () => {
    seedFavorites(['solo'])
    const store = new F.FavoritesStore()
    gql.handler = gqlStatusHandler({}, { fail: 'transport' })
    store.start()
    await vi.advanceTimersByTimeAsync(2_000) // failure #1 (quiet)
    expect(store.rateLimited).toBe(false)

    // Recovery before another failure: the quiet retry succeeds.
    gql.handler = gqlStatusHandler({ solo: { live: true } })
    await vi.advanceTimersByTimeAsync(60_000)
    expect(store.getStatus('solo')!.status.state).toBe('live')
    expect(store.rateLimited).toBe(false)

    // The NEXT failure is "first consecutive" again — still no banner.
    gql.handler = gqlStatusHandler({}, { fail: 'transport' })
    store.retryFetch('solo')
    await vi.advanceTimersByTimeAsync(2_000)
    expect(store.rateLimited).toBe(false)
    // ...and the failure after that trips.
    store.retryFetch('solo')
    await vi.advanceTimersByTimeAsync(2_000)
    expect(store.rateLimited).toBe(true)
  })

  it('a backoff retry of the SAME batch recovers and clears the breaker', async () => {
    seedFavorites(['alpha', 'beta'])
    gql.handler = gqlStatusHandler({}, { fail: 'transport' })
    const store = new F.FavoritesStore()
    store.start()
    await vi.advanceTimersByTimeAsync(2_000) // failure #1: quiet, retry at 30s
    expect(store.rateLimited).toBe(false)
    expect(store.getStatus('alpha')!.status.state).toBe('unknown') // never resolved yet

    // The 30s quiet retry also fails -> second consecutive failure trips.
    await vi.advanceTimersByTimeAsync(35_000)
    expect(store.rateLimited).toBe(true)
    const failedCalls = gql.calls.length

    // GQL recovers; advance past the tripped cooldown + jitter so the next
    // scheduled batch retry fires.
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
    await vi.advanceTimersByTimeAsync(2_000) // failure #1: quiet
    expect(store.rateLimited).toBe(false)
    await vi.advanceTimersByTimeAsync(35_000) // quiet retry fails -> trips
    expect(store.rateLimited).toBe(true)
    // Advance through several backoff cycles; GQL keeps failing.
    await vi.advanceTimersByTimeAsync(600_000) // 10 min
    expect(store.rateLimited).toBe(true) // still backed off
    expect(store.getStatus('solo')!.status.state).toBe('unknown') // still last-known
  })

  it('a persistently failing chunk of a multi-chunk poll eventually trips the breaker', async () => {
    // >100 favorites = 2 chunks. Chunk 2 keeps failing while chunk 1
    // resolves: every poll applies chunk 1's statuses AND counts as a
    // partial failure, so the banner trips on the second consecutive cycle
    // instead of the stale half going unnoticed forever.
    const many = Array.from({ length: 150 }, (_, i) => 'chan' + i)
    seedFavorites(many)
    gql.handler = async (body) => {
      const logins = (JSON.parse(body) as { variables: { logins: string[] } }).variables.logins
      // The second chunk (logins 100..149) fails on the transport level.
      if (logins.includes('chan100')) throw new Error('HTTP 500')
      return JSON.stringify({
        data: { users: logins.map((l) => ({ id: '1', login: l, displayName: l, stream: null })) },
      })
    }
    const store = new F.FavoritesStore()
    store.start()
    await vi.advanceTimersByTimeAsync(5_000)
    expect(store.getStatus('chan0')!.status.state).toBe('offline') // partial data applied
    expect(store.getStatus('chan149')!.status.state).toBe('unknown') // failed chunk keeps last-known
    expect(store.rateLimited).toBe(false) // first partial: quiet
    // The quiet retry at ~30s comes back partial again -> second consecutive.
    await vi.advanceTimersByTimeAsync(35_000)
    expect(store.rateLimited).toBe(true)
  })

  it('a pending quiet retry consumed inside a tripped cooldown is re-armed', async () => {
    seedFavorites(['x'])
    gql.handler = gqlStatusHandler({}, { fail: 'transport' })
    const store = new F.FavoritesStore()
    store.start()
    await vi.advanceTimersByTimeAsync(2_000) // failure #1: quiet retry scheduled for t≈30.25s
    // A second failure a few seconds in trips the breaker with a cooldown
    // (until t≈35s) that OUTLASTS the pending quiet-retry deadline — without
    // the re-arm, that timer is consumed without polling and the retry
    // window goes dead until the 150s floor poll.
    store.retryFetch('x')
    await vi.advanceTimersByTimeAsync(3_000)
    expect(store.rateLimited).toBe(true)
    const failedCalls = gql.calls.length

    // GQL recovers; the re-armed retry must fire just past the cooldown end
    // (t≈35.25s), well before the 150s floor poll.
    gql.handler = gqlStatusHandler({ x: { live: true } })
    await vi.advanceTimersByTimeAsync(33_000)
    expect(store.getStatus('x')!.status.state).toBe('live')
    expect(store.rateLimited).toBe(false)
    expect(gql.calls.length).toBeGreaterThan(failedCalls)
  })

  it('does NOT schedule duplicate batch retries while one is pending', async () => {
    seedFavorites(['x'])
    gql.handler = gqlStatusHandler({}, { fail: 'transport' })
    const store = new F.FavoritesStore()
    store.start()
    await vi.advanceTimersByTimeAsync(2_000) // failure #1 -> one retry scheduled
    // A second failure trips the breaker (cooldown active).
    store.retryFetch('x')
    await vi.advanceTimersByTimeAsync(2_000)
    expect(store.rateLimited).toBe(true)
    const afterTrip = gql.calls.length
    // Hammer retryFetch while a retry is already pending + cooldown active.
    store.retryFetch('x')
    store.retryFetch('x')
    await vi.advanceTimersByTimeAsync(2_000)
    // No additional requests got out during the cooldown (isOnCooldown gate).
    expect(gql.calls.length).toBe(afterTrip)
  })

  it('a field-scoped errors batch is a SUCCESS — statuses apply, breaker never involved', async () => {
    // The endpoint intermittently answers users(logins:) with "server error"
    // on followers.totalCount while the users array stays complete. Such a
    // poll must resolve statuses normally (followers unknown) and never count
    // as a transport failure — repeated across polls, no banner ever.
    seedFavorites(['alpha'])
    const fieldErr = async (): Promise<string> =>
      JSON.stringify({
        data: {
          users: [
            {
              id: '1',
              login: 'alpha',
              displayName: 'alpha',
              followers: { totalCount: null },
              stream: {
                id: 's',
                title: 'T',
                type: 'live',
                viewersCount: 5,
                createdAt: new Date().toISOString(),
                game: { name: 'g', displayName: 'G' },
              },
            },
          ],
        },
        errors: [{ message: 'server error', path: ['users', 'followers', 'totalCount'] }],
      })
    gql.handler = fieldErr
    const store = new F.FavoritesStore()
    store.start()
    await vi.advanceTimersByTimeAsync(5_000)
    const s = store.getStatus('alpha')!.status
    expect(s.state).toBe('live')
    if (s.state === 'live') expect(s.followers).toBeNull()
    expect(store.rateLimited).toBe(false)
    // Second poll, same flaky-but-complete response: still no failure.
    await vi.advanceTimersByTimeAsync(GQL_REFRESH_INTERVAL_MS + 5_000)
    expect(store.getStatus('alpha')!.status.state).toBe('live')
    expect(store.rateLimited).toBe(false)
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
    const pending = new Promise<string>((r) => {
      resolveGql = r
    })
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
            {
              id: '1',
              login: 'keep',
              displayName: 'keep',
              profileImageURL: '',
              stream: {
                id: 's',
                title: 'K',
                type: 'live',
                viewersCount: 1,
                createdAt: new Date().toISOString(),
                previewImageURL: '',
                game: { id: 'g', name: 'gg', displayName: 'gg', boxArtURL: '' },
              },
            },
            {
              id: '2',
              login: 'gone',
              displayName: 'gone',
              profileImageURL: '',
              stream: {
                id: 's2',
                title: 'G',
                type: 'live',
                viewersCount: 2,
                createdAt: new Date().toISOString(),
                previewImageURL: '',
                game: { id: 'g', name: 'gg', displayName: 'gg', boxArtURL: '' },
              },
            },
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

  it('add() does not defer the scheduled batch poll', async () => {
    seedFavorites(['alpha'])
    gql.handler = gqlStatusHandler({ alpha: { live: false }, newchan: { live: false } })
    const store = new F.FavoritesStore()
    store.start()
    await vi.advanceTimersByTimeAsync(5_000)
    expect(gql.calls).toHaveLength(1) // the startup batch
    // Add well inside the interval: the new channel resolves on its own, and
    // the already-scheduled batch must still fire at its original deadline
    // (a reschedule per add stalled every other favorite for a full
    // interval each time).
    store.add('newchan')
    await vi.advanceTimersByTimeAsync(5_000)
    expect(gql.calls).toHaveLength(2) // + resolveSingle
    await vi.advanceTimersByTimeAsync(142_000) // t = 152s since start()
    expect(gql.calls).toHaveLength(3) // the batch fired ON TIME (150s, not deferred)
  })
})

describe('live notifications — known offline→live only, no startup grace', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.spyOn(Math, 'random').mockReturnValue(0)
  })

  it('channels already live on the first poll never notify (unknown → live is silent)', async () => {
    seedFavorites(['alpha', 'beta'])
    gql.handler = gqlStatusHandler({ alpha: { live: true }, beta: { live: false } })
    const store = new F.FavoritesStore()
    store.setNotifEnabled('alpha', true)
    store.setNotifEnabled('beta', true)
    store.start()
    await vi.advanceTimersByTimeAsync(5_000)
    expect(store.getStatus('alpha')!.status.state).toBe('live')
    expect(store.getStatus('beta')!.status.state).toBe('offline')
    expect(notifLog).toEqual([])
  })

  it('offline → live fires immediately — a store seconds old still notifies', async () => {
    seedFavorites(['alpha'])
    gql.handler = gqlStatusHandler({ alpha: { live: false } })
    const store = new F.FavoritesStore()
    store.setNotifEnabled('alpha', true)
    store.start()
    await vi.advanceTimersByTimeAsync(5_000) // first poll: KNOWN offline
    gql.handler = gqlStatusHandler({ alpha: { live: true, title: 'She lives' } })
    store.retryFetch('alpha') // immediate re-poll, well inside the old 10-min grace
    await vi.advanceTimersByTimeAsync(2_000)
    expect(notifLog).toHaveLength(1)
    expect(notifLog[0]).toMatchObject({ kind: 'live', channel: 'alpha' })
    expect(notifLog[0].body).toBe('She lives')
  })

  it('live → live on a later poll does not re-notify', async () => {
    seedFavorites(['alpha'])
    gql.handler = gqlStatusHandler({ alpha: { live: true } })
    const store = new F.FavoritesStore()
    store.setNotifEnabled('alpha', true)
    store.start()
    await vi.advanceTimersByTimeAsync(5_000) // first poll: live (silent — unknown → live)
    store.retryFetch('alpha')
    await vi.advanceTimersByTimeAsync(2_000)
    expect(notifLog).toEqual([])
  })

  it('respects the per-channel notification opt-in', async () => {
    seedFavorites(['alpha', 'beta'])
    gql.handler = gqlStatusHandler({ alpha: { live: false }, beta: { live: false } })
    const store = new F.FavoritesStore()
    store.setNotifEnabled('alpha', true) // beta stays opted out
    store.start()
    await vi.advanceTimersByTimeAsync(5_000)
    gql.handler = gqlStatusHandler({ alpha: { live: true }, beta: { live: true } })
    store.retryFetch('alpha')
    await vi.advanceTimersByTimeAsync(2_000)
    expect(notifLog).toHaveLength(1)
    expect(notifLog[0]).toMatchObject({ channel: 'alpha' })
  })

  it('a channel added mid-session that is already live also resolves silently', async () => {
    seedFavorites([])
    const store = new F.FavoritesStore()
    store.setNotifEnabled('late', true)
    gql.handler = gqlStatusHandler({ late: { live: true } })
    store.add('late') // resolveSingle → the channel's FIRST known status is live
    await vi.advanceTimersByTimeAsync(5_000)
    expect(store.getStatus('late')!.status.state).toBe('live')
    expect(notifLog).toEqual([])
  })
})

describe('stale-response guard', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  it('a channel removed + re-added resolves with the newer result (version isolation)', async () => {
    // The remove+re-add bumps the channel's entryVersions counter, so the
    // batch the OLD poll snapshotted is discarded when it finally lands:
    // has() alone could not skip it (the channel is present again by then),
    // and the version mismatch is what keeps the stale offline result out.
    // The re-added channel's fresh poll wins.
    seedFavorites(['stale'])
    let firstResolve!: (v: string) => void
    const firstPending = new Promise<string>((r) => {
      firstResolve = r
    })
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
    await vi.advanceTimersByTimeAsync(100) // the old poll fires & hangs
    store.remove('stale')
    store.add('stale') // fresh poll resolves to live
    await vi.advanceTimersByTimeAsync(1_200)
    firstResolve(
      // ...now the OLD (pre-remove) response finally lands, reporting offline.
      JSON.stringify({
        data: { users: [{ id: '1', login: 'stale', displayName: 'stale', profileImageURL: '', stream: null }] },
      }),
    )
    await vi.advanceTimersByTimeAsync(1_200)
    const s = store.getStatus('stale')!.status
    expect(s.state).toBe('live') // newer result wins; the stale offline was skipped
    store.dispose()
  })
})

describe('reorder splices in the order manual sort shows', () => {
  it('a drag after importing into a never-hand-sorted list moves what the drop line pointed at', () => {
    // Existing entries were never hand-sorted: their order values are
    // add-time epochs.
    localStorage.setItem(
      'twitch-favorites-v1',
      JSON.stringify([
        { name: 'old1', addedAt: 1000, order: 1000 },
        { name: 'old2', addedAt: 1001, order: 1001 },
      ]),
    )
    const store = new F.FavoritesStore()
    // A hand-sorted export carries small sequential orders; merging them
    // leaves the stored array order and the (order, name) display order
    // disagreeing — manual sort shows [imp1, imp2, old1, old2].
    store.importJson(
      JSON.stringify({
        version: 1,
        favorites: [
          { name: 'imp1', addedAt: 2000, order: 1 },
          { name: 'imp2', addedAt: 2001, order: 2 },
        ],
      }),
    )
    // Drag imp1 below imp2 (the drop the sidebar's row geometry reports).
    // Splicing by raw array positions would have reordered the array as
    // [old1, old2, imp2, imp1] instead.
    store.reorder('imp1', 'imp2', true)
    expect(store.snapshot().map((s) => s.name)).toEqual(['imp2', 'imp1', 'old1', 'old2'])
    // The renumber persists the shown order, so the next drag starts from it.
    const stored = JSON.parse(localStorage.getItem('twitch-favorites-v1') ?? '[]') as {
      name: string
      order: number
    }[]
    expect(stored.map((e) => e.name)).toEqual(['imp2', 'imp1', 'old1', 'old2'])
    expect(stored.map((e) => e.order)).toEqual([1, 2, 3, 4])
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
        state: 'live',
        title: '',
        viewers: 1,
        uptime: '',
        game: '',
        avatarUrl: '',
        collabViewers: 14986,
        collabOthers: 5,
        collabAvatar: 'https://img/c1.png',
      }),
    ).toEqual({ others: 5, avatar: 'https://img/c1.png' })
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
        costreamer: {
          live: true,
          viewers: 500,
          collabViewers: 40_000,
          collabOthers: 3,
          collabAvatar: 'https://img/other.png',
        },
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

describe('Stream Together badge fields (no heuristic grouping)', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.spyOn(Math, 'random').mockReturnValue(0)
  })

  it('same game + matching combined counts alone invent NO members', async () => {
    seedFavorites(['host', 'mate'])
    gql.handler = gqlStatusHandler({
      host: { live: true, viewers: 4702, collabViewers: 5368, game: 'GeoGuessr', id: '300000001' },
      mate: { live: true, viewers: 600, collabViewers: 5368, game: 'GeoGuessr', id: '300000002' },
    })
    const store = new F.FavoritesStore()
    store.start()
    await vi.advanceTimersByTimeAsync(5_000)
    // The roster served no session for either channel, so nothing may be
    // inferred from the batch's coincidental same-game / same-combined-count
    // pair: members exist ONLY once a real collaboration roster reported
    // them, and the batch-only session claim itself resets once the roster
    // (asked precisely because the batch claimed a session) answers "none".
    for (const name of ['host', 'mate']) {
      const st = store.getStatus(name)!.status
      if (st.state !== 'live') throw new Error('expected live')
      expect(st.collabMembers).toBeUndefined()
      expect(st.collabOthers).toBe(0)
      expect(st.collabAvatar).toBe('')
      expect(st.collabViewers).toBeNull()
    }
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
        host: { live: true, viewers: 674, collabViewers: 1865, id: '200000001', game: 'IRL' },
        solo: { live: true, viewers: 50, id: '111', game: 'Other' },
      },
      {
        roster: (id) =>
          id === '200000001'
            ? roster(
                ['host', 'cohost1', 'https://img/r.png', 'LEADER'],
                ['cohost2', 'Cohost2', 'https://img/n.png', 'MEMBER'],
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
    expect(host.collabMembers).toEqual([{ login: 'cohost2', avatarUrl: 'https://img/n.png', role: 'MEMBER' }])
    expect(host.collabOthers).toBe(1)
    expect(host.collabAvatar).toBe('https://img/n.png')
    expect(host.userId).toBe('200000001')
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

  it('a roster transport failure is silent — last-known roster values remain, breaker NOT tripped', async () => {
    seedFavorites(['host'])
    let failRoster = false
    gql.handler = gqlStatusHandler(
      { host: { live: true, viewers: 674, collabViewers: 1865, id: '200000001', game: 'IRL' } },
      {
        roster: (id) => {
          if (failRoster) throw new Error('HTTP 500')
          return id === '200000001'
            ? roster(['host', 'Host', 'https://img/h.png', 'LEADER'], ['guest', 'Guest', 'https://img/g.png', 'MEMBER'])
            : null
        },
      },
    )
    const store = new F.FavoritesStore()
    store.start()
    await vi.advanceTimersByTimeAsync(5_000)
    let host = store.getStatus('host')!.status
    if (host.state !== 'live') throw new Error('expected live')
    expect(host.collabMembers?.map((m) => m.login)).toEqual(['guest'])
    // Next poll: the roster request fails. No breaker (the status batch
    // succeeded) and no blanking — the store carries the last-known roster
    // through until a roster fetch succeeds again.
    failRoster = true
    await vi.advanceTimersByTimeAsync(GQL_REFRESH_INTERVAL_MS)
    expect(store.rateLimited).toBe(false)
    host = store.getStatus('host')!.status
    if (host.state !== 'live') throw new Error('expected live')
    expect(host.collabMembers?.map((m) => m.login)).toEqual(['guest'])
    expect(host.collabOthers).toBe(1)
  })

  it('a roster that reports no session resets the whole collab state while the batch keeps claiming one', async () => {
    seedFavorites(['host', 'solo'])
    let serveRoster = true
    gql.handler = gqlStatusHandler(
      {
        host: { live: true, viewers: 674, collabViewers: 1865, id: '200000001', game: 'IRL' },
        solo: { live: true, viewers: 50, id: '111', game: 'Other' },
      },
      {
        roster: (id) =>
          serveRoster && id === '200000001'
            ? roster(['host', 'Host', 'https://img/h.png', 'LEADER'], ['guest', 'Guest', 'https://img/g.png', 'MEMBER'])
            : null,
      },
    )
    const store = new F.FavoritesStore()
    store.start()
    await vi.advanceTimersByTimeAsync(5_000)
    let host = store.getStatus('host')!.status
    if (host.state !== 'live') throw new Error('expected live')
    expect(host.collabMembers?.map((m) => m.login)).toEqual(['guest'])
    expect(host.collabViewers).toBe(1865)
    // The streamer ends the Stream Together session but stays live: Twitch
    // keeps serving the stale combined count while the roster now reports no
    // session (the channel is absent from the response). The whole collab
    // state resets — the badge (which renders the empty shell for a
    // non-null count with no roster) and the combined count must go.
    serveRoster = false
    await vi.advanceTimersByTimeAsync(GQL_REFRESH_INTERVAL_MS)
    host = store.getStatus('host')!.status
    if (host.state !== 'live') throw new Error('expected live')
    expect(host.collabViewers).toBeNull()
    expect(host.collabOthers).toBe(0)
    expect(host.collabAvatar).toBe('')
    expect(host.collabMembers).toBeUndefined()
    expect(host.viewers).toBe(674)
    expect(F.collabBadge(host)).toBeNull()
    expect(store.rateLimited).toBe(false)
    // 2 status batches + 2 roster requests: the roster request still goes
    // out for the dissolved-only poll — its empty answer IS the reset
    // signal, so an empty result map must not skip the merge pass.
    expect(gql.calls).toHaveLength(4)
  })

  it('once dissolved, the stale batch cannot re-materialize the badge — even when the next roster fetch fails', async () => {
    seedFavorites(['host'])
    const serveRoster = false // never served — poll 1 dissolves
    let failRoster = false
    gql.handler = gqlStatusHandler(
      { host: { live: true, viewers: 674, collabViewers: 1865, id: '200000001', game: 'IRL' } },
      {
        roster: (id) => {
          if (failRoster) throw new Error('HTTP 500')
          return serveRoster && id === '200000001'
            ? roster(['host', 'Host', 'https://img/h.png', 'LEADER'], ['guest', 'Guest', 'https://img/g.png', 'MEMBER'])
            : null
        },
      },
    )
    const store = new F.FavoritesStore()
    store.start()
    await vi.advanceTimersByTimeAsync(5_000)
    let host = store.getStatus('host')!.status
    if (host.state !== 'live') throw new Error('expected live')
    expect(host.collabViewers).toBeNull()
    // Next poll: the batch STILL claims a session but the roster request
    // fails (transport). The dissolved latch must keep the batch's stale
    // count suppressed — without it, the batch would re-materialize the
    // badge until a successful roster fetch resets again. No breaker: the
    // status batch itself succeeded.
    failRoster = true
    await vi.advanceTimersByTimeAsync(GQL_REFRESH_INTERVAL_MS)
    host = store.getStatus('host')!.status
    if (host.state !== 'live') throw new Error('expected live')
    expect(host.collabViewers).toBeNull()
    expect(host.collabOthers).toBe(0)
    expect(host.collabAvatar).toBe('')
    expect(host.collabMembers).toBeUndefined()
    expect(store.rateLimited).toBe(false)
  })

  it('a re-established session is detected again after a dissolved one', async () => {
    seedFavorites(['host'])
    let serveRoster = false
    gql.handler = gqlStatusHandler(
      { host: { live: true, viewers: 674, collabViewers: 1865, id: '200000001', game: 'IRL' } },
      {
        roster: (id) =>
          serveRoster && id === '200000001'
            ? roster(['host', 'Host', 'https://img/h.png', 'LEADER'], ['guest', 'Guest', 'https://img/g.png', 'MEMBER'])
            : null,
      },
    )
    const store = new F.FavoritesStore()
    store.start()
    await vi.advanceTimersByTimeAsync(5_000)
    let host = store.getStatus('host')!.status
    if (host.state !== 'live') throw new Error('expected live')
    expect(host.collabViewers).toBeNull()
    // The session comes back: the poll's roster fetch lists the channel
    // again, clearing the dissolved latch and restoring the full collab
    // state.
    serveRoster = true
    await vi.advanceTimersByTimeAsync(GQL_REFRESH_INTERVAL_MS)
    host = store.getStatus('host')!.status
    if (host.state !== 'live') throw new Error('expected live')
    expect(host.collabViewers).toBe(1865)
    expect(host.collabMembers?.map((m) => m.login)).toEqual(['guest'])
    expect(host.collabOthers).toBe(1)
    expect(host.collabAvatar).toBe('https://img/g.png')
    expect(F.collabBadge(host)).toEqual({ others: 1, avatar: 'https://img/g.png' })
  })

  it('a channel whose id never reaches the roster query keeps its batch collab state', async () => {
    seedFavorites(['host'])
    // Default id 'id-host' is not numerically shaped, so the roster query
    // never fires and no roster answer exists to be authoritative over —
    // the batch's in-session state stands.
    gql.handler = gqlStatusHandler({
      host: { live: true, viewers: 674, collabViewers: 1865, game: 'IRL' },
    })
    const store = new F.FavoritesStore()
    store.start()
    await vi.advanceTimersByTimeAsync(5_000)
    expect(gql.calls).toHaveLength(1)
    const host = store.getStatus('host')!.status
    if (host.state !== 'live') throw new Error('expected live')
    expect(host.collabViewers).toBe(1865)
  })
})
