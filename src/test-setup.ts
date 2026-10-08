// Shared vitest setup, run before every test file (vitest.config.ts
// `test.setupFiles`).
//
// happy-dom's WebSocket is a REAL network client: any test that mounts a
// genuine ChatSession without stubbing the global opens a TLS connection to
// irc-ws.chat.twitch.tv on every run. The default here is an inert socket
// that never connects and never fires handlers, so an unstubbbed session
// simply sits in 'connecting' — no network, no reconnect timers firing out
// from under a test. Files that need socket BEHAVIOR (open frames, close
// events) install their own richer fake per test (see chat-session-trim /
// chat-session-reconnect), which replaces this one until the file ends.
import { vi } from 'vitest'

class InertWebSocket {
  static readonly CONNECTING = 0
  static readonly OPEN = 1
  static readonly CLOSING = 2
  static readonly CLOSED = 3
  readonly CONNECTING = 0
  readonly OPEN = 1
  readonly CLOSING = 2
  readonly CLOSED = 3
  readyState = 0
  onopen: ((ev: unknown) => void) | null = null
  onmessage: ((ev: unknown) => void) | null = null
  onerror: ((ev: unknown) => void) | null = null
  onclose: ((ev: unknown) => void) | null = null
  constructor(_url: string | URL, _protocols?: string | string[]) {}
  send(_data: string): void {}
  close(): void {}
}

vi.stubGlobal('WebSocket', InertWebSocket)
