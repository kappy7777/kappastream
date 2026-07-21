import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import type { RenderedMessagePart } from './emotes'

/*
 * Unit tests for src/lib/emotes.ts.
 *
 * The 7TV / FFZ parsing functions are not exported individually, so the
 * alias, PERSONAL/LISTED, and FFZ-global cases are exercised end-to-end via
 * loadChannelEmotes / loadGlobalEmotes. fetch is stubbed per-test to return
 * canned provider responses, and `invoke('gql_fetch')` (used by
 * getTwitchUserId via resolveUserIds) is mocked via vi.mock. The module-level
 * emote cache is reset between tests with vi.resetModules + a fresh dynamic
 * import (same pattern as favorites.test.ts).
 *
 * The trailing-punctuation and emoteOnly cases exercise the pure
 * renderMessage path with a hand-built emote map — no network mocking.
 */

const tauriInvoke = vi.hoisted(() => ({
  handler: async (_cmd: string, _args: Record<string, unknown>): Promise<unknown> => {
    throw new Error('invoke handler not configured for this test')
  },
}))

vi.mock('@tauri-apps/api/core', () => ({
  invoke: (cmd: string, args: Record<string, unknown>): Promise<unknown> =>
    tauriInvoke.handler(cmd, args),
  isTauri: () => false,
}))

type EmotesMod = typeof import('./emotes')
let E: EmotesMod

type MockResponse = { ok: boolean; json: () => Promise<unknown> }
type FetchImpl = (url: string, opts?: { signal?: AbortSignal }) => Promise<MockResponse>
let fetchImpl: FetchImpl

function jsonRes(body: unknown): MockResponse {
  return { ok: true, json: async () => body }
}

