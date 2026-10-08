// Pins the IRC reconnect contract: the socket retries FOREVER at the 30 s
// cap (the old fixed budget of 10 attempts gave up after ~3 minutes and a
// longer outage left the pane frozen until the channel was re-clicked), the
// status distinguishes "connecting" from "lost — retrying" so the pane can
// say which, the window 'online' event short-circuits the backoff, and a
// connected socket that went silent without a close frame (system suspend,
// NAT drop) is forced closed and reconnected.
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

// The session drives the real connect/reconnect flow against the global
// WebSocket; the fake never opens by itself — each test decides whether a
// socket's connection attempt fails (onclose), succeeds (onopen), or hangs.
class FakeWebSocket {
  static instances: FakeWebSocket[] = []
  onopen: (() => void) | null = null
  onmessage: ((ev: { data: string }) => void) | null = null
  onclose: (() => void) | null = null
  onerror: (() => void) | null = null
  constructor() {
    FakeWebSocket.instances.push(this)
  }
  send(): void {}
  close(): void {
    // The real transport fires onclose from close() even on a dead peer;
    // the silence watchdog depends on exactly that.
    this.onclose?.()
  }
}

const DELAYS = [1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000, 30_000, 30_000, 30_000]

function lastWs(): FakeWebSocket {
  return FakeWebSocket.instances[FakeWebSocket.instances.length - 1]!
}

describe('ChatSession reconnect', () => {
  let ChatSession: (typeof import('./chat-session.svelte'))['ChatSession']

  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] })
    FakeWebSocket.instances = []
    vi.stubGlobal('WebSocket', FakeWebSocket)
    ;({ ChatSession } = await import('./chat-session.svelte'))
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('retries forever at the 30 s cap, reporting lost after ~3 minutes', async () => {
    const s = new ChatSession('chan1')
    s.start()
    expect(s.status).toBe('connecting')

    // 14 failed connection attempts — past the old 10-attempt give-up.
    for (let attempt = 1; attempt <= 14; attempt++) {
      lastWs().onclose?.()
      expect(s.status, `attempt ${attempt}`).toBe(attempt >= 10 ? 'disconnected' : 'connecting')
      await vi.advanceTimersByTimeAsync(DELAYS[Math.min(attempt, DELAYS.length) - 1]! + 1)
    }
    // A socket was still created for every retry — nothing gave up.
    expect(FakeWebSocket.instances.length).toBe(15)

    // The network heals: the very next attempt connects and clears the slate.
    lastWs().onopen?.()
    expect(s.status).toBe('connected')
    s.dispose()
  })

  it('the online event short-circuits a pending backoff', async () => {
    const s = new ChatSession('chan1')
    s.start()
    lastWs().onclose?.() // 1 s backoff now pending
    expect(s.status).toBe('connecting')

    const before = FakeWebSocket.instances.length
    window.dispatchEvent(new Event('online'))
    // A fresh socket attempt started immediately, without any time passing.
    expect(FakeWebSocket.instances.length).toBe(before + 1)
    lastWs().onopen?.()
    expect(s.status).toBe('connected')

    // And the superseded backoff timer is gone: waiting out the old delay
    // must not spawn another connection behind the healthy one.
    const healthy = FakeWebSocket.instances.length
    await vi.advanceTimersByTimeAsync(5_000)
    expect(FakeWebSocket.instances.length).toBe(healthy)
    s.dispose()
  })

  it('closes and reconnects a socket that went silent mid-connection', async () => {
    const s = new ChatSession('chan1')
    s.start()
    const open = lastWs()
    open.onopen?.()
    expect(s.status).toBe('connected')

    // No line for 6+ minutes (the server PINGs ~every 5 min): the watchdog
    // tick after the threshold closes the dead socket; onclose drives the
    // usual reconnect path.
    await vi.advanceTimersByTimeAsync(6 * 60_000 + 31_000)
    expect(s.status).toBe('connecting')
    expect(FakeWebSocket.instances.length).toBe(2)

    await vi.advanceTimersByTimeAsync(1_001) // the 1 s first backoff
    lastWs().onopen?.()
    expect(s.status).toBe('connected')
    s.dispose()
  })

  it('an idle session (socket closed for a VOD takeover) stays down on online', async () => {
    const s = new ChatSession('chan1')
    s.start()
    lastWs().onopen?.()
    s.closeSocket()
    expect(s.status).toBe('idle')

    window.dispatchEvent(new Event('online'))
    await vi.advanceTimersByTimeAsync(60_000)
    expect(s.status).toBe('idle')
    expect(FakeWebSocket.instances.length).toBe(1)
    s.dispose()
  })
})
