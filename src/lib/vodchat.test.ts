import { describe, it, expect, beforeEach, vi } from 'vitest'
import { VodChatController } from './vodchat.svelte'
import { defaultNameColor } from './name-color'

/*
 * Unit tests for VOD chat replay (src/lib/vodchat.svelte.ts).
 *
 * The sync engine is transport-agnostic and takes an injectable `fetchPage`,
 * so the advance-rule / dedupe / seek / guard behaviors are tested with a
 * scripted in-memory fetcher (no network, no Tauri) plus fake timers. The
 * normalize layer + the real GQL fetcher (fetchVodComments) are tested by
 * mocking the `gql_fetch` Tauri command, mirroring favorites.test.ts.
 *
 * Central behaviors under test:
 *  - advance rule is gap-free (maxOff+1) and dedupes overlapping windows;
 *  - seek discards the buffer and refetches; rapid seeks collapse to one fetch;
 *  - no fetch while paused or chat hidden;
 *  - a fetch failure degrades to no chat without throwing / breaking;
 *  - an empty page is success (EOF), not an error;
 *  - fragment -> ParsedMessage conversion incl. emote ranges.
 */

// --- shared stream model -----------------------------------------------------
// A deterministic virtual comment stream with varying density (1..3 per
// second). pageAt(O) mimics the real endpoint: a window of COUNT comments
// starting LOOKBACK seconds before O (so consecutive pages OVERLAP), with
// maxOffset = the last comment's offset and the page bracketing O. This is the
// shape the live endpoint serves, so it exercises dedupe + the advance rule for real.

interface StreamMsg {
  id: string
}

function buildStream(maxOffset: number): { offset: number; id: string }[] {
  const out: { offset: number; id: string }[] = []
  let n = 0
  for (let o = 0; o <= maxOffset; o++) {
    const per = 1 + (o % 3) // 1..3 comments/sec
    for (let k = 0; k < per; k++) out.push({ offset: o, id: `c${n++}` })
  }
  return out
}

function makeStreamFetcher(
  stream: { offset: number; id: string }[],
  opts: { lookback?: number; count?: number; rejectOnce?: boolean } = {},
) {
  const { lookback = 3, count = 10, rejectOnce = false } = opts
  const calls: number[] = []
  let didReject = false
  const fetchPage = async (
    _videoId: string,
    offset: number,
    signal: AbortSignal,
  ): Promise<{ comments: { offset: number; id: string; msg: StreamMsg }[]; maxOffset: number }> => {
    if (signal.aborted) throw new Error('aborted')
    calls.push(offset)
    if (rejectOnce && !didReject) {
      didReject = true
      throw new Error('IntegrityCheckFailed')
    }
    const start = stream.findIndex((c) => c.offset >= offset - lookback)
    if (start < 0) return { comments: [], maxOffset: offset }
    const slice = stream.slice(start, start + count)
    if (slice.length === 0) return { comments: [], maxOffset: offset }
    return {
      comments: slice.map((c) => ({ offset: c.offset, id: c.id, msg: { id: c.id } })),
      maxOffset: slice[slice.length - 1].offset,
    }
  }
  return { fetchPage, calls }
}

// Flush the controller's async fetch chain + 250ms tick loop. Each iteration
// advances one tick and lets pending microtasks (the chained fetchNext) settle.
async function settle(steps: number): Promise<void> {
  for (let i = 0; i < steps; i++) await vi.advanceTimersByTimeAsync(250)
}

