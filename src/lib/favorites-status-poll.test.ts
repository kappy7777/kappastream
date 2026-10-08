// Pins the favorites-membership reactivity in App: the activeStatus effect
// used to read favoritesStore.has() through a plain (untracked) field, so
// un-favoriting the joined channel from the status-bar heart never re-ran
// it — the store's poll stopped covering the channel (it was no longer a
// favorite) while App never started its own cadence, and the status bar
// froze until the next channel change. The membership now reads through a
// tracked $derived; the effect re-runs the moment it flips and starts App's
// own interval — WITHOUT resetting activeStatus or issuing an immediate
// refetch (the flip used to blank the bar, the pinned banner and the
// Back-to-live banner until that refetch landed).
import { describe, it, expect, vi, afterEach } from 'vitest'
import { mount, unmount } from 'svelte'

const gqlCalls = vi.hoisted(() => ({
  bodies: [] as string[],
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
        return { present: true, targetOs: 'linux' }
      case 'stream_qualities':
        return []
      case 'gql_fetch': {
        const body = typeof args?.body === 'string' ? args.body : ''
        gqlCalls.bodies.push(body)
        if (body.includes('users(logins:')) {
          let logins: string[] = []
          try {
            logins = (JSON.parse(body).variables as { logins?: string[] }).logins ?? []
          } catch {
            /* leave empty */
          }
          const users = logins.map((login) => ({
            id: 'id-' + login,
            login,
            displayName: login,
            profileImageURL: 'a',
            followers: { totalCount: 1 },
            stream: null,
          }))
          return JSON.stringify({ data: { users } })
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
localStorage.setItem('twitch-favorites-v1', JSON.stringify([{ name: 'chan7', addedAt: 1, order: 1 }]))

const App = (await import('../App.svelte')).default
const { settings } = await import('./settings.svelte.ts')
const { GQL_REFRESH_INTERVAL_MS } = await import('./gql')

function q(sel: string): HTMLElement {
  const el = document.querySelector(sel)
  if (!el) throw new Error('missing element: ' + sel)
  return el as HTMLElement
}

/** Count of single-login status queries for the joined channel. */
function chanFetches(): number {
  return gqlCalls.bodies.filter((b) => b.includes('users(logins:') && b.includes('"chan7"')).length
}

let view: ReturnType<typeof mount> | null = null

afterEach(() => {
  if (view) void unmount(view)
  view = null
  settings.setMpvEngine(false)
  localStorage.clear()
  gqlCalls.bodies.length = 0
})

describe("un-favoriting the joined channel starts App's own status poll", () => {
  it('the heart flip neither blanks the bar nor double-fetches; the own poll takes over', async () => {
    vi.useFakeTimers()
    try {
      const target = document.createElement('div')
      document.body.appendChild(target)
      view = mount(App, { target })
      await vi.advanceTimersByTimeAsync(200)

      // Join the FAVORITE channel (the heart is on: it is a favorite).
      q('.fav').click()
      await vi.advanceTimersByTimeAsync(400)
      const joinedFetches = chanFetches()
      // The join-time fetchLiveStatus fired once for the status bar.
      expect(joinedFetches).toBeGreaterThanOrEqual(1)
      // Its (offline) answer is on screen.
      expect(document.querySelector('.stream-info-offline')).toBeTruthy()

      // Un-favorite via the status-bar heart (the first .notif-toggle).
      const heart = document.querySelector<HTMLButtonElement>('.notif-toggle')
      expect(heart).toBeTruthy()
      heart!.click()
      await vi.advanceTimersByTimeAsync(400)

      // The membership flip re-ran the effect, but it must NOT reset the
      // status (the bar keeps its content) and must NOT refetch immediately
      // — the last-known status simply stays until the own cadence ticks.
      expect(document.querySelector('.stream-info-offline')).toBeTruthy()
      expect(chanFetches()).toBe(joinedFetches)

      // App's own poll interval exists for the now non-favorite channel:
      // one GQL_REFRESH_INTERVAL later a fresh single-channel query fires.
      await vi.advanceTimersByTimeAsync(GQL_REFRESH_INTERVAL_MS + 200)
      expect(chanFetches()).toBeGreaterThan(joinedFetches)
    } finally {
      vi.useRealTimers()
    }
  }, 20000)
})
