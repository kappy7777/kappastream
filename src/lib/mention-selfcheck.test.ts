// Pins the mention self-check: it compares the LOGIN (the mention-username
// setting is a login), not the display name. A different user whose DISPLAY
// name happens to equal the configured target must still trigger a mention
// notification — with the display-name comparison it was swallowed as a
// "self-mention".
import { describe, it, expect, vi, afterEach } from 'vitest'
import { mount, unmount } from 'svelte'

const mentionLog = vi.hoisted(() => [] as { title: string; channel: string }[])

import { STREAMLINK_STATUS_OK } from './test-streamlink-status'

vi.mock('./notifications.svelte.ts', () => ({
  notifications: {
    record: (kind: string, title: string, _body: string, channel: string) => {
      if (kind === 'mention') mentionLog.push({ title, channel })
    },
  },
}))

vi.mock('@tauri-apps/api/core', () => ({
  isTauri: () => true,
  invoke: vi.fn(async (cmd: string, args?: Record<string, unknown>) => {
    switch (cmd) {
      case 'target_os':
        return 'linux'
      case 'mpv_available':
        return { available: false }
      case 'resolve_stream':
        return { ok: true, url: 'https://cdn.example.invalid/live.m3u8' }
      case 'streamlink_status':
        return STREAMLINK_STATUS_OK
      case 'stream_qualities':
        return []
      case 'gql_fetch': {
        const body = typeof args?.body === 'string' ? args.body : ''
        if (body.includes('users(logins:')) {
          return JSON.stringify({
            data: {
              users: [{ id: '111', login: 'chan2', profileImageURL: 'a', followers: { totalCount: 1 }, stream: null }],
            },
          })
        }
        if (body.includes('badges')) return JSON.stringify({ data: { badges: [] } })
        return JSON.stringify({ data: {} })
      }
      default:
        return { ok: true, url: 'https://example.invalid/x' }
    }
  }),
}))

vi.mock('@tauri-apps/plugin-notification', () => ({
  sendNotification: vi.fn(),
}))

vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(async () => () => {}),
  emit: vi.fn(async () => {}),
}))

vi.mock('@tauri-apps/api/window', () => {
  const win = new Proxy(
    {},
    {
      get: (_t, prop: string | symbol) => {
        if (prop === 'then') return undefined
        return () => Promise.resolve(() => {})
      },
    },
  )
  return { getCurrentWindow: () => win, PhysicalSize: { from: (v: unknown) => v } }
})

vi.mock('./chat-session.svelte', async () => {
  const stub = await import('./chat-session-test-stub.svelte.ts')
  return { ChatSession: stub.ChatSessionTestStub }
})

if (!('ResizeObserver' in globalThis)) {
  globalThis.ResizeObserver = class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  } as unknown as typeof ResizeObserver
}
if (!('IntersectionObserver' in globalThis)) {
  globalThis.IntersectionObserver = class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  } as unknown as typeof IntersectionObserver
}
HTMLMediaElement.prototype.play = function (): Promise<void> {
  return Promise.resolve()
}
HTMLMediaElement.prototype.pause = function (): void {}
HTMLMediaElement.prototype.load = function (): void {}

localStorage.setItem('app-last-seen-version-v1', '99.0.0')
localStorage.setItem('twitch-favorites-v1', JSON.stringify([{ name: 'chan2', addedAt: 1, order: 1 }]))
localStorage.setItem('app-mention-username-v1', 'someone')

const App = (await import('../App.svelte')).default
const { chatStubSessions } = await import('./chat-session-test-stub.svelte.ts')
const { settings } = await import('./settings.svelte.ts')

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

function q(sel: string): HTMLElement {
  const el = document.querySelector(sel)
  if (!el) throw new Error('missing element: ' + sel)
  return el as HTMLElement
}

let view: ReturnType<typeof mount> | null = null

afterEach(() => {
  if (view) void unmount(view)
  view = null
  chatStubSessions.length = 0
  settings.setMpvEngine(false)
  localStorage.setItem('app-mention-username-v1', 'someone')
  mentionLog.length = 0
})

describe('the mention self-check compares the login', () => {
  it('another user whose DISPLAY name equals the target still notifies', async () => {
    const target = document.createElement('div')
    document.body.appendChild(target)
    view = mount(App, { target })
    await sleep(150)
    q('.fav').click()
    await sleep(300)

    const session = chatStubSessions.find((s) => s.channel === 'chan2')
    expect(session).toBeTruthy()
    ;(session as unknown as { pushPrivmsg: (ev: unknown) => void }).pushPrivmsg({
      message: 'hey @someone, check this',
      username: 'otherone',
      displayName: 'Someone',
      color: '#FF0000',
    })
    await sleep(80)
    expect(mentionLog.length).toBe(1)
  })

  it('a message from the configured login itself is a self-mention (no toast)', async () => {
    const target = document.createElement('div')
    document.body.appendChild(target)
    view = mount(App, { target })
    await sleep(150)
    q('.fav').click()
    await sleep(300)

    const session = chatStubSessions.find((s) => s.channel === 'chan2')
    ;(session as unknown as { pushPrivmsg: (ev: unknown) => void }).pushPrivmsg({
      message: 'talking about @someone here',
      username: 'someone',
      displayName: 'Someone',
      color: '#FF0000',
    })
    await sleep(80)
    expect(mentionLog.length).toBe(0)
  })
})