// =============================================================================
// Sync engine (VodChatController)
// =============================================================================
describe('VodChatController', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  it('advance rule (maxOff+1) is gap-free and dedupes overlapping windows', async () => {
    const stream = buildStream(50)
    const { fetchPage, calls } = makeStreamFetcher(stream)
    let playhead = 0
    const c = new VodChatController<StreamMsg>({
      fetchPage,
      getPlayhead: () => playhead,
      getPaused: () => false,
      getChatVisible: () => true,
    })
    c.start('v1', 0)
    await settle(60)
    playhead = 60 // past the whole stream -> everything drains
    await settle(10)

    const ids = c.visible.map((m) => m.id)
    // No gaps: the drained set equals the whole stream in order.
    expect(ids).toEqual(stream.map((s) => s.id))
    // No duplicates despite overlapping windows.
    expect(new Set(ids).size).toBe(ids.length)
    // The advance rule actually fired more than once (it walked the stream).
    expect(calls.length).toBeGreaterThan(5)
    expect(c.failed).toBe(false)
    c.stop()
  })

  it('caps the drained list at 500 while the pane follows the bottom', async () => {
    // 1 comment/sec so the offsets map 1:1 to ids (c<i> drains at second i).
    const stream = Array.from({ length: 2501 }, (_, i) => ({ offset: i, id: `c${i}` }))
    const { fetchPage } = makeStreamFetcher(stream, { count: 300 })
    let playhead = 0
    const c = new VodChatController<StreamMsg>({
      fetchPage,
      getPlayhead: () => playhead,
      getPaused: () => false,
      getChatVisible: () => true,
    })
    c.start('v1', 0)
    // Walk the playhead like real playback (steps stay inside the 60s ahead
    // margin so the engine never has to resync), until the whole stream has
    // drained.
    for (let t = 0; t <= 2500; t += 50) {
      playhead = t
      await settle(1)
    }
    expect(c.visible.length).toBe(500)
    expect(c.visible[0]!.id).toBe('c2001') // oldest trimmed, newest kept
    expect(c.visible[c.visible.length - 1]!.id).toBe('c2500')
    c.stop()
  })

  it('holds the visible trim while the pane is scrolled up, trims back on release', async () => {
    // Same walk as above, but the pane reports a scroll-up hold first: a
    // front trim would slide the text being read (no scroll anchoring on the
    // WebKit engines), so the cap rises to the held ceiling instead.
    const stream = Array.from({ length: 2501 }, (_, i) => ({ offset: i, id: `c${i}` }))
    const { fetchPage } = makeStreamFetcher(stream, { count: 300 })
    let playhead = 0
    const c = new VodChatController<StreamMsg>({
      fetchPage,
      getPlayhead: () => playhead,
      getPaused: () => false,
      getChatVisible: () => true,
    })
    c.start('v1', 0)
    c.setHoldTrim(true) // the pane reports: user scrolled up
    for (let t = 0; t <= 2500; t += 50) {
      playhead = t
      await settle(1)
    }
    expect(c.visible.length).toBe(2000) // held ceiling, not 500
    expect(c.visible[0]!.id).toBe('c501')
    expect(c.visible[c.visible.length - 1]!.id).toBe('c2500')

    c.setHoldTrim(false) // back to the bottom
    expect(c.visible.length).toBe(500)
    expect(c.visible[0]!.id).toBe('c2001')
    c.stop()
  })

  it('respects the bounded-ahead margin (does not fetch the whole VOD up front)', async () => {
    const stream = buildStream(500)
    const { fetchPage, calls } = makeStreamFetcher(stream)
    const playhead = 0
    const c = new VodChatController<StreamMsg>({
      fetchPage,
      getPlayhead: () => playhead,
      getPaused: () => false,
      getChatVisible: () => true,
    })
    c.start('v1', 0)
    await settle(20)
    // With playhead frozen at 0, fetching stops once ~60s is buffered ahead.
    // The controller should NOT have walked hundreds of seconds; a handful of
    // requests suffice to fill the 60s margin.
    expect(calls.length).toBeGreaterThan(0)
    expect(calls.length).toBeLessThan(30)
    c.stop()
  })

  it('seek discards the buffer and refetches at the new offset', async () => {
    const stream = buildStream(200)
    const { fetchPage, calls } = makeStreamFetcher(stream)
    let playhead = 0
    const c = new VodChatController<StreamMsg>({
      fetchPage,
      getPlayhead: () => playhead,
      getPaused: () => false,
      getChatVisible: () => true,
    })
    c.start('v1', 0)
    await settle(20)
    const before = c.visible.map((m) => m.id)
    expect(before.length).toBeGreaterThan(0)

    // Scrub forward an hour; the early comments must be gone, replaced by the
    // 3600s region. (Stream only goes to 200, so seek mid-stream.)
    c.seek(150)
    playhead = 150
    await settle(20)

    const after = c.visible.map((m) => m.id)
    expect(after.length).toBeGreaterThan(0)
    // No early-region comment survives the seek.
    expect(after.some((id) => before.includes(id))).toBe(false)
    // A fetch at the sought offset happened.
    expect(calls.includes(150)).toBe(true)
    c.stop()
  })

  it('rapid seeks collapse into a single refetch (debounce)', async () => {
    const stream = buildStream(200)
    const { fetchPage, calls } = makeStreamFetcher(stream)
    const c = new VodChatController<StreamMsg>({
      fetchPage,
      getPlayhead: () => 120,
      getPaused: () => false,
      getChatVisible: () => true,
    })
    c.start('v1', 0)
    await settle(10)
    const callsBeforeScrub = calls.length

    // Hammer the bar: 30 seeks within the debounce window. The playhead
    // reads the final target (as it does on both engines once the seek
    // lands), and the debounce re-reads it live.
    for (let i = 0; i < 30; i++) c.seek(120)
    await settle(10)

    // Exactly one refetch landed at the final target offset.
    const scrubFetches = calls.slice(callsBeforeScrub)
    const at120 = scrubFetches.filter((o: number) => o === 120).length
    expect(at120).toBe(1)
    c.stop()
  })

  it('a backward seek with a stale argument resyncs at the real playhead', async () => {
    // Native-engine shape: `seeking` fires BEFORE the playhead reports the
    // new position, so the seek() argument is the OLD offset. The debounce
    // must re-read the live playhead and resync THERE — a frozen target
    // left chat refetched at the pre-seek offset and empty (nothing drains
    // at an offset ahead of the real playhead) until playback crossed back.
    const stream = buildStream(200)
    const { fetchPage, calls } = makeStreamFetcher(stream)
    let playhead = 150
    const c = new VodChatController<StreamMsg>({
      fetchPage,
      getPlayhead: () => playhead,
      getPaused: () => false,
      getChatVisible: () => true,
    })
    c.start('v1', 150)
    await settle(10)
    const callsBefore = calls.length

    // Scrub back to 40 s: the argument arrives stale (150), the playhead
    // itself has moved to 40 by the time the debounce fires.
    c.seek(150)
    playhead = 40
    await settle(10)

    const after = calls.slice(callsBefore)
    expect(after[0]).toBe(40)
    expect(after).not.toContain(150)
    expect(c.visible.length).toBeGreaterThan(0) // the 40 s region drains
    c.stop()
  })

  it('does not fetch while paused', async () => {
    const stream = buildStream(50)
    const { fetchPage, calls } = makeStreamFetcher(stream)
    const c = new VodChatController<StreamMsg>({
      fetchPage,
      getPlayhead: () => 10,
      getPaused: () => true,
      getChatVisible: () => true,
    })
    c.start('v1', 0)
    await settle(20)
    expect(calls.length).toBe(0)
    expect(c.visible.length).toBe(0)
    c.stop()
  })

  it('does not fetch while the chat panel is hidden', async () => {
    const stream = buildStream(50)
    const { fetchPage, calls } = makeStreamFetcher(stream)
    const c = new VodChatController<StreamMsg>({
      fetchPage,
      getPlayhead: () => 10,
      getPaused: () => false,
      getChatVisible: () => false,
    })
    c.start('v1', 0)
    await settle(20)
    expect(calls.length).toBe(0)
    c.stop()
  })

  it('a fetch failure degrades to no chat and retries once after backoff', async () => {
    const stream = buildStream(50)
    const { fetchPage, calls } = makeStreamFetcher(stream, { rejectOnce: true })
    const c = new VodChatController<StreamMsg>({
      fetchPage,
      getPlayhead: () => 10,
      getPaused: () => false,
      getChatVisible: () => true,
    })
    c.start('v1', 0)
    await settle(5)
    expect(c.failed).toBe(true)
    // It did not throw and playback state is unaffected.
    expect(() => c.visible).not.toThrow()
    const failedCalls = calls.length

    // After the backoff window, exactly one retry is scheduled.
    await vi.advanceTimersByTimeAsync(30_000)
    await settle(5)
    expect(c.failed).toBe(false)
    expect(calls.length).toBeGreaterThan(failedCalls) // retry happened
    c.stop()
  })

  it('exposes ended for an empty VOD (no comments at all)', async () => {
    const { fetchPage } = makeStreamFetcher([]) // every page is empty
    const c = new VodChatController<StreamMsg>({
      fetchPage,
      getPlayhead: () => 5,
      getPaused: () => false,
      getChatVisible: () => true,
    })
    c.start('v1', 0)
    await settle(3)
    expect(c.ended).toBe(true)
    expect(c.visible.length).toBe(0)
    expect(c.failed).toBe(false)
    c.stop()
    expect(c.ended).toBe(false) // stop clears it for the next VOD
  })

  it('exposes ended after seeking past the last comment', async () => {
    const stream = buildStream(20)
    const { fetchPage } = makeStreamFetcher(stream)
    let playhead = 0
    const c = new VodChatController<StreamMsg>({
      fetchPage,
      getPlayhead: () => playhead,
      getPaused: () => false,
      getChatVisible: () => true,
    })
    c.start('v1', 0)
    await settle(2)
    playhead = 500 // far past the end
    c.seek(500)
    await vi.advanceTimersByTimeAsync(600) // past the 500ms debounce
    await settle(2)
    expect(c.ended).toBe(true)
    expect(c.visible.length).toBe(0)
    c.stop()
  })

  it('the tick does not resync while a seek debounce is pending (no double fetch)', async () => {
    const stream = buildStream(3000)
    const { fetchPage, calls } = makeStreamFetcher(stream)
    let playhead = 0
    const c = new VodChatController<StreamMsg>({
      fetchPage,
      getPlayhead: () => playhead,
      getPaused: () => false,
      getChatVisible: () => true,
    })
    c.start('v1', 0)
    await settle(2)
    const before = calls.length
    playhead = 900 // far ahead of the buffered margin
    c.seek(900)
    // A tick lands INSIDE the 500ms debounce window: with the playhead now
    // past maxFetched, the old code resynced here AND again when the debounce
    // fired — two fetch bursts for one scrub. The debounce owns the resync.
    await vi.advanceTimersByTimeAsync(250)
    expect(calls.length - before).toBe(0)
    await vi.advanceTimersByTimeAsync(300) // debounce fires -> the one resync
    expect(calls.length - before).toBeGreaterThan(0)
    c.stop()
  })

  it('an empty result page is success (EOF), not an error', async () => {
    // Stream ends at 0; any fetch beyond returns empty -> EOF.
    const stream = buildStream(0)
    const { fetchPage } = makeStreamFetcher(stream)
    const c = new VodChatController<StreamMsg>({
      fetchPage,
      getPlayhead: () => 0,
      getPaused: () => false,
      getChatVisible: () => true,
    })
    c.start('v1', 5) // past the only comment
    await settle(20)
    expect(c.failed).toBe(false)
    expect(c.visible.length).toBe(0)
    c.stop()
  })

  it('keeps exactly one request in flight', async () => {
    let resolveFetch: (() => void) | null = null
    const calls: number[] = []
    const fetchPage = async (
      _v: string,
      offset: number,
      _s: AbortSignal,
    ): Promise<{ comments: { offset: number; id: string; msg: StreamMsg }[]; maxOffset: number }> => {
      calls.push(offset)
      await new Promise<void>((r) => {
        resolveFetch = r
      })
      return { comments: [{ offset, id: `c${offset}`, msg: { id: `c${offset}` } }], maxOffset: offset + 10 }
    }
    const c = new VodChatController<StreamMsg>({
      fetchPage,
      getPlayhead: () => 0,
      getPaused: () => false,
      getChatVisible: () => true,
    })
    c.start('v1', 0)
    await settle(30) // many ticks elapse while the first fetch is pending
    expect(calls.length).toBe(1) // no second request while one is in flight
    resolveFetch!()
    await settle(5)
    expect(calls.length).toBeGreaterThan(1) // chained after resolve
    c.stop()
  })
})

