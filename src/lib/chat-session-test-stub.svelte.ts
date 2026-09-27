// A test-only ChatSession stand-in. Vitest compiles `.svelte.ts` modules
// with runes enabled, while `.test.ts` files cannot use them — so tests that
// need to flip `status` REACTIVELY (App reads it through a $derived, exactly
// like the real session) import this class instead of hand-rolling a plain
// mock whose field writes nothing re-renders. Never imported by app code.
export const chatStubControl = {
  // When true, start() schedules a reconnect-style drop (status 'connecting'
  // again) shortly after the initial connect.
  dropAfterConnect: false,
  // When true, the socket NEVER opens: start() stays 'connecting' — the
  // IRC-unreachable scenario.
  neverConnect: false,
}

export const chatStubSessions: {
  channel: string
  status: string
}[] = []

export class ChatSessionTestStub {
  channel: string
  opts: { onPrivmsg?: (ev: unknown) => void }
  messages: unknown[] = $state([])
  status = $state<'idle' | 'connecting' | 'connected' | 'disconnected'>('idle')
  emoteStatus = $state('idle')
  roomState: Record<string, unknown> = {}
  badgeOverride = null
  thirdParty = new Map()
  constructor(channel: string, opts: { onPrivmsg?: (ev: unknown) => void } = {}) {
    this.channel = channel
    this.opts = opts
    chatStubSessions.push(this)
  }
  start(): void {
    if (chatStubControl.neverConnect) {
      this.status = 'connecting'
      return
    }
    this.status = 'connected'
    if (chatStubControl.dropAfterConnect) {
      // Late enough for a test to reach 'playing' and capture the <video>
      // first; the flip itself must land well inside the test's waits.
      setTimeout(() => {
        this.status = 'connecting'
      }, 300)
    }
  }
  /** The VOD/clip takeover path (mirrors the real session's socket-only close). */
  closeSocket(): void {
    this.status = 'idle'
  }

  /** Deliver a PRIVMSG through the onPrivmsg coupling (mention tests). */
  pushPrivmsg(ev: { message: string; username: string; displayName: string; color: string }): void {
    this.opts.onPrivmsg?.(ev)
  }
  dispose(): void {}
}
