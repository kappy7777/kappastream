// Pins the sidebar-independent favorites poll: FavoritesStore.start() is
// owned by App's onMount, not by the Sidebar's. The Sidebar only mounts when
// !theaterMode && effectiveSidebarMode !== 'hidden', and 'hidden' is
// persisted — so a sidebar-owned poll never started in those states: no
// go-live notifications, no status-bar refresh for a joined favorite, no
// pinned-chat ticks for the whole session. (Idempotency of start() is unit-
// tested in favorites.test.ts.)
import { describe, it, expect, vi, afterEach } from 'vitest'
import { mount, unmount } from 'svelte'

const gqlCalls = vi.hoisted(() => ({
  // Bodies of every gql_fetch request, in order.
  bodies: [] as string[],
}))

import { STREAMLINK_STATUS_OK } from './test-streamlink-status'

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
        gqlCalls.bodies.push(body)
        // The real transport returns a JSON STRING; every GQL call goes
        // through gqlRequest's JSON.parse, so an object here would fail every
        // request as "malformed".
        const wantsUsers = body.includes('users(logins:')
        const wantsBadges = body.includes('badges')
        if (wantsUsers) {
          return JSON.stringify({
            data: {
              users: [{ id: '111', login: 'chan9', profileImageURL: 'a', followers: { totalCount: 1 }, stream: null }],
            },
          })
        }
        if (wantsBadges) return JSON.stringify({ data: { badges: [] } })
        return JSON.stringify({ data: {} })
      }
      default:
        return { ok: true, url: 'https://example.invalid/x' }
    }
  }),
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

// The favorites store is a module-level singleton constructed at import time
// and reads localStorage in its constructor — the favorite must be seeded
// BEFORE App (and its transitive favorites import) is loaded. The test uses
// one channel; the sidebar mode is per-App-instance state and is set inside
// the test.
localStorage.setItem('twitch-favorites-v1', JSON.stringify([{ name: 'chan9', addedAt: 1, order: 1 }]))

const App = (await import('../App.svelte')).default
const { settings } = await import('./settings.svelte.ts')

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

function statusQueryCount(): number {
  return gqlCalls.bodies.filter((b) => b.includes('users(logins:')).length
}

function mountApp(): ReturnType<typeof mount> {
  const target = document.createElement('div')
  document.body.appendChild(target)
  return mount(App, { target })
}

let view: ReturnType<typeof mount> | null = null

afterEach(() => {
  if (view) void unmount(view)
  view = null
  settings.setMpvEngine(false)
  localStorage.clear()
  gqlCalls.bodies.length = 0
})

describe('favorites poll does not depend on the sidebar', () => {
  it('launch with a persisted hidden sidebar still polls favorites', async () => {
    localStorage.setItem('app-last-seen-version-v1', '99.0.0')
    localStorage.setItem('twitch-sidebar-visible-v3', 'hidden')

    view = mountApp()
    await sleep(400)

    // Before the fix only the badge query went out — the status batch never
    // fired because nothing called favoritesStore.start() while the sidebar
    // was not mounted.
    expect(statusQueryCount()).toBeGreaterThanOrEqual(1)
    expect(gqlCalls.bodies.some((b) => b.includes('"chan9"'))).toBe(true)
  }, 15000)
})
