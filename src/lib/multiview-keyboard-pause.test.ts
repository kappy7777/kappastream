// Pins the multi-view keyboard pause: App's Space/K used to pause the
// authority tile's <video> while flagging APP's playbackSession.userPaused —
// the tile's own onPause saw its session's flag still false, armed live stall
// recovery, and auto-resumed at the live edge ~1 s later. The shortcut now
// routes through the authority tile's own togglePlay handle, which flags the
// TILE session's userPaused before pausing.
import { describe, it, expect, vi, afterEach } from 'vitest'
import { mount, unmount } from 'svelte'

const hlsMock = vi.hoisted(() => {
  const instances: {
    on: ReturnType<typeof vi.fn>
    loadSource: ReturnType<typeof vi.fn>
    attachMedia: ReturnType<typeof vi.fn>
    destroy: ReturnType<typeof vi.fn>
    liveSyncPosition: number | null
  }[] = []
  return { instances }
})

vi.mock('hls.js', () => {
  class FakeHls {
    static readonly Events = { MANIFEST_PARSED: 'hlsManifestParsed', ERROR: 'hlsError' }
    static isSupported = vi.fn((): boolean => true)
    on = vi.fn()
    loadSource = vi.fn()
    attachMedia = vi.fn()
    destroy = vi.fn()
    liveSyncPosition: number | null = null
    constructor(_config: unknown) {
      hlsMock.instances.push(this as unknown as (typeof hlsMock)['instances'][number])
    }
  }
  return { default: FakeHls }
})

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
        // The real transport returns a JSON STRING (gqlRequest JSON.parses).
        const body = typeof args?.body === 'string' ? args.body : ''
        if (body.includes('users(logins:')) {
          return JSON.stringify({
            data: {
              users: [{ id: '111', login: 'chan5', profileImageURL: 'a', followers: { totalCount: 1 }, stream: null }],
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
// play()/pause() flip a WRITABLE paused flag (happy-dom ships a getter-only
// stub) so the pause actually "sticks", and play() is COUNTED per element —
// the regression signal is whether stall recovery calls play() again after
// the keyboard pause.
Object.defineProperty(HTMLMediaElement.prototype, 'paused', {
  configurable: true,
  writable: true,
  value: true,
})
const playCalls = new WeakMap<Element, number>()
// Writable view over the getter-only `paused` stub (redefined as a data
// property above) — the DOM typings mark it readonly.
type WritableVideo = HTMLVideoElement & { paused: boolean }
HTMLMediaElement.prototype.play = function (this: HTMLVideoElement): Promise<void> {
  const el = this as WritableVideo
  playCalls.set(this, (playCalls.get(this) ?? 0) + 1)
  el.paused = false
  return Promise.resolve()
}
HTMLMediaElement.prototype.pause = function (this: HTMLVideoElement): void {
  const el = this as WritableVideo
  if (el.paused) return
  el.paused = true
  // The real element fires a `pause` event — the tile's onPause handler (live
  // stall recovery) keys off it, so the stub must fire it too or the
  // auto-resume path this test pins never runs at all.
  this.dispatchEvent(new Event('pause'))
}
HTMLMediaElement.prototype.load = function (): void {}

// Seeded BEFORE the App import: the first-launch store classifies at module
// construction, and a first-install welcome overlay would suppress player
// shortcuts entirely.
localStorage.setItem('app-last-seen-version-v1', '99.0.0')
localStorage.setItem('twitch-favorites-v1', JSON.stringify([{ name: 'chan5', addedAt: 1, order: 1 }]))

const App = (await import('../App.svelte')).default
const { tileStore } = await import('./tile-store.svelte')
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
  tileStore.exitAll()
  settings.setMpvEngine(false)
  localStorage.clear()
  hlsMock.instances.length = 0
})

describe('multi-view keyboard pause sticks', () => {
  it('pressing K pauses the authority tile and stall recovery does not resume it', async () => {
    const target = document.createElement('div')
    document.body.appendChild(target)
    view = mount(App, { target })
    await sleep(150)

    // Enter multi-view, open the favorite as the first (authority) tile.
    q('button[aria-label="Multi-stream view"]').click()
    await sleep(80)
    q('.fav').click()
    await sleep(300)
    expect(document.querySelector('[data-tile-id]')).toBeTruthy()

    const inst = hlsMock.instances[hlsMock.instances.length - 1]!
    for (const call of inst.on.mock.calls) {
      if (call[0] === 'hlsManifestParsed') (call[1] as (e: unknown, d: unknown) => void)(undefined, {})
    }
    await sleep(200)

    const video = document.querySelector<HTMLVideoElement>('[data-tile-id] video')
    expect(video).toBeTruthy()
    const before = playCalls.get(video!) ?? 0
    expect(before).toBeGreaterThan(0) // the tile autoplayed

    // THE SHORTCUT: K pauses via the global handler.
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', bubbles: true }))
    await sleep(50)
    expect(video!.paused).toBe(true)

    // Past the 1 s stall-recovery grace: no extra play() call may have fired.
    await sleep(1400)
    expect(video!.paused).toBe(true)
    expect(playCalls.get(video!)).toBe(before)
  }, 20000)
})
