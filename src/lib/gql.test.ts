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
 * Discovery is GQL-only, so the central rule under test is: an empty result
 * set is a SUCCESS (returns []), while a transport failure (HTTP error,
 * malformed body, top-level GQL `errors`) THROWS so the caller can surface a
 * visible error instead of silently showing "no results".
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

  it('throws on a short users array instead of marking channels offline', async () => {
    // A legitimate batch returns one positional entry per login (null for
    // unknown). A short array is anomalous; zipping positionally would
    // silently report every channel as offline. It must throw so favorites
    // treats it as a transport failure (keeps last-known status) rather than
    // committing a wrong status.
    gql.handler = async () => ok({ users: [] })
    await expect(G.fetchChannelStatuses(['alpha', 'beta'])).rejects.toThrow(
      'gql short response',
    )
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
                login: 'chan1',
                displayName: 'chan1',
                profileImageURL: 'https://img/chan1.png',
                stream: {
                  id: 'st',
                  title: 'Aimlabs',
                  viewersCount: 9001,
                  game: { id: 'g', name: 'valorant', displayName: 'VALORANT' },
                },
              },
              {
                id: '22',
                login: 'chan6',
                displayName: 'chan6',
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
      login: 'chan1',
      displayName: 'chan1',
      avatarUrl: 'https://img/chan1.png',
      live: true,
      title: 'Aimlabs',
      game: 'VALORANT',
      viewersCount: 9001,
    })
    // An offline match still appears, just with live:false and empty stream fields.
    expect(results[1]).toMatchObject({ login: 'chan6', live: false, viewersCount: 0, game: '' })
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
    await G.searchChannels('chan2')
    const body = gql.calls.at(-1) ?? ''
    expect(body).toContain('searchFor')
    expect(body).toContain('index: CHANNEL')
    expect(body).toContain('"query":"chan2"')
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

    const vids = await G.fetchChannelVideos('chan3', 'ARCHIVE')
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
    expect(lastVars()).toMatchObject({ login: 'chan3', first: 100, type: 'ARCHIVE' })
    expect(lastVars()).not.toHaveProperty('after')
  })

  it('treats an empty / no-videos channel as a success (returns [])', async () => {
    gql.handler = async () => ok({ user: { videos: { edges: [] } } })
    await expect(G.fetchChannelVideos('chan8', 'HIGHLIGHT')).resolves.toEqual([])
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
                  slug: 'HappySunnyOtterRabbitTacos-aB3xKQ9vZRtM5cWf',
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

    const clips = await G.fetchChannelClips('chan7')
    expect(clips).toHaveLength(1)
    expect(clips[0]).toMatchObject({
      slug: 'HappySunnyOtterRabbitTacos-aB3xKQ9vZRtM5cWf',
      title: 'Best moment',
      durationSeconds: 42,
      viewCount: 9999,
      game: 'VALORANT',
      curator: 'Clipper',
    })
    // ALL_TIME + VIEWS_DESC + first:100, no `after`.
    expect(gql.calls.at(-1) ?? '').toContain('ALL_TIME')
    expect(gql.calls.at(-1) ?? '').toContain('VIEWS_DESC')
    expect(lastVars()).toMatchObject({ login: 'chan7', first: 100 })
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
          title: 'nice shot',
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

describe('gql clip info (metadata for chat/pin clip links)', () => {
  it('parses title/game/views/age/curator into a ChannelClip', async () => {
    gql.handler = async () =>
      ok({
        clip: {
          id: '5e0a1d',
          slug: 'HappySunnyOtterRabbitTacos-aB3xKQ9vZRtM5cWf',
          title: 'nice shot',
          durationSeconds: 30,
          viewCount: 1234,
          createdAt: '2026-09-01T00:00:00Z',
          thumbnailURL: 'https://clips-media-assets2.twitch.tv/x-preview-480x272.jpg',
          game: { displayName: 'Path of Exile 2' },
          curator: { login: 'clipper', displayName: 'Clipper' },
        },
      })

    const clip = await G.fetchClipInfo('HappySunnyOtterRabbitTacos-aB3xKQ9vZRtM5cWf')
    expect(clip).not.toBeNull()
    expect(clip?.title).toBe('nice shot')
    expect(clip?.game).toBe('Path of Exile 2')
    expect(clip?.viewCount).toBe(1234)
    expect(clip?.createdAt).toBe('2026-09-01T00:00:00Z')
    expect(clip?.durationSeconds).toBe(30)
    expect(clip?.curator).toBe('Clipper')
    // The metadata query rides the same anonymous transport as clip media…
    expect(gql.calls).toHaveLength(1)
    // …but is metadata-only (no videoQualities media payload).
    const body = gql.calls[0]
    expect(body).toContain('clip(slug: $slug)')
    expect(body).toContain('title')
    expect(body).not.toContain('videoQualities')
    expect(lastVars()).toEqual({ slug: 'HappySunnyOtterRabbitTacos-aB3xKQ9vZRtM5cWf' })
  })

  it('returns null for an unknown/unindexed clip (null clip)', async () => {
    gql.handler = async () => ok({ clip: null })
    expect(await G.fetchClipInfo('NoSuchSlug-x')).toBeNull()
  })

  it('returns null for an invalid slug without issuing any request', async () => {
    gql.handler = async () => ok({ clip: { id: '1', slug: 'x' } })
    expect(await G.fetchClipInfo('bad slug!')).toBeNull()
    expect(await G.fetchClipInfo('')).toBeNull()
    expect(gql.calls).toHaveLength(0)
  })

  it('throws on transport failure (caller keeps the placeholder)', async () => {
    gql.handler = async () => {
      throw new Error('HTTP 502')
    }
    await expect(G.fetchClipInfo('GoodSlug-1')).rejects.toThrow('HTTP 502')
  })
})

describe('gql channel content — clip slug validator', () => {
  it('accepts realistic Twitch clip slugs', () => {
    expect(G.isValidClipSlug('HappySunnyOtterRabbitTacos-aB3xKQ9vZRtM5cWf')).toBe(true)
    expect(G.isValidClipSlug('MellowBraveWombatsPRDash-qR7_NDU8WQkc3mLz')).toBe(true)
    expect(G.isValidClipSlug('CozyBrightLlamaTheMuffin')).toBe(true)
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

describe('gql VOD extras (chapters / mutes / storyboard URL)', () => {
  it('parses chapters, muted segments, and the storyboard URL', async () => {
    gql.handler = async () =>
      ok({
        video: {
          id: '5000000001',
          seekPreviewsURL: 'https://d2vi6trrdongqn.cloudfront.net/x/storyboards/5000000001-info.json',
          muteInfo: {
            mutedSegmentConnection: {
              nodes: [
                { duration: 180, offset: 36180 },
                { duration: 360, offset: 0 },
              ],
            },
          },
          moments: {
            edges: [
              { node: { type: 'GAME_CHANGE', positionMilliseconds: 0, durationMilliseconds: 83000, description: 'Chapter 1', details: null } },
              { node: { type: 'GAME_CHANGE', positionMilliseconds: 83000, durationMilliseconds: 10890000, description: '', details: { game: { displayName: 'Just Chatting' } } } },
              { node: { type: 'GAME_CHANGE', positionMilliseconds: 10973000, durationMilliseconds: 74000, description: '', details: { game: { displayName: 'Grand Theft Auto V' } } } },
            ],
          },
        },
      })

    const extras = await G.fetchVideoExtras('5000000001')
    expect(extras.chapters).toEqual([
      { startSec: 0, label: 'Chapter 1' },
      { startSec: 83, label: 'Just Chatting' },
      { startSec: 10973, label: 'Grand Theft Auto V' },
    ])
    expect(extras.mutedSpans).toEqual([
      { startSec: 0, endSec: 360 },
      { startSec: 36180, endSec: 36360 },
    ])
    expect(extras.seekPreviewsUrl).toBe('https://d2vi6trrdongqn.cloudfront.net/x/storyboards/5000000001-info.json')
  })

  it('falls back to a positional label when a moment has neither description nor game', async () => {
    gql.handler = async () =>
      ok({
        video: {
          id: '1',
          moments: { edges: [{ node: { positionMilliseconds: 5000, description: null, details: null } }] },
        },
      })
    const extras = await G.fetchVideoExtras('1')
    expect(extras.chapters).toEqual([{ startSec: 5, label: 'Chapter 1' }])
  })

  it('treats missing extras (null video / empty edges / null nodes) as success', async () => {
    gql.handler = async () => ok({ video: null })
    expect(await G.fetchVideoExtras('42')).toEqual({ chapters: [], mutedSpans: [], seekPreviewsUrl: null })

    gql.handler = async () =>
      ok({
        video: {
          id: '42',
          seekPreviewsURL: null,
          muteInfo: null,
          moments: { edges: [null, { node: null }, { node: { positionMilliseconds: -5 } }] },
        },
      })
    const extras = await G.fetchVideoExtras('42')
    expect(extras.chapters).toEqual([])
    expect(extras.mutedSpans).toEqual([])
    expect(extras.seekPreviewsUrl).toBeNull()
  })

  it('drops malformed muted segments and clamps nothing into the timeline', async () => {
    gql.handler = async () =>
      ok({
        video: {
          id: '1',
          muteInfo: { mutedSegmentConnection: { nodes: [{ offset: 10 }, { duration: 30 }, { offset: -1, duration: 5 }] } },
        },
      })
    expect((await G.fetchVideoExtras('1')).mutedSpans).toEqual([])
  })

  it('validates the vod id before any request and throws on transport failure', async () => {
    gql.handler = async () => ok({ video: null })
    await expect(G.fetchVideoExtras('abc')).rejects.toThrow('invalid vod id')
    await expect(G.fetchVideoExtras('../escape')).rejects.toThrow('invalid vod id')
    expect(gql.calls).toHaveLength(0)

    gql.handler = async () => gqlErrors()
    await expect(G.fetchVideoExtras('123')).rejects.toThrow()
  })
})

describe('gql favorites batch — Stream Together / costream fields', () => {
  it('parses collaborationViewersCount + costreamDetails (classic costream)', async () => {
    gql.handler = async () =>
      ok({
        users: [
          {
            id: '1',
            login: 'chan12',
            displayName: 'Chan12',
            profileImageURL: 'https://img/chan12.png',
            stream: {
              id: 's1',
              title: 'FINAL',
              type: 'live',
              viewersCount: 3041,
              createdAt: '2024-01-01T00:00:00Z',
              previewImageURL: 'https://img/t.png',
              collaborationViewersCount: 14986,
              costreamDetails: {
                costreamersCount: 5,
                topCostreamers: [
                  { profileImageURL: 'https://img/c1.png' },
                  { profileImageURL: 'https://img/c2.png' },
                ],
              },
              game: { id: 'g1', name: 'league-of-legends', displayName: 'League of Legends' },
            },
          },
        ],
      })

    const statuses = await G.fetchChannelStatuses(['chan12'])
    expect(statuses[0].collabViewers).toBe(14986)
    expect(statuses[0].collabOthers).toBe(5)
    expect(statuses[0].collabAvatar).toBe('https://img/c1.png')
  })

  it('guest-star sessions: collabViewers set, roster fields empty (null details)', async () => {
    gql.handler = async () =>
      ok({
        users: [
          {
            id: '1',
            login: 'chan9',
            displayName: 'Chan9',
            profileImageURL: 'https://img/tm.png',
            stream: {
              id: 's2',
              title: 'Costream',
              type: 'live',
              viewersCount: 11109,
              createdAt: '2024-01-01T00:00:00Z',
              previewImageURL: null,
              collaborationViewersCount: 41103,
              game: null,
            },
          },
        ],
      })

    const statuses = await G.fetchChannelStatuses(['chan9'])
    expect(statuses[0].collabViewers).toBe(41103)
    expect(statuses[0].collabOthers).toBe(0)
    expect(statuses[0].collabAvatar).toBe('')
  })

  it('plain streams / offline / null users carry no collab state', async () => {
    gql.handler = async () =>
      ok({
        users: [
          {
            id: '1',
            login: 'solo',
            displayName: 'solo',
            stream: {
              id: 's3',
              title: 'x',
              type: 'live',
              viewersCount: 1,
              createdAt: '2024-01-01T00:00:00Z',
              collaborationViewersCount: null,
              costreamDetails: null,
            },
          },
          { id: '2', login: 'off', displayName: 'off', stream: null },
          null,
        ],
      })

    const statuses = await G.fetchChannelStatuses(['solo', 'off', 'ghost'])
    for (const s of statuses) {
      expect(s.collabViewers).toBeNull()
      expect(s.collabOthers).toBe(0)
      expect(s.collabAvatar).toBe('')
    }
  })

  it('malformed costreamDetails degrade to unknown roster', async () => {
    gql.handler = async () =>
      ok({
        users: [
          {
            id: '1',
            login: 'weird',
            displayName: 'weird',
            stream: {
              id: 's4',
              title: 'x',
              type: 'live',
              viewersCount: 1,
              createdAt: '2024-01-01T00:00:00Z',
              collaborationViewersCount: 500,
              costreamDetails: { costreamersCount: -3, topCostreamers: [null, { profileImageURL: '' }] },
            },
          },
        ],
      })

    const statuses = await G.fetchChannelStatuses(['weird'])
    expect(statuses[0].collabViewers).toBe(500)
    expect(statuses[0].collabOthers).toBe(0)
    expect(statuses[0].collabAvatar).toBe('')
  })
})

describe('gql favorites batch — followers + organizer combined count', () => {
  it('parses the follower count from the batched user object', async () => {
    gql.handler = async () =>
      ok({
        users: [
          {
            id: '1',
            login: 'chan7',
            displayName: 'Chan7',
            followers: { totalCount: 12345678 },
            stream: {
              id: 's1', title: 'x', type: 'live', viewersCount: 1,
              createdAt: '2024-01-01T00:00:00Z', collaborationViewersCount: null,
            },
          },
          { id: '2', login: 'off', displayName: 'off', followers: null, stream: null },
        ],
      })

    const statuses = await G.fetchChannelStatuses(['chan7', 'off'])
    expect(statuses[0].followers).toBe(12345678)
    expect(statuses[1].followers).toBeNull()
  })

  it('an ORGANIZER carries the combined count via costreamDetails.totalViewersCount', async () => {
    gql.handler = async () =>
      ok({
        users: [
          {
            id: '1',
            login: 'chan12',
            displayName: 'Chan12',
            followers: { totalCount: 100 },
            stream: {
              id: 's1', title: 'FINAL', type: 'live', viewersCount: 3041,
              createdAt: '2024-01-01T00:00:00Z',
              collaborationViewersCount: null,
              costreamDetails: {
                costreamersCount: 5,
                totalViewersCount: 14986,
                topCostreamers: [{ profileImageURL: 'https://img/j.png' }],
              },
            },
          },
        ],
      })

    const statuses = await G.fetchChannelStatuses(['chan12'])
    expect(statuses[0].collabViewers).toBe(14986)
    expect(statuses[0].collabOthers).toBe(5)
    expect(statuses[0].collabAvatar).toBe('https://img/j.png')
  })
})


describe('gql collaboration roster (channel(id:).collaboration)', () => {
  it('fetches aliased rosters in one request, ACTIVE members only, self included', async () => {
    gql.handler = async (body) => {
      const vars = JSON.parse(body).variables
      expect(Object.keys(vars).sort()).toEqual(['id0', 'id1'])
      return ok({
        c0: {
          collaboration: {
            collaborators: [
              { role: 'LEADER', status: 'ACTIVE', user: { login: 'cohost1', displayName: 'cohost1', profileImageURL: 'https://img/r.png' } },
              { role: 'MEMBER', status: 'ACTIVE', user: { login: 'cohost2', displayName: 'Cohost2', profileImageURL: 'https://img/n.png' } },
              { role: 'MEMBER', status: 'INVITED', user: { login: 'ghost_guest', displayName: 'ghost', profileImageURL: 'https://img/g.png' } },
              { role: 'MEMBER', status: 'ACTIVE', user: { login: '', displayName: 'nologin', profileImageURL: null } },
              null,
            ],
          },
        },
        c1: { collaboration: null }, // not in a session
      })
    }
    const rosters = await G.fetchCollaborators(['200000001', '200000002'])
    expect(rosters.size).toBe(1)
    expect(rosters.get('200000001')).toEqual([
      { login: 'cohost1', displayName: 'cohost1', avatarUrl: 'https://img/r.png', role: 'LEADER' },
      { login: 'cohost2', displayName: 'Cohost2', avatarUrl: 'https://img/n.png', role: 'MEMBER' },
    ])
    expect(rosters.has('200000002')).toBe(false)
  })

  it('empty and non-numeric ids never issue a request', async () => {
    gql.handler = async () => {
      throw new Error('should not be called')
    }
    expect((await G.fetchCollaborators([])).size).toBe(0)
    expect((await G.fetchCollaborators(['abc', '../escape', ''])).size).toBe(0)
    expect(gql.calls).toHaveLength(0)
  })

  it('chunks more than 30 ids into multiple requests', async () => {
    let requests = 0
    gql.handler = async (body) => {
      requests++
      const vars = JSON.parse(body).variables as Record<string, string>
      const data: Record<string, unknown> = {}
      for (const [k, v] of Object.entries(vars)) {
        data[k.replace('id', 'c')] = {
          collaboration: { collaborators: [{ role: 'LEADER', status: 'ACTIVE', user: { login: 'x' + v, displayName: 'x', profileImageURL: null } }] },
        }
      }
      return ok(data)
    }
    const ids = Array.from({ length: 65 }, (_, i) => String(1000 + i))
    const rosters = await G.fetchCollaborators(ids)
    expect(requests).toBe(3) // 30 + 30 + 5
    expect(rosters.size).toBe(65)
  })

  it('throws on transport failure (caller treats as no roster)', async () => {
    gql.handler = async () => gqlErrors()
    await expect(G.fetchCollaborators(['200000001'])).rejects.toThrow()
  })
})

describe('gql pinned chat messages (channel(id:).pinnedChatMessages)', () => {
  // Fixture mirrors the VERIFIED live response shape (channels with actively
  // pinned messages; same field the twitch.tv logged-out client reads via its
  // GetPinnedChat operation).
  const pinNode = {
    id: '11111111-1111-4111-8111-111111111111', // PIN id — distinct from the message id
    type: 'MOD',
    startsAt: '2020-01-01T12:00:21Z',
    updatedAt: '2020-01-01T12:00:23Z',
    endsAt: null,
    pinnedBy: { id: '30000001', login: 'pinmod1', displayName: 'Pinmod1' },
    pinnedMessage: {
      id: '22222222-2222-4222-8222-222222222222',
      sentAt: '2020-01-01T12:00:18.123456789Z',
      content: {
        text: 'check this Kappa https://bit.ly/x',
        fragments: [
          { text: 'check this ', content: null },
          { text: 'Kappa', content: { id: '1712' } }, // Emote member of FragmentContent
          { text: ' https://bit.ly/x', content: null },
        ],
      },
      sender: {
        id: '30000002',
        login: 'chatbot1',
        displayName: 'Chatbot1',
        chatColor: '#9146FF',
        displayBadges: [
          { id: 'bW9kZXJhdG9yOzE7', setID: 'moderator', version: '1' },
          { id: 'cGFydG5lcjsxOw==', setID: 'partner', version: '1' },
        ],
      },
    },
  }

  it('parses the verified response shape, keeping pin id ≠ message id', async () => {
    gql.handler = async () => ok({ channel: { pinnedChatMessages: { edges: [{ node: pinNode }] } } })
    const pins = await G.fetchPinnedChatMessages('200000003')
    expect(pins).toHaveLength(1)
    const pin = pins[0]
    expect(pin.pinId).toBe('11111111-1111-4111-8111-111111111111')
    expect(pin.messageId).toBe('22222222-2222-4222-8222-222222222222')
    expect(pin.pinId).not.toBe(pin.messageId)
    expect(pin.type).toBe('MOD')
    expect(pin.endsAt).toBe('') // null → '' (no expiry)
    expect(pin.pinnedBy).toEqual({ login: 'pinmod1', displayName: 'Pinmod1' })
    expect(pin.message?.text).toBe('check this Kappa https://bit.ly/x')
    expect(pin.message?.fragments).toEqual([
      { text: 'check this ', emoteId: null },
      { text: 'Kappa', emoteId: '1712' },
      { text: ' https://bit.ly/x', emoteId: null },
    ])
    expect(pin.message?.sender).toEqual({
      login: 'chatbot1',
      displayName: 'Chatbot1',
      chatColor: '#9146FF',
      badges: [
        { setID: 'moderator', version: '1' },
        { setID: 'partner', version: '1' },
      ],
    })
    expect(lastVars()).toMatchObject({ id: '200000003' })
  })

  it('empty edges / null connection / null channel are all successes (returns [])', async () => {
    gql.handler = async () => ok({ channel: { pinnedChatMessages: { edges: [] } } })
    await expect(G.fetchPinnedChatMessages('1')).resolves.toEqual([])
    gql.handler = async () => ok({ channel: { pinnedChatMessages: null } })
    await expect(G.fetchPinnedChatMessages('1')).resolves.toEqual([])
    gql.handler = async () => ok({ channel: null })
    await expect(G.fetchPinnedChatMessages('1')).resolves.toEqual([])
  })

  it('drops malformed nodes and pins without a message body, keeps the rest', async () => {
    gql.handler = async () =>
      ok({
        channel: {
          pinnedChatMessages: {
            edges: [
              null,
              { node: null },
              { node: { ...pinNode, pinnedMessage: null } }, // nothing to render
              { node: { ...pinNode, id: 'pin-2' } },
            ],
          },
        },
      })
    const pins = await G.fetchPinnedChatMessages('1')
    expect(pins).toHaveLength(1)
    expect(pins[0].pinId).toBe('pin-2')
  })

  it('caps fragments at 50 and the rebuilt text at 2000 chars', async () => {
    const many = Array.from({ length: 80 }, (_, i) => ({ text: `frag${i} `, content: null }))
    gql.handler = async () =>
      ok({ channel: { pinnedChatMessages: { edges: [{ node: { ...pinNode, pinnedMessage: { ...pinNode.pinnedMessage, content: { text: many.map((f) => f.text).join(''), fragments: many } } } }] } } })
    const pins = await G.fetchPinnedChatMessages('1')
    expect(pins[0].message?.fragments).toHaveLength(50)
    expect(pins[0].message?.text.length).toBeLessThanOrEqual(2000)
  })

  it('never selects pinnedChatSettings and never paginates (no after/first args)', async () => {
    gql.handler = async () => ok({ channel: { pinnedChatMessages: { edges: [] } } })
    await G.fetchPinnedChatMessages('1')
    const body = gql.calls.at(-1) ?? ''
    expect(body).toContain('pinnedChatMessages')
    expect(body).not.toContain('pinnedChatSettings')
    expect(body).not.toContain('$after')
    expect(body).not.toContain('after:')
    expect(body).not.toContain('first:')
  })

  it('validates the channel id before any request', async () => {
    gql.handler = async () => ok({ channel: null })
    await expect(G.fetchPinnedChatMessages('abc')).rejects.toThrow('invalid channel id')
    await expect(G.fetchPinnedChatMessages('')).rejects.toThrow('invalid channel id')
    expect(gql.calls).toHaveLength(0)
  })

  it('throws on transport failure (caller degrades to no pin)', async () => {
    gql.handler = async () => gqlErrors()
    await expect(G.fetchPinnedChatMessages('1')).rejects.toThrow()
    gql.handler = async () => {
      throw new Error('HTTP 500')
    }
    await expect(G.fetchPinnedChatMessages('1')).rejects.toThrow('HTTP 500')
  })
})
