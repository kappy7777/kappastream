import { describe, it, expect, beforeEach, vi } from 'vitest'

/*
 * Unit tests for src/lib/gql — both the favorites status layer
 * (fetchChannelStatuses / resolveUserIds) and the discovery layer
 * (searchChannels / fetchTopStreams / fetchTopCategories / fetchGameStreams).
 *
 * The Tauri `gql_fetch` transport is fully mocked: each invoke('gql_fetch')
 * routes through `gql.handler`, which a test sets to return a canned JSON
 * response (or throw, to simulate a transport failure). This exercises the
 * parsing + error-discipline logic in gql.ts without touching the network.
 *
 * Discovery is GQL-only with NO DecAPI fallback, so the central rule under
 * test is: an empty result set is a SUCCESS (returns []), while a transport
 * failure (HTTP error, malformed body, top-level GQL `errors`) THROWS so the
 * caller can surface a visible error instead of silently showing "no results".
 */

const gql = vi.hoisted(() => ({
  handler: async (_body: string): Promise<string> => {
    throw new Error('gql handler not configured for this test')
  },
  calls: [] as string[],
}))

vi.mock('@tauri-apps/api/core', () => ({
  invoke: (cmd: string, args: Record<string, unknown>): Promise<unknown> => {
    if (cmd === 'gql_fetch') {
      const body = String(args.body ?? '')
      gql.calls.push(body)
      return Promise.resolve(gql.handler(body))
    }
    return Promise.reject(new Error('unexpected invoke: ' + cmd))
  },
  isTauri: () => false,
}))

type GqlMod = typeof import('./gql')
let G: GqlMod

beforeEach(async () => {
  vi.resetModules()
  gql.calls.length = 0
  gql.handler = async () => {
    throw new Error('gql handler not configured for this test')
  }
  G = await import('./gql')
})

/** Build a GQL 200 envelope string around a `data` object. */
function ok(data: unknown): string {
  return JSON.stringify({ data })
}

/** Build a GQL 200 envelope with a top-level `errors` array. */
function gqlErrors(): string {
  return JSON.stringify({ errors: [{ message: 'schema error' }] })
}

/** Helper to read the variables object out of the last gql_fetch body. */
function lastVars(): Record<string, unknown> {
  const body = gql.calls.at(-1) ?? '{}'
  return (JSON.parse(body) as { variables?: Record<string, unknown> }).variables ?? {}
}

describe('gql favorites layer (refactor smoke)', () => {
  it('fetchChannelStatuses parses users(logins:) into ChannelStatus', async () => {
    gql.handler = async () =>
      ok({
        users: [
          {
            id: '1',
            login: 'livechan',
            displayName: 'LiveChan',
            profileImageURL: 'https://img/live.png',
            stream: {
              id: 's1',
              title: 'Title',
              type: 'live',
              viewersCount: 42,
              createdAt: '2024-01-01T00:00:00Z',
              previewImageURL: 'https://img/thumb.png',
              game: { id: 'g1', name: 'just-chatting', displayName: 'Just Chatting' },
            },
          },
          { id: '2', login: 'offlinechan', displayName: 'OfflineChan', profileImageURL: 'https://img/o.png', stream: null },
          null,
        ],
      })

    const statuses = await G.fetchChannelStatuses(['livechan', 'offlinechan', 'ghost'])
    expect(statuses).toHaveLength(3)
    expect(statuses[0]).toMatchObject({
      login: 'livechan',
      live: true,
      title: 'Title',
      viewersCount: 42,
      game: 'Just Chatting',
      avatarUrl: 'https://img/live.png',
    })
    expect(statuses[1].live).toBe(false)
    // A null (nonexistent) entry keeps its input login + empty fields.
    expect(statuses[2]).toMatchObject({ login: 'ghost', live: false })
  })
})