beforeEach(async () => {
  vi.resetModules()
  tauriInvoke.handler = async () => {
    throw new Error('invoke handler not configured')
  }
  fetchImpl = async () => {
    throw new Error('fetch not configured for this test')
  }
  vi.stubGlobal('fetch', (url: string, opts?: { signal?: AbortSignal }) => fetchImpl(url, opts))
  E = await import('./emotes')
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('7TV set-entry alias', () => {
  it('keys a renamed emote by its set-entry name, not data.name', async () => {
    // A channel renames catErm to erm; chatters type "erm". The 7TV v3
    // set-entry shape is { name: "erm", data: { name: "catErm" } } — the
    // top-level name is the alias active in that set.
    tauriInvoke.handler = async (cmd: string) => {
      // getTwitchUserId now resolves via the batched GQL command, not
      // decapi_fetch('twitch/id/<user>'). Return a valid single-user response
      // so resolveUserIds maps 'somenick' -> '12345'.
      if (cmd === 'gql_fetch') {
        return JSON.stringify({ data: { users: [{ id: '12345', login: 'somenick' }] } })
      }
      throw new Error('unexpected invoke: ' + cmd)
    }
    fetchImpl = async (url) => {
      if (url.startsWith('https://7tv.io/v3/users/twitch/')) {
        return jsonRes({
          emote_set: {
            id: 'set1',
            emotes: [
              { id: 'abc', name: 'erm', data: { id: 'abc', name: 'catErm', state: [], listed: true } },
            ],
          },
        })
      }
      // BTTV / FFZ channel endpoints — empty payloads collapse to [].
      if (url.startsWith('https://api.betterttv.net/')) return jsonRes({})
      if (url.startsWith('https://api.frankerfacez.com/')) return jsonRes({})
      throw new Error('unexpected fetch URL: ' + url)
    }

    const emotes = await E.loadChannelEmotes('somenick')
    const map = E.buildEmoteMap(emotes)
    expect(map.has('erm')).toBe(true)
    expect(map.has('caterm')).toBe(false)
    expect(map.get('erm')?.id).toBe('abc')
  })
})

describe('7TV PERSONAL/LISTED state', () => {
  it('survives into the channel map (PERSONAL is an eligibility flag, not a filter)', async () => {
    // Real responses carry state: ["PERSONAL", "LISTED"] on ordinary public
    // listed emotes; the old isPublicSevenTv filter dropped these. Verify
    // such an entry now lands in the map.
    tauriInvoke.handler = async (cmd: string) => {
      if (cmd === 'gql_fetch') {
        return JSON.stringify({ data: { users: [{ id: '12345', login: 'somenick' }] } })
      }
      throw new Error('unexpected invoke: ' + cmd)
    }
    fetchImpl = async (url) => {
      if (url.startsWith('https://7tv.io/v3/users/twitch/')) {
        return jsonRes({
          emote_set: {
            id: 'set1',
            emotes: [
              {
                id: 'xyz',
                name: 'CatKitty',
                data: { id: 'xyz', name: 'CatKitty', state: ['PERSONAL', 'LISTED'], listed: true },
              },
            ],
          },
        })
      }
      if (url.startsWith('https://api.betterttv.net/')) return jsonRes({})
      if (url.startsWith('https://api.frankerfacez.com/')) return jsonRes({})
      throw new Error('unexpected fetch URL: ' + url)
    }

    const emotes = await E.loadChannelEmotes('somenick')
    const map = E.buildEmoteMap(emotes)
    expect(map.has('catkitty')).toBe(true)
    expect(map.get('catkitty')?.id).toBe('xyz')
  })
})

describe('FFZ global default_sets', () => {
  it('honors default_sets and ignores non-default sets', async () => {
    // The /v1/set/global response is { default_sets, sets }; only the sets
    // listed in default_sets are the global ones. Sets may also contain
    // other (e.g. featured) collections that must not be flattened in.
    fetchImpl = async (url) => {
      if (url === 'https://api.frankerfacez.com/v1/set/global') {
        return jsonRes({
          default_sets: [1],
          sets: {
            '1': { emoticons: [{ id: 10, name: 'GlobalOne' }] },
            '2': { emoticons: [{ id: 20, name: 'NonDefault' }] },
          },
        })
      }
      // 7TV / BTTV global endpoints — let their fetchers' try/catch swallow.
      throw new Error('unexpected fetch URL: ' + url)
    }

    const emotes = await E.loadGlobalEmotes()
    const map = E.buildEmoteMap(emotes)
    expect(map.has('globalone')).toBe(true)
    expect(map.has('nondefault')).toBe(false)
  })
})

describe('renderMessage — trailing punctuation', () => {
  it('renders "omE!" as an emote followed by "!" text (punctuation not absorbed)', () => {
    const map = E.buildEmoteMap([
      { id: 'ome', name: 'omE', url: 'https://example/ome.webp', provider: '7tv' },
    ])
    const parts = E.renderMessage({ message: 'omE!', thirdParty: map })

    expect(parts).toHaveLength(2)
    expect(parts[0].type).toBe('emote')
    if (parts[0].type === 'emote') expect(parts[0].name).toBe('omE')
    expect(parts[1].type).toBe('text')
    if (parts[1].type === 'text') expect(parts[1].text).toBe('!')
  })
})

describe('emoteOnly predicate (mirrors App.svelte handleMessage)', () => {
  // The predicate is inline in App.svelte's handleMessage and not exported,
  // so the test reconstructs the same expression over the parts produced by
  // renderMessage to verify its behavior.
  function isEmoteOnly(parts: RenderedMessagePart[]): boolean {
    return (
      parts.some((p) => p.type === 'emote') &&
      parts.every((p) => p.type === 'emote' || p.text.trim() === '')
    )
  }

  it('is true for a single-emote message', () => {
    const map = E.buildEmoteMap([
      { id: 'kappa', name: 'Kappa', url: 'u', provider: 'twitch' },
    ])
    const parts = E.renderMessage({ message: 'Kappa', thirdParty: map })
    expect(isEmoteOnly(parts)).toBe(true)
  })

  it('is true for two emotes separated by spaces', () => {
    const map = E.buildEmoteMap([
      { id: 'kappa', name: 'Kappa', url: 'u', provider: 'twitch' },
      { id: 'pog', name: 'Pog', url: 'u', provider: 'twitch' },
    ])
    const parts = E.renderMessage({ message: 'Kappa Pog', thirdParty: map })
    expect(isEmoteOnly(parts)).toBe(true)
  })

  it('is false for "hi Kappa" (has non-emote text)', () => {
    const map = E.buildEmoteMap([
      { id: 'kappa', name: 'Kappa', url: 'u', provider: 'twitch' },
    ])
    const parts = E.renderMessage({ message: 'hi Kappa', thirdParty: map })
    expect(isEmoteOnly(parts)).toBe(false)
  })

  it('is false for a message with no emotes', () => {
    const map = E.buildEmoteMap([])
    const parts = E.renderMessage({ message: 'hello world', thirdParty: map })
    expect(isEmoteOnly(parts)).toBe(false)
  })
})