// =============================================================================
// Normalize layer + GQL fetcher (fetchVodComments)
// =============================================================================
const gql = vi.hoisted(() => ({
  handler: async (_body: string): Promise<string> => {
    throw new Error('gql handler not configured')
  },
}))

vi.mock('@tauri-apps/api/core', () => ({
  invoke: (cmd: string, args: Record<string, unknown>): Promise<unknown> => {
    if (cmd === 'gql_fetch') return Promise.resolve(gql.handler(String(args.body ?? '')))
    return Promise.reject(new Error('unexpected invoke: ' + cmd))
  },
  isTauri: () => false,
}))

describe('normalizeVodComment', () => {
  it('converts fragments to flat text + inclusive emote ranges', async () => {
    const { normalizeVodComment } = await import('./vodchat.svelte')
    const node = {
      id: 'comment-1',
      contentOffsetSeconds: 42,
      createdAt: '2020-01-01T12:00:48.123Z',
      commenter: { id: 'uid', login: 'user', displayName: 'User' },
      message: {
        userColor: '#FF0000',
        userBadges: [{ setID: 'subscriber', version: '12' }],
        fragments: [
          { text: 'h e l l o ', emote: null },
          { text: 'TriHard', emote: { emoteID: '120232' } },
          { text: ' 7', emote: null },
        ],
      },
    }
    const res = normalizeVodComment(node as never, 'chan11')
    expect(res).not.toBeNull()
    expect(res!.offset).toBe(42)
    const pm = res!.pm
    expect(pm.id).toBe('comment-1')
    expect(pm.message).toBe('h e l l o TriHard 7')
    expect(pm.username).toBe('user')
    expect(pm.displayName).toBe('User')
    expect(pm.userId).toBe('uid')
    expect(pm.color).toBe('#FF0000')
    expect(pm.rawColor).toBe('#FF0000')
    expect(pm.isAction).toBe(false)
    expect(pm.bits).toBe(null)
    // Emote range covers exactly "TriHard" (indices 10..16).
    expect(pm.twitchEmotes).toEqual([{ start: 10, end: 16, id: '120232' }])
    expect(pm.badges.length).toBe(1)
    expect(pm.badges[0].id).toBe('subscriber')
    expect(pm.badges[0].version).toBe('12')
    // Timestamp parsed from createdAt (wall-clock) for the timestamp toggle.
    expect(pm.timestamp).toBe(Date.parse('2020-01-01T12:00:48.123Z'))
  })

  it('drops empty setID badge rows and normalizes an absent color', async () => {
    const { normalizeVodComment } = await import('./vodchat.svelte')
    const node = {
      id: 'c2',
      contentOffsetSeconds: 0,
      createdAt: '',
      commenter: null,
      message: {
        userColor: null,
        userBadges: [
          { setID: '', version: '' },
          { setID: 'moderator', version: '1' },
        ],
        fragments: [{ text: 'hi', emote: null }],
      },
    }
    const res = normalizeVodComment(node as never, 'ch')
    expect(res!.pm.message).toBe('hi')
    // Absent color -> the deterministic palette default for the (empty)
    // login — never the old hard-coded #ffffff.
    expect(res!.pm.color).toBe(defaultNameColor(''))
    expect(res!.pm.color).not.toBe('#ffffff')
    expect(res!.pm.username).toBe('') // no commenter
    expect(res!.pm.badges.map((b) => b.id)).toEqual(['moderator']) // empty row dropped
    expect(Number.isFinite(res!.pm.timestamp)).toBe(true) // falls back to now
  })
})

