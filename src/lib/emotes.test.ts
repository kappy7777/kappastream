import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

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
  invoke: (cmd: string, args: Record<string, unknown>): Promise<unknown> => tauriInvoke.handler(cmd, args),
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
      // getTwitchUserId resolves via the batched GQL command. Return a valid
      // single-user response so resolveUserIds maps 'somenick' -> '12345'.
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
            emotes: [{ id: 'abc', name: 'erm', data: { id: 'abc', name: 'catErm', state: [], listed: true } }],
          },
        })
      }
      // BTTV / FFZ channel endpoints — empty payloads collapse to [].
      if (url.startsWith('https://api.betterttv.net/')) return jsonRes({})
      if (url.startsWith('https://api.frankerfacez.com/')) return jsonRes({})
      throw new Error('unexpected fetch URL: ' + url)
    }

    const res = await E.loadChannelEmotes('somenick')
    const map = E.buildEmoteMap(res.emotes)
    expect(map.has('erm')).toBe(true)
    // The emote's own data.name must NOT be the key — asserted at its exact
    // case, where a lowercase-folding or data.name-keyed map would hit it.
    expect(map.has('catErm')).toBe(false)
    expect(map.get('erm')?.id).toBe('abc')
  })
})

describe('getTwitchUserId case-insensitivity', () => {
  it('resolves a mixed-case channel name against Twitch lowercase logins', async () => {
    // Twitch returns `login` lowercase; the lookup must lowercase to match, or
    // a mixed-case channel name (from search/browse/ChannelContent) silently
    // drops that channel's third-party emotes.
    tauriInvoke.handler = async (cmd: string) => {
      if (cmd === 'gql_fetch') {
        return JSON.stringify({ data: { users: [{ id: '12345', login: 'chan2' }] } })
      }
      throw new Error('unexpected invoke: ' + cmd)
    }
    const id = await E.getTwitchUserId('Chan2')
    expect(id).toBe('12345')
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

    const res = await E.loadChannelEmotes('somenick')
    const map = E.buildEmoteMap(res.emotes)
    expect(map.has('CatKitty')).toBe(true)
    expect(map.get('CatKitty')?.id).toBe('xyz')
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

    const res = await E.loadGlobalEmotes()
    const map = E.buildEmoteMap(res.emotes)
    expect(map.has('GlobalOne')).toBe(true)
    expect(map.has('NonDefault')).toBe(false)
  })
})

describe('renderMessage — exact-case emote codes', () => {
  // Provider codes (7TV/BTTV/FFZ) match case-sensitively: "ez" is NOT the
  // emote registered as "EZ", and a code carrying edge punctuation or
  // non-ASCII can only match as the whole word.
  it('"ez ok lul" with EZ/OK/LuL registered renders NO emotes', () => {
    const map = E.buildEmoteMap([
      { id: 'ez', name: 'EZ', url: 'u', provider: '7tv' },
      { id: 'ok', name: 'OK', url: 'u', provider: '7tv' },
      { id: 'lul', name: 'LuL', url: 'u', provider: 'bttv' },
    ])
    const parts = E.renderMessage({ message: 'ez game ok lul', thirdParty: map })
    expect(parts).toHaveLength(1)
    expect(parts[0]).toEqual({ type: 'text', text: 'ez game ok lul' })
  })

  it('a punctuation-bearing code matches as the whole word ("D:")', () => {
    const map = E.buildEmoteMap([{ id: 'd', name: 'D:', url: 'u', provider: 'bttv' }])
    const parts = E.renderMessage({ message: 'oh D: no', thirdParty: map })
    const emotes = parts.filter((p) => p.type === 'emote')
    expect(emotes).toHaveLength(1)
    if (emotes[0]!.type === 'emote') expect(emotes[0]!.name).toBe('D:')
  })

  it('"EZ!" renders the EZ emote plus "!" as text', () => {
    const map = E.buildEmoteMap([{ id: 'ez', name: 'EZ', url: 'u', provider: '7tv' }])
    const parts = E.renderMessage({ message: 'EZ!', thirdParty: map })
    expect(parts).toHaveLength(2)
    expect(parts[0].type).toBe('emote')
    if (parts[0].type === 'emote') expect(parts[0].name).toBe('EZ')
    expect(parts[1].type).toBe('text')
    if (parts[1].type === 'text') expect(parts[1].text).toBe('!')
  })

  it('Pog and POG stay distinct emotes (no case-collapsed dedupe)', () => {
    const map = E.buildEmoteMap([
      { id: 'pog1', name: 'Pog', url: 'u', provider: '7tv' },
      { id: 'pog2', name: 'POG', url: 'u', provider: 'ffz' },
    ])
    expect(map.has('Pog')).toBe(true)
    expect(map.has('POG')).toBe(true)
    const parts = E.renderMessage({ message: 'Pog POG', thirdParty: map })
    const emotes = parts.filter((p) => p.type === 'emote')
    expect(emotes).toHaveLength(2)
    if (emotes[0]!.type === 'emote') expect(emotes[0]!.name).toBe('Pog')
    if (emotes[1]!.type === 'emote') expect(emotes[1]!.name).toBe('POG')
  })
})