describe('gql search (searchChannels)', () => {
  it('parses searchFor.channels.items into SearchChannelResult', async () => {
    gql.handler = async () =>
      ok({
        searchFor: {
          channels: {
            items: [
              {
                id: '11',
                login: 'shroud',
                displayName: 'shroud',
                profileImageURL: 'https://img/shroud.png',
                stream: {
                  id: 'st',
                  title: 'Aimlabs',
                  viewersCount: 9001,
                  game: { id: 'g', name: 'valorant', displayName: 'VALORANT' },
                },
              },
              {
                id: '22',
                login: 'pokimane',
                displayName: 'pokimane',
                profileImageURL: 'https://img/poki.png',
                stream: null,
              },
            ],
          },
        },
      })

    const results = await G.searchChannels('shro')
    expect(results).toHaveLength(2)
    expect(results[0]).toMatchObject({
      login: 'shroud',
      displayName: 'shroud',
      avatarUrl: 'https://img/shroud.png',
      live: true,
      title: 'Aimlabs',
      game: 'VALORANT',
      viewersCount: 9001,
    })
    // An offline match still appears, just with live:false and empty stream fields.
    expect(results[1]).toMatchObject({ login: 'pokimane', live: false, viewersCount: 0, game: '' })
  })

  it('drops malformed/null items but keeps the rest', async () => {
    gql.handler = async () =>
      ok({
        searchFor: {
          channels: {
            items: [null, { id: '9', login: 'good', displayName: 'Good' }, { id: 'x', login: '' }],
          },
        },
      })

    const results = await G.searchChannels('goo')
    expect(results).toHaveLength(1)
    expect(results[0].login).toBe('good')
  })

  it('treats an empty items list as a success (returns [])', async () => {
    gql.handler = async () => ok({ searchFor: { channels: { items: [] } } })
    await expect(G.searchChannels('zzz')).resolves.toEqual([])
  })

  it('treats missing/null channels gracefully as success', async () => {
    gql.handler = async () => ok({ searchFor: {} })
    await expect(G.searchChannels('zzz')).resolves.toEqual([])
  })

  it('sends the CHANNEL target index against searchFor', async () => {
    gql.handler = async () => ok({ searchFor: { channels: { items: [] } } })
    await G.searchChannels('lirik')
    const body = gql.calls.at(-1) ?? ''
    expect(body).toContain('searchFor')
    expect(body).toContain('index: CHANNEL')
    expect(body).toContain('"query":"lirik"')
  })

  it('throws on a top-level GQL errors array (NOT an empty list)', async () => {
    gql.handler = async () => gqlErrors()
    await expect(G.searchChannels('x')).rejects.toThrow()
  })

  it('throws on a transport (HTTP/network) failure rather than returning []', async () => {
    gql.handler = async () => {
      throw new Error('HTTP 500')
    }
    await expect(G.searchChannels('x')).rejects.toThrow('HTTP 500')
  })

  it('throws on a malformed (unparseable) response body', async () => {
    gql.handler = async () => 'not json'
    await expect(G.searchChannels('x')).rejects.toThrow()
  })
})

describe('gql browse — top streams', () => {
  it('parses streams edges into BrowseStream + carries the last cursor', async () => {
    gql.handler = async () =>
      ok({
        streams: {
          edges: [
            {
              cursor: 'aa',
              node: {
                id: 's1',
                title: 'Live One',
                viewersCount: 5000,
                previewImageURL: 'https://img/t1.jpg',
                broadcaster: { id: 'b1', login: 'one', displayName: 'One', profileImageURL: 'https://img/a1.png' },
                game: { id: 'g', name: 'just-chatting', displayName: 'Just Chatting' },
              },
            },
            {
              cursor: 'bb',
              node: {
                id: 's2',
                title: 'Live Two',
                viewersCount: 2500,
                previewImageURL: 'https://img/t2.jpg',
                broadcaster: { id: 'b2', login: 'two', displayName: 'Two' },
                game: { id: 'g2', name: 'art', displayName: 'Art' },
              },
            },
          ],
        },
      })

    const page = await G.fetchTopStreams()
    expect(page.streams).toHaveLength(2)
    expect(page.streams[0]).toMatchObject({
      login: 'one',
      displayName: 'One',
      avatarUrl: 'https://img/a1.png',
      title: 'Live One',
      game: 'Just Chatting',
      gameName: 'just-chatting',
      viewersCount: 5000,
      thumbnailUrl: 'https://img/t1.jpg',
    })
    // A stream missing an avatar still resolves with an empty avatarUrl.
    expect(page.streams[1].avatarUrl).toBe('')
    // Cursor is the LAST edge's cursor — the key used as `after` for pagination.
    expect(page.cursor).toBe('bb')
  })

  it('treats empty edges as a success with a null cursor', async () => {
    gql.handler = async () => ok({ streams: { edges: [] } })
    const page = await G.fetchTopStreams()
    expect(page.streams).toEqual([])
    expect(page.cursor).toBeNull()
  })

  it('forwards `after` cursor and `first` as pagination variables', async () => {
    gql.handler = async () => ok({ streams: { edges: [] } })
    await G.fetchTopStreams(15, 'page2cursor')
    expect(lastVars()).toMatchObject({ first: 15, after: 'page2cursor' })
  })

  it('throws on transport failure (never an empty page from an error)', async () => {
    gql.handler = async () => {
      throw new Error('HTTP 503')
    }
    await expect(G.fetchTopStreams()).rejects.toThrow('HTTP 503')
  })
})