describe('fetchVodComments', () => {
  it('normalizes a GQL page and reports the max offset', async () => {
    const { fetchVodComments } = await import('./vodchat.svelte')
    gql.handler = async () =>
      JSON.stringify({
        data: {
          video: {
            comments: {
              edges: [
                {
                  node: {
                    id: 'a',
                    contentOffsetSeconds: 0,
                    createdAt: '2026-01-01T00:00:00Z',
                    commenter: { id: 'u1', login: 'alice', displayName: 'Alice' },
                    message: {
                      userColor: '#0000FF',
                      userBadges: [],
                      fragments: [{ text: 'hello', emote: null }],
                    },
                  },
                },
                {
                  node: {
                    id: 'b',
                    contentOffsetSeconds: 5,
                    createdAt: '2026-01-01T00:00:05Z',
                    commenter: { id: 'u2', login: 'bob', displayName: 'Bob' },
                    message: {
                      userColor: null,
                      userBadges: [],
                      fragments: [
                        { text: 'wow ', emote: null },
                        { text: 'Kappa', emote: { emoteID: '25' } },
                      ],
                    },
                  },
                },
              ],
            },
          },
        },
      })
    const page = await fetchVodComments('123', 'ch', 0)
    expect(page.comments.length).toBe(2)
    expect(page.maxOffset).toBe(5)
    expect(page.comments[0].pm.message).toBe('hello')
    expect(page.comments[1].pm.twitchEmotes).toEqual([{ start: 4, end: 8, id: '25' }])
    expect(page.comments[1].pm.message).toBe('wow Kappa')
  })

  it('an empty page is a success (no throw, empty result)', async () => {
    const { fetchVodComments } = await import('./vodchat.svelte')
    gql.handler = async () => JSON.stringify({ data: { video: { comments: { edges: [] } } } })
    const page = await fetchVodComments('123', 'ch', 9999)
    expect(page.comments).toEqual([])
    expect(page.maxOffset).toBe(9999)
  })
})
