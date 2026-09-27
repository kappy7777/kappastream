// Pins ChatSession.closeSocket: the VOD/clip takeover must close ONLY the
// socket. The old path called dispose(), which aborts the in-flight emote
// load — a VOD opened right after joining then replayed without third-party
// emotes for its whole runtime (the emote map feeds the VOD chat renderer,
// and the dead session object was kept referenced precisely for that).
import { describe, it, expect, vi, beforeEach } from 'vitest'

const pending = vi.hoisted(() => ({
  resolveChannel: null as null | (() => void),
  resolveGlobal: null as null | (() => void),
}))

vi.mock('./emotes', async (importOriginal) => {
  const orig = await importOriginal<typeof import('./emotes')>()
  return {
    ...orig,
    loadChannelEmotes: vi.fn(
      () =>
        new Promise((resolve) => {
          pending.resolveChannel = () =>
            resolve({
              emotes: [{ id: 'e1', name: 'EmoteOne', url: 'https://example/e1.webp', provider: '7tv' }],
              allFailed: false,
            })
        }),
    ),
    loadGlobalEmotes: vi.fn(
      () =>
        new Promise((resolve) => {
          pending.resolveGlobal = () => resolve({ emotes: [], allFailed: false })
        }),
    ),
  }
})

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(async () => {
    throw new Error('invoke not configured')
  }),
  isTauri: () => false,
}))

beforeEach(() => {
  pending.resolveChannel = null
  pending.resolveGlobal = null
  vi.clearAllMocks()
})

describe('ChatSession.closeSocket keeps the emote load running', () => {
  it('a VOD takeover after start() still receives the channel emotes', async () => {
    const { ChatSession } = await import('./chat-session.svelte')
    const s = new ChatSession('chan1')
    s.start()
    expect(s.emoteStatus).toBe('loading')

    // The VOD/clip takeover: socket closed, session kept referenced.
    s.closeSocket()
    expect(s.status).toBe('idle')
    expect(s.emoteStatus).toBe('loading') // the load was NOT aborted

    // The providers answer (after the takeover): the results must land.
    pending.resolveChannel!()
    pending.resolveGlobal!()
    await new Promise((r) => setTimeout(r, 10))
    expect(s.emoteStatus).toBe('ready')
    expect(s.thirdParty.get('EmoteOne')).toBeTruthy()
    s.dispose()
  })
})
