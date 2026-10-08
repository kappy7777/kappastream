// Pins the status-bar error rule: fetchLiveStatus resolves {state:'error'}
// instead of throwing on a transport failure, and assigning that to
// activeStatus blanked the bar (title/viewers render only for live/offline)
// and dropped the pinned-chat target until the next good poll (up to 150 s).
// An error result is now ignored in both fetch paths — the last known status
// stays.
import { describe, it, expect, vi, afterEach } from 'vitest'
import { mount, unmount } from 'svelte'

const gqlState = vi.hoisted(() => ({
  failStatusQueries: false,
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
        if (body.includes('users(logins:')) {
          if (gqlState.failStatusQueries) throw new Error('HTTP 500')
          return JSON.stringify({
            data: {
              users: [
                {
                  id: '111',
                  login: 'chan8',
                  profileImageURL: 'a',
                  followers: { totalCount: 1 },
                  stream: {
                    id: 's1',
                    title: 'Still Live Title',
                    type: 'live',
                    viewersCount: 7,
                    createdAt: new Date(Date.now() - 3600_000).toISOString(),
                    game: { id: 'g', name: 'SomeGame', displayName: 'SomeGame' },
                  },
                },
              ],
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
localStorage.setItem('twitch-favorites-v1', JSON.stringify([{ name: 'chan8', addedAt: 1, order: 1 }]))

const App = (await import('../App.svelte')).default
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
  settings.setMpvEngine(false)
  localStorage.clear()
  gqlState.failStatusQueries = false
})

describe('a failed status fetch keeps the last known status', () => {
  it('the join-time fetchLiveStatus failing does not blank the live bar', async () => {
    const target = document.createElement('div')
    document.body.appendChild(target)
    view = mount(App, { target })
    // Let the favorites poll resolve the channel live (title known to the
    // store), then make every further status query fail.
    await sleep(400)
    gqlState.failStatusQueries = true

    q('.fav').click()
    await sleep(500)

    // The bar keeps the poll's live status; the failed join-time fetch must
    // not have replaced it with an error state.
    const title = document.querySelector('.stream-info-title')
    expect(title).toBeTruthy()
    expect(title!.textContent).toContain('Still Live Title')
  }, 20000)

  it('the non-favorite 150 s poll failing does not blank the live bar either', async () => {
    // A channel that is NOT a favorite refreshes through its own direct
    // fetchLiveStatus interval (the favorites batch never covers it), so the
    // ignore-error rule has to hold on THAT path too. Fake timers drive the
    // 150 s cadence without wall-clock waiting.
    vi.useFakeTimers()
    try {
      const target = document.createElement('div')
      document.body.appendChild(target)
      view = mount(App, { target })
      await vi.advanceTimersByTimeAsync(400)

      const input = q('.channel-input') as HTMLInputElement
      input.value = 'otherchan'
      input.dispatchEvent(new Event('input', { bubbles: true }))
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
      await vi.advanceTimersByTimeAsync(600)

      const title = (): string | null => document.querySelector('.stream-info-title')?.textContent ?? null
      expect(title()).toContain('Still Live Title') // the join-time fetch landed

      gqlState.failStatusQueries = true
      await vi.advanceTimersByTimeAsync(150_001)
      await vi.advanceTimersByTimeAsync(150_001)
      // Two failed poll ticks later the bar still shows the last known title.
      expect(title()).toContain('Still Live Title')
    } finally {
      vi.useRealTimers()
    }
  }, 20000)
})