describe('gql browse — top categories', () => {
  it('parses games edges into BrowseCategory + last cursor', async () => {
    gql.handler = async () =>
      ok({
        games: {
          edges: [
            { cursor: 'c1', node: { id: 'g1', name: 'just-chatting', displayName: 'Just Chatting', boxArtURL: 'https://img/b1.jpg' } },
            { cursor: 'c2', node: { id: 'g2', name: 'league-of-legends', displayName: 'League of Legends', boxArtURL: 'https://img/b2.jpg' } },
          ],
        },
      })

    const page = await G.fetchTopCategories()
    expect(page.categories).toHaveLength(2)
    expect(page.categories[0]).toMatchObject({ name: 'just-chatting', displayName: 'Just Chatting', boxArtUrl: 'https://img/b1.jpg' })
    expect(page.cursor).toBe('c2')
  })

  it('treats empty edges as success with null cursor', async () => {
    gql.handler = async () => ok({ games: { edges: [] } })
    const page = await G.fetchTopCategories()
    expect(page.categories).toEqual([])
    expect(page.cursor).toBeNull()
  })

  it('throws on GQL errors (not an empty list)', async () => {
    gql.handler = async () => gqlErrors()
    await expect(G.fetchTopCategories()).rejects.toThrow()
  })
})

describe('gql browse — game streams (drill-in)', () => {
  it('parses game(name:).streams edges and forwards the game name', async () => {
    gql.handler = async () =>
      ok({
        game: {
          streams: {
            edges: [
              {
                cursor: 'z1',
                node: {
                  id: 'gs1',
                  title: 'Ranked',
                  viewersCount: 1234,
                  previewImageURL: 'https://img/gt.jpg',
                  broadcaster: { id: 'gb', login: 'pro', displayName: 'Pro' },
                  game: { id: 'g', name: 'valorant', displayName: 'VALORANT' },
                },
              },
            ],
          },
        },
      })

    const page = await G.fetchGameStreams('valorant')
    expect(page.streams).toHaveLength(1)
    expect(page.streams[0]).toMatchObject({ login: 'pro', title: 'Ranked', viewersCount: 1234 })
    expect(page.cursor).toBe('z1')
    expect(lastVars()).toMatchObject({ name: 'valorant' })
  })

  it('treats a null game (unknown category) as success with no streams', async () => {
    gql.handler = async () => ok({ game: null })
    const page = await G.fetchGameStreams('does-not-exist')
    expect(page.streams).toEqual([])
    expect(page.cursor).toBeNull()
  })

  it('throws on transport failure', async () => {
    gql.handler = async () => {
      throw new Error('HTTP 429')
    }
    await expect(G.fetchGameStreams('valorant')).rejects.toThrow('HTTP 429')
  })
})

describe('gql abort support', () => {
  it('rejects with "aborted" when the signal is already aborted', async () => {
    const controller = new AbortController()
    controller.abort()
    // No gql_fetch should have been issued.
    gql.handler = async () => ok({ searchFor: { channels: { items: [] } } })
    await expect(G.searchChannels('x', controller.signal)).rejects.toThrow('aborted')
    expect(gql.calls).toHaveLength(0)
  })

  it('rejects as aborted if the signal fires after the response resolves', async () => {
    const controller = new AbortController()
    gql.handler = async () => {
      // Abort mid-flight (after invoke was dispatched, before the caller sees it).
      controller.abort()
      return ok({ searchFor: { channels: { items: [{ id: '1', login: 'stale' }] } } })
    }
    await expect(G.searchChannels('x', controller.signal)).rejects.toThrow('aborted')
  })
})