describe('transient provider failures are not cached', () => {
  it('a failed provider is refetched on the next load (nothing cached)', async () => {
    tauriInvoke.handler = async (cmd: string) => {
      if (cmd === 'gql_fetch') {
        return JSON.stringify({ data: { users: [{ id: '12345', login: 'somenick' }] } })
      }
      throw new Error('unexpected invoke: ' + cmd)
    }
    let seventvFails = true
    fetchImpl = async (url) => {
      if (url.startsWith('https://7tv.io/v3/users/twitch/')) {
        if (seventvFails) throw new Error('network down')
        return jsonRes({ emote_set: { id: 'set1', emotes: [{ id: 'abc', name: 'erm' }] } })
      }
      if (url.startsWith('https://api.betterttv.net/')) return jsonRes({})
      if (url.startsWith('https://api.frankerfacez.com/')) return jsonRes({})
      throw new Error('unexpected fetch URL: ' + url)
    }

    const first = await E.loadChannelEmotes('somenick')
    expect(first.emotes).toEqual([]) // the failed provider contributed nothing
    expect(first.allFailed).toBe(false) // BTTV/FFZ answered (empty)

    // The blip heals: the second call refetches 7TV (previously the failed
    // [] was cached for the whole process).
    seventvFails = false
    const second = await E.loadChannelEmotes('somenick')
    expect(second.emotes.map((e) => e.name)).toEqual(['erm'])
  })

  it('a 404 is a definitive "no emotes" and IS cached', async () => {
    tauriInvoke.handler = async (cmd: string) => {
      if (cmd === 'gql_fetch') {
        return JSON.stringify({ data: { users: [{ id: '12345', login: 'somenick' }] } })
      }
      throw new Error('unexpected invoke: ' + cmd)
    }
    let hits = 0
    fetchImpl = async (url) => {
      if (url.startsWith('https://7tv.io/v3/users/twitch/')) {
        hits++
        return { ok: false, status: 404, json: async () => ({}) }
      }
      if (url.startsWith('https://api.betterttv.net/')) return jsonRes({})
      if (url.startsWith('https://api.frankerfacez.com/')) return jsonRes({})
      throw new Error('unexpected fetch URL: ' + url)
    }

    const first = await E.loadChannelEmotes('somenick')
    expect(first.allFailed).toBe(false)
    const second = await E.loadChannelEmotes('somenick')
    expect(hits).toBe(1) // cached — no refetch
    expect(second.emotes).toEqual([])
  })

  it('all providers failing marks the result allFailed', async () => {
    fetchImpl = async () => {
      throw new Error('network down')
    }
    const res = await E.loadGlobalEmotes()
    expect(res.emotes).toEqual([])
    expect(res.allFailed).toBe(true)
  })

  it('channel-side provider failures count as failed and refetch', async () => {
    tauriInvoke.handler = async (cmd: string) => {
      if (cmd === 'gql_fetch') {
        return JSON.stringify({ data: { users: [{ id: '12345', login: 'chan3' }] } })
      }
      throw new Error('unexpected invoke: ' + cmd)
    }
    // Every channel provider request throws. BTTV/FFZ used to turn a thrown
    // fetch into a [] SUCCESS, so the outage never reported allFailed and
    // the [] was cached — the channel silently kept no third-party emotes
    // until restart.
    let providerCalls = 0
    fetchImpl = async () => {
      providerCalls++
      throw new Error('network down')
    }
    const first = await E.loadChannelEmotes('chan3')
    expect(first.emotes).toEqual([])
    expect(first.allFailed).toBe(true)

    const second = await E.loadChannelEmotes('chan3')
    expect(second.allFailed).toBe(true)
    expect(providerCalls).toBe(6) // 3 providers x 2 loads — nothing cached
  })

  it('a provider that stalls after headers does not hang the emote load', async () => {
    vi.useFakeTimers()
    try {
      tauriInvoke.handler = async (cmd: string) => {
        if (cmd === 'gql_fetch') {
          return JSON.stringify({ data: { users: [{ id: '12345', login: 'chan5' }] } })
        }
        throw new Error('unexpected invoke: ' + cmd)
      }
      fetchImpl = async (_url, opts) => ({
        ok: true,
        // Headers arrive; the body never does. The request's own signal is
        // the only thing that can end this read — the timeout must still be
        // armed when the parse starts (it used to be cleared the moment the
        // headers resolved, leaving json() unbounded).
        json: () =>
          new Promise((_resolve, reject) => {
            opts?.signal?.addEventListener('abort', () => reject(new Error('aborted')))
          }),
      })
      const pending = E.loadChannelEmotes('chan5')
      await vi.advanceTimersByTimeAsync(9_000) // past the 8 s fetch timeout
      const res = await pending
      expect(res.emotes).toEqual([])
      expect(res.allFailed).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('global emote caching', () => {
  it('a fully successful global load is cached for the process', async () => {
    let hits = 0
    fetchImpl = async (url) => {
      hits++
      if (url === 'https://7tv.io/v3/emote-sets/global') return jsonRes({ emotes: [] })
      if (url === 'https://api.betterttv.net/3/cached/emotes/global') return jsonRes([])
      if (url === 'https://api.frankerfacez.com/v1/set/global') {
        return jsonRes({ default_sets: [1], sets: { '1': { emoticons: [{ id: 10, name: 'GlobalOne' }] } } })
      }
      throw new Error('unexpected fetch URL: ' + url)
    }

    const first = await E.loadGlobalEmotes()
    expect(first.allFailed).toBe(false)
    const second = await E.loadGlobalEmotes()
    expect(second.emotes.map((e) => e.name)).toEqual(['GlobalOne'])
    expect(second.allFailed).toBe(false)
    expect(hits).toBe(3) // one provider round; the second load hit the cache
  })

  it('an all-providers outage is not cached — the next load refetches', async () => {
    let down = true
    fetchImpl = async (url) => {
      if (down) throw new Error('network down')
      if (url === 'https://7tv.io/v3/emote-sets/global') return jsonRes({ emotes: [] })
      if (url === 'https://api.betterttv.net/3/cached/emotes/global') return jsonRes([])
      if (url === 'https://api.frankerfacez.com/v1/set/global') {
        return jsonRes({ default_sets: [1], sets: { '1': { emoticons: [{ id: 10, name: 'GlobalOne' }] } } })
      }
      throw new Error('unexpected fetch URL: ' + url)
    }

    const first = await E.loadGlobalEmotes()
    expect(first.emotes).toEqual([])
    expect(first.allFailed).toBe(true)

    down = false
    const second = await E.loadGlobalEmotes()
    expect(second.allFailed).toBe(false)
    expect(second.emotes.map((e) => e.name)).toEqual(['GlobalOne'])
  })

  it('a partial outage is not cached — the next load refetches every provider', async () => {
    let bttvDown = true
    let ffzHits = 0
    fetchImpl = async (url) => {
      if (url === 'https://api.betterttv.net/3/cached/emotes/global') {
        if (bttvDown) throw new Error('network down')
        return jsonRes([])
      }
      if (url === 'https://7tv.io/v3/emote-sets/global') return jsonRes({ emotes: [] })
      if (url === 'https://api.frankerfacez.com/v1/set/global') {
        ffzHits++
        return jsonRes({ default_sets: [1], sets: { '1': { emoticons: [{ id: 10, name: 'GlobalOne' }] } } })
      }
      throw new Error('unexpected fetch URL: ' + url)
    }

    const first = await E.loadGlobalEmotes()
    expect(first.allFailed).toBe(false) // 7TV/FFZ answered
    expect(first.emotes.map((e) => e.name)).toEqual(['GlobalOne'])

    bttvDown = false
    const second = await E.loadGlobalEmotes()
    expect(second.emotes.map((e) => e.name)).toEqual(['GlobalOne'])
    expect(ffzHits).toBe(2) // the partial first round cached nothing
  })
})

describe('ChatSession emoteStatus', () => {
  it("is 'error' only when every provider request fails", async () => {
    const { ChatSession } = await import('./chat-session.svelte')
    tauriInvoke.handler = async (cmd: string) => {
      if (cmd === 'gql_fetch') throw new Error('gql down')
      throw new Error('unexpected invoke: ' + cmd)
    }
    // Every third-party endpoint (and the GQL id lookup) fails: 7TV/BTTV/FFZ,
    // channel and global — the unreachable-internet case.
    fetchImpl = async () => {
      throw new Error('network down')
    }
    const s = new ChatSession('chan4')
    s.start()
    await new Promise((r) => setTimeout(r, 20))
    expect(s.emoteStatus).toBe('error')
    s.dispose()
  })

  it("is 'error' when Twitch's GQL answers but every provider is down", async () => {
    // The id lookup SUCCEEDING is the case that actually calls the channel
    // providers; with the lookup itself failing (the test above) they are
    // never reached, so a provider-side-only outage went untested. The
    // channel-side null-userId rule counts the lookup failure as failed too,
    // so both paths must land on 'error'.
    const { ChatSession } = await import('./chat-session.svelte')
    tauriInvoke.handler = async (cmd: string) => {
      if (cmd === 'gql_fetch') {
        return JSON.stringify({ data: { users: [{ id: '12345', login: 'chan4' }] } })
      }
      throw new Error('unexpected invoke: ' + cmd)
    }
    fetchImpl = async () => {
      throw new Error('network down')
    }
    const s = new ChatSession('chan4')
    s.start()
    await new Promise((r) => setTimeout(r, 20))
    expect(s.emoteStatus).toBe('error')
    s.dispose()
  })

  it("is 'ready' when a provider answers even if others fail", async () => {
    const { ChatSession } = await import('./chat-session.svelte')
    tauriInvoke.handler = async (cmd: string) => {
      if (cmd === 'gql_fetch') {
        return JSON.stringify({ data: { users: [{ id: '12345', login: 'chan4' }] } })
      }
      throw new Error('unexpected invoke: ' + cmd)
    }
    fetchImpl = async (url) => {
      if (url.startsWith('https://7tv.io/v3/users/twitch/')) {
        return jsonRes({ emote_set: { id: 'set1', emotes: [{ id: 'abc', name: 'erm' }] } })
      }
      throw new Error('network down') // BTTV/FFZ + all globals fail
    }
    const s = new ChatSession('chan4')
    s.start()
    await new Promise((r) => setTimeout(r, 20))
    expect(s.emoteStatus).toBe('ready')
    s.dispose()
  })
})

describe('renderMessage — trailing punctuation', () => {
  it('renders "omE!" as an emote followed by "!" text (punctuation not absorbed)', () => {
    const map = E.buildEmoteMap([{ id: 'ome', name: 'omE', url: 'https://example/ome.webp', provider: '7tv' }])
    const parts = E.renderMessage({ message: 'omE!', thirdParty: map })

    expect(parts).toHaveLength(2)
    expect(parts[0].type).toBe('emote')
    if (parts[0].type === 'emote') expect(parts[0].name).toBe('omE')
    expect(parts[1].type).toBe('text')
    if (parts[1].type === 'text') expect(parts[1].text).toBe('!')
  })
})

describe('parseTwitchEmoteTag — code-point → UTF-16 conversion', () => {
  it('an emoji before an emote shifts the tag range into UTF-16 units', () => {
    // '😀 Kappa hi': the emoji is 1 code point but 2 UTF-16 units, so the
    // tag's code-point range 2-6 must land on units 3-7.
    const ranges = E.parseTwitchEmoteTag('25:2-6', '😀 Kappa hi')
    expect(ranges).toEqual([{ start: 3, end: 7, id: '25' }])
    const parts = E.renderMessage({ message: '😀 Kappa hi', thirdParty: new Map(), twitchRanges: ranges })
    expect(parts).toHaveLength(3)
    expect(parts[0]).toEqual({ type: 'text', text: '😀 ' })
    expect(parts[1].type).toBe('emote')
    if (parts[1].type === 'emote') expect(parts[1].name).toBe('Kappa')
    expect(parts[2]).toEqual({ type: 'text', text: ' hi' })
  })

  it('an emoji between two emotes shifts only the later one', () => {
    // 'Kappa 😀 Pog': Kappa at code points 0-4, Pog at 8-10 (past the
    // 2-unit emoji) → UTF-16 units 9-11. Distinct emote ids are '/'-separated
    // in the tag (',' separates ranges of the SAME emote).
    const ranges = E.parseTwitchEmoteTag('25:0-4/305954156:8-10', 'Kappa 😀 Pog')
    expect(ranges).toEqual([
      { start: 0, end: 4, id: '25' },
      { start: 9, end: 11, id: '305954156' },
    ])
    const parts = E.renderMessage({ message: 'Kappa 😀 Pog', thirdParty: new Map(), twitchRanges: ranges })
    expect(parts.filter((p) => p.type === 'emote').map((p) => (p as { name: string }).name)).toEqual(['Kappa', 'Pog'])
  })

  it('keeps ASCII-only messages byte-identical (identity conversion)', () => {
    expect(E.parseTwitchEmoteTag('25:0-4', 'Kappa')).toEqual([{ start: 0, end: 4, id: '25' }])
  })

  it('drops ranges that fall outside the message or are inverted', () => {
    expect(E.parseTwitchEmoteTag('25:5-9', 'Kappa')).toEqual([])
    expect(E.parseTwitchEmoteTag('25:4-2', 'Kappa')).toEqual([])
    expect(E.parseTwitchEmoteTag('25:0-4', 'Kappa 😀')).toEqual([{ start: 0, end: 4, id: '25' }])
  })
})

describe('renderMessage — overlapping ranges', () => {
  it('a Twitch emote and a same-name third-party emote render exactly once (Twitch wins)', () => {
    // Both a tag range 25:0-4 and a 7TV emote named Kappa produce a range
    // over 0-4; before the overlap skip, both were rendered as stacked emote
    // parts.
    const map = E.buildEmoteMap([{ id: '7tvkappa', name: 'Kappa', url: 'u', provider: '7tv' }])
    const ranges = E.parseTwitchEmoteTag('25:0-4', 'Kappa')
    const parts = E.renderMessage({ message: 'Kappa', thirdParty: map, twitchRanges: ranges })

    expect(parts).toHaveLength(1)
    expect(parts[0].type).toBe('emote')
    if (parts[0].type === 'emote') {
      expect(parts[0].name).toBe('Kappa')
      expect(parts[0].provider).toBe('twitch')
    }
  })

  it('a third-party range inside an already-rendered Twitch range is skipped', () => {
    // Twitch range spans the whole word pair; the 7TV Kappa range (2-6) sits
    // inside it and must not split the Twitch emote into stacked parts.
    const map = E.buildEmoteMap([{ id: '7tvkappa', name: 'Kappa', url: 'u', provider: '7tv' }])
    const parts = E.renderMessage({
      message: 'a Kappa b',
      thirdParty: map,
      twitchRanges: [{ start: 0, end: 9, id: '25' }],
    })

    expect(parts).toHaveLength(1)
    expect(parts[0].type).toBe('emote')
    if (parts[0].type === 'emote') {
      expect(parts[0].name).toBe('a Kappa b')
      expect(parts[0].provider).toBe('twitch')
    }
  })
})

describe('isEmoteOnly (the exported predicate every ChatMessage producer uses)', () => {
  it('is true for a single-emote message', () => {
    const map = E.buildEmoteMap([{ id: 'kappa', name: 'Kappa', url: 'u', provider: 'twitch' }])
    const parts = E.renderMessage({ message: 'Kappa', thirdParty: map })
    expect(E.isEmoteOnly(parts)).toBe(true)
  })

  it('is true for two emotes separated by spaces', () => {
    const map = E.buildEmoteMap([
      { id: 'kappa', name: 'Kappa', url: 'u', provider: 'twitch' },
      { id: 'pog', name: 'Pog', url: 'u', provider: 'twitch' },
    ])
    const parts = E.renderMessage({ message: 'Kappa Pog', thirdParty: map })
    expect(E.isEmoteOnly(parts)).toBe(true)
  })

  it('is false for "hi Kappa" (has non-emote text)', () => {
    const map = E.buildEmoteMap([{ id: 'kappa', name: 'Kappa', url: 'u', provider: 'twitch' }])
    const parts = E.renderMessage({ message: 'hi Kappa', thirdParty: map })
    expect(E.isEmoteOnly(parts)).toBe(false)
  })

  it('is false for a message with no emotes', () => {
    const map = E.buildEmoteMap([])
    const parts = E.renderMessage({ message: 'hello world', thirdParty: map })
    expect(E.isEmoteOnly(parts)).toBe(false)
  })
})
