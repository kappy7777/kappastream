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
  it('parses streams edges into BrowseStream', async () => {
    gql.handler = async () =>
      ok({
        streams: {
          edges: [
            {
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
  })

  it('treats empty edges as a success', async () => {
    gql.handler = async () => ok({ streams: { edges: [] } })
    const page = await G.fetchTopStreams()
    expect(page.streams).toEqual([])
  })

  it('sends first:30 (the hard API cap) and never an `after` cursor', async () => {
    gql.handler = async () => ok({ streams: { edges: [] } })
    await G.fetchTopStreams()
    const vars = lastVars()
    expect(vars).toMatchObject({ first: 30 })
    expect(vars).not.toHaveProperty('after')
    // No cursor is requested at all in the query text.
    expect(gql.calls.at(-1) ?? '').not.toContain('$after')
    expect(gql.calls.at(-1) ?? '').not.toContain('after:')
  })

  it('throws on transport failure (never an empty page from an error)', async () => {
    gql.handler = async () => {
      throw new Error('HTTP 503')
    }
    await expect(G.fetchTopStreams()).rejects.toThrow('HTTP 503')
  })
})

describe('gql browse — top categories', () => {
  it('parses games edges into BrowseCategory', async () => {
    gql.handler = async () =>
      ok({
        games: {
          edges: [
            { node: { id: 'g1', name: 'just-chatting', displayName: 'Just Chatting', boxArtURL: 'https://img/b1.jpg' } },
            { node: { id: 'g2', name: 'league-of-legends', displayName: 'League of Legends', boxArtURL: 'https://img/b2.jpg' } },
          ],
        },
      })

    const page = await G.fetchTopCategories()
    expect(page.categories).toHaveLength(2)
    expect(page.categories[0]).toMatchObject({ name: 'just-chatting', displayName: 'Just Chatting', boxArtUrl: 'https://img/b1.jpg' })
  })

  it('treats empty edges as success', async () => {
    gql.handler = async () => ok({ games: { edges: [] } })
    const page = await G.fetchTopCategories()
    expect(page.categories).toEqual([])
  })

  it('over-fetches first:100 (so BrowseView can reveal client-side) with no `after`', async () => {
    gql.handler = async () => ok({ games: { edges: [] } })
    await G.fetchTopCategories()
    const vars = lastVars()
    expect(vars).toMatchObject({ first: 100 })
    expect(vars).not.toHaveProperty('after')
    expect(gql.calls.at(-1) ?? '').not.toContain('$after')
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
    expect(lastVars()).toMatchObject({ name: 'valorant' })
  })

  it('treats a null game (unknown category) as success with no streams', async () => {
    gql.handler = async () => ok({ game: null })
    const page = await G.fetchGameStreams('does-not-exist')
    expect(page.streams).toEqual([])
  })

  it('over-fetches first:100 with no `after`', async () => {
    gql.handler = async () => ok({ game: { streams: { edges: [] } } })
    await G.fetchGameStreams('valorant')
    const vars = lastVars()
    expect(vars).toMatchObject({ first: 100, name: 'valorant' })
    expect(vars).not.toHaveProperty('after')
    expect(gql.calls.at(-1) ?? '').not.toContain('$after')
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

describe('gql channel content — videos', () => {
  it('parses video edges into ChannelVideo', async () => {
    gql.handler = async () =>
      ok({
        user: {
          videos: {
            edges: [
              {
                node: {
                  id: '111',
                  title: 'Yesterday stream',
                  lengthSeconds: 7200,
                  viewCount: 1234,
                  createdAt: '2026-07-20T00:00:00Z',
                  previewThumbnailURL: 'https://img/t.jpg',
                  broadcastType: 'ARCHIVE',
                  game: { id: 'g', name: 'just-chatting', displayName: 'Just Chatting' },
                },
              },
            ],
          },
        },
      })

    const vids = await G.fetchChannelVideos('summit1g', 'ARCHIVE')
    expect(vids).toHaveLength(1)
    expect(vids[0]).toMatchObject({
      id: '111',
      title: 'Yesterday stream',
      lengthSeconds: 7200,
      viewCount: 1234,
      thumbnailUrl: 'https://img/t.jpg',
      broadcastType: 'ARCHIVE',
      game: 'Just Chatting',
    })
    // The type + first are forwarded; no `after`.
    expect(lastVars()).toMatchObject({ login: 'summit1g', first: 100, type: 'ARCHIVE' })
    expect(lastVars()).not.toHaveProperty('after')
  })

  it('treats an empty / no-videos channel as a success (returns [])', async () => {
    gql.handler = async () => ok({ user: { videos: { edges: [] } } })
    await expect(G.fetchChannelVideos('esl_csgo', 'HIGHLIGHT')).resolves.toEqual([])
  })

  it('treats a null user as a success (returns [])', async () => {
    gql.handler = async () => ok({ user: null })
    await expect(G.fetchChannelVideos('ghost', 'ARCHIVE')).resolves.toEqual([])
  })

  it('throws on transport failure rather than returning []', async () => {
    gql.handler = async () => {
      throw new Error('HTTP 500')
    }
    await expect(G.fetchChannelVideos('x', 'ARCHIVE')).rejects.toThrow('HTTP 500')
  })
})

describe('gql channel content — clips', () => {
  it('parses clip edges into ChannelClip', async () => {
    gql.handler = async () =>
      ok({
        user: {
          clips: {
            edges: [
              {
                node: {
                  id: '222',
                  slug: 'CrispyJollyGullHassaanChop-nPlLKGxGRcBj37e4',
                  title: 'Best moment',
                  durationSeconds: 42,
                  viewCount: 9999,
                  createdAt: '2026-07-01T00:00:00Z',
                  thumbnailURL: 'https://img/c.jpg',
                  game: { id: 'g', name: 'valorant', displayName: 'VALORANT' },
                  curator: { id: '9', login: 'clipper', displayName: 'Clipper' },
                },
              },
            ],
          },
        },
      })

    const clips = await G.fetchChannelClips('kaicenat')
    expect(clips).toHaveLength(1)
    expect(clips[0]).toMatchObject({
      slug: 'CrispyJollyGullHassaanChop-nPlLKGxGRcBj37e4',
      title: 'Best moment',
      durationSeconds: 42,
      viewCount: 9999,
      game: 'VALORANT',
      curator: 'Clipper',
    })
    // ALL_TIME + VIEWS_DESC + first:100, no `after`.
    expect(gql.calls.at(-1) ?? '').toContain('ALL_TIME')
    expect(gql.calls.at(-1) ?? '').toContain('VIEWS_DESC')
    expect(lastVars()).toMatchObject({ login: 'kaicenat', first: 100 })
  })

  it('treats a channel with no clips as a success (returns [])', async () => {
    gql.handler = async () => ok({ user: { clips: { edges: [] } } })
    await expect(G.fetchChannelClips('no-clips-channel')).resolves.toEqual([])
  })

  it('throws on transport failure rather than returning []', async () => {
    gql.handler = async () => gqlErrors()
    await expect(G.fetchChannelClips('x')).rejects.toThrow()
  })
})

describe('gql channel content — clip media', () => {
  it('parses videoQualities sorted highest quality first', async () => {
    gql.handler = async () =>
      ok({
        clip: {
          id: '333',
          title: 'broo',
          durationSeconds: 5,
          videoQualities: [
            { quality: '480', frameRate: 30, sourceURL: 'https://d.cloudfront.net/480.mp4' },
            { quality: '1080', frameRate: 60, sourceURL: 'https://d.cloudfront.net/1080.mp4' },
            { quality: '720', frameRate: 60, sourceURL: 'https://d.cloudfront.net/720.mp4' },
          ],
        },
      })

    const media = await G.fetchClipMedia('SomeSlug-abc123')
    expect(media.id).toBe('333')
    expect(media.qualities.map((q) => q.quality)).toEqual(['1080', '720', '480'])
    expect(media.qualities[0].sourceUrl).toBe('https://d.cloudfront.net/1080.mp4')
  })

  it('throws "clip not found" for an unknown slug (null clip)', async () => {
    gql.handler = async () => ok({ clip: null })
    await expect(G.fetchClipMedia('NoSuchSlug-x')).rejects.toThrow('clip not found')
  })

  it('throws if the slug fails validation before any request', async () => {
    gql.handler = async () => ok({ clip: { id: '1', videoQualities: [] } })
    await expect(G.fetchClipMedia('bad slug!')).rejects.toThrow('invalid clip slug')
    await expect(G.fetchClipMedia('')).rejects.toThrow('invalid clip slug')
    // No request should have been issued for the invalid slug.
    expect(gql.calls).toHaveLength(0)
  })

  it('throws when the clip has no playable media', async () => {
    gql.handler = async () => ok({ clip: { id: '1', videoQualities: [] } })
    await expect(G.fetchClipMedia('GoodSlug-1')).rejects.toThrow('no playable media')
  })

  it('throws on transport failure', async () => {
    gql.handler = async () => {
      throw new Error('HTTP 502')
    }
    await expect(G.fetchClipMedia('GoodSlug-1')).rejects.toThrow('HTTP 502')
  })
})

describe('gql channel content — clip slug validator', () => {
  it('accepts real Twitch clip slugs', () => {
    expect(G.isValidClipSlug('CrispyJollyGullHassaanChop-nPlLKGxGRcBj37e4')).toBe(true)
    expect(G.isValidClipSlug('SwissManlyKangarooPRChase-fCO_OHO9QUIuPGlg')).toBe(true)
    expect(G.isValidClipSlug('GoodAlertBurritoTheTarFu')).toBe(true)
  })

  it('rejects malformed / injection slugs', () => {
    expect(G.isValidClipSlug('')).toBe(false)
    expect(G.isValidClipSlug('bad slug')).toBe(false) // space
    expect(G.isValidClipSlug('bad/slug')).toBe(false) // path separator
    expect(G.isValidClipSlug('bad?slug')).toBe(false) // query
    expect(G.isValidClipSlug('bad#slug')).toBe(false) // fragment
    expect(G.isValidClipSlug("bad'slug")).toBe(false) // quote
    expect(G.isValidClipSlug('twitch.tv/x/clip/slug')).toBe(false) // url
    expect(G.isValidClipSlug('a'.repeat(101))).toBe(false) // too long
  })
})
