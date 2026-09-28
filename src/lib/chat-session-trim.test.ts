// Pins the buffer trim-hold contract: while the rendering pane is scrolled
// UP reading history, the buffer must not drop entries from the front — the
// WebKit engines (WebKitGTK, WKWebView) have no scroll anchoring, so every
// front-trimmed line slides the visible text up one row (in a busy channel
// ~10 rows/s). The pane reports follow flips via setHoldTrim(); while held,
// push() caps the buffer at a higher ceiling and releasing trims back.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

vi.mock('./emotes', async (importOriginal) => {
  const orig = await importOriginal<typeof import('./emotes')>()
  return {
    ...orig,
    loadChannelEmotes: vi.fn(async () => ({ emotes: [], allFailed: false })),
    loadGlobalEmotes: vi.fn(async () => ({ emotes: [], allFailed: false })),
  }
})

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(async () => {
    throw new Error('invoke not configured')
  }),
  isTauri: () => false,
}))

// ChatSession opens its socket against the global WebSocket; stand in a
// capturable fake so tests can drive PRIVMSG delivery through the real
// parse→buffer pipeline.
class FakeWebSocket {
  static instances: FakeWebSocket[] = []
  url: string
  onopen: (() => void) | null = null
  onmessage: ((ev: { data: string }) => void) | null = null
  onclose: (() => void) | null = null
  onerror: (() => void) | null = null
  sent: string[] = []
  constructor(url: string) {
    this.url = url
    FakeWebSocket.instances.push(this)
  }
  send(data: string): void {
    this.sent.push(data)
  }
  close(): void {}
}

function privmsg(n: number): string {
  return (
    `@badge-info=;badges=;color=#FF0000;display-name=User${n};emotes=;flags=;id=m${n};` +
    `login=user${n};room-id=1;subscriber=0;tmi-sent-ts=1700000000000;turbo=0;` +
    `user-id=${1000 + n};user-type= :user${n}!user${n}@user${n}.tmi.twitch.tv PRIVMSG #chan1 :hello ${n}`
  )
}

function deliver(ws: FakeWebSocket, count: number, from: number): void {
  const lines: string[] = []
  for (let i = 0; i < count; i++) lines.push(privmsg(from + i))
  ws.onmessage?.({ data: lines.join('\r\n') })
}

describe('ChatSession buffer trim', () => {
  let ChatSession: (typeof import('./chat-session.svelte'))['ChatSession']

  beforeEach(async () => {
    FakeWebSocket.instances = []
    vi.stubGlobal('WebSocket', FakeWebSocket)
    ;({ ChatSession } = await import('./chat-session.svelte'))
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  function startedSession(): { s: InstanceType<typeof ChatSession>; ws: FakeWebSocket } {
    const s = new ChatSession('chan1')
    s.start()
    const ws = FakeWebSocket.instances[FakeWebSocket.instances.length - 1]!
    ws.onopen?.()
    expect(ws.sent.join(' ')).toContain('JOIN #chan1')
    return { s, ws }
  }

  it('trims from the front at 500 while the pane follows the bottom', () => {
    const { s, ws } = startedSession()
    deliver(ws, 510, 0)
    expect(s.messages.length).toBe(500)
    expect(s.messages[0]!.id).toBe('m10') // the OLDEST ten were trimmed
    expect(s.messages[s.messages.length - 1]!.id).toBe('m509')
    s.dispose()
  })

  it('holds the trim while the pane is scrolled up; releasing trims to the newest 500', () => {
    const { s, ws } = startedSession()
    s.setHoldTrim(true) // the pane reports: user scrolled up
    deliver(ws, 800, 0)
    expect(s.messages.length).toBe(800) // nothing dropped from the front
    expect(s.messages[0]!.id).toBe('m0')
    expect(s.messages[s.messages.length - 1]!.id).toBe('m799')

    s.setHoldTrim(false) // back to the bottom (jump pill / scroll down)
    expect(s.messages.length).toBe(500)
    expect(s.messages[0]!.id).toBe('m300') // newest 500 kept
    expect(s.messages[s.messages.length - 1]!.id).toBe('m799')
    s.dispose()
  })

  it('a held buffer is still bounded by the 2000-entry ceiling', () => {
    const { s, ws } = startedSession()
    s.setHoldTrim(true)
    deliver(ws, 2100, 0)
    expect(s.messages.length).toBe(2000)
    expect(s.messages[0]!.id).toBe('m100') // sliding window at the ceiling
    expect(s.messages[s.messages.length - 1]!.id).toBe('m2099')
    s.dispose()
  })

  it('pushes after release resume the normal 500 cap', () => {
    const { s, ws } = startedSession()
    s.setHoldTrim(true)
    deliver(ws, 600, 0)
    s.setHoldTrim(false)
    expect(s.messages.length).toBe(500)
    deliver(ws, 10, 600)
    expect(s.messages.length).toBe(500)
    expect(s.messages[0]!.id).toBe('m110')
    expect(s.messages[s.messages.length - 1]!.id).toBe('m609')
    s.dispose()
  })
})
