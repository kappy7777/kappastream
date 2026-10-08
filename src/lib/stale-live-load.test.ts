// Pins the stale-live-load race on the native engine: joining a channel
// (live resolve in flight) and opening a VOD inside that window used to let
// the live load win — after the resolve it still looked current by
// generation + channel + quality (the native VOD attach never bumps the
// session generation), so it fired its loadfile OVER the just-attached VOD,
// then noticed the token mismatch, stopped the engine and left an error
// overlay. loadStream/attachStream now check the load token after every
// await and before attachMpv.
//
// The mpv engine is faked at the invoke boundary (mpv_available reports
// available; mpv_load/mpv_stop record) — no libmpv needed.
import { describe, it, expect, vi, afterEach } from 'vitest'
import { mount, unmount } from 'svelte'

const calls = vi.hoisted(() => ({
  mpvLoads: [] as { kind: string; url: string }[],
  mpvStops: 0,
}))

// The live resolve must still be in flight when the VOD opens, with enough
// margin that a slow CI cannot invert the order.
const RESOLVE_STREAM_DELAY_MS = 2000

vi.mock('hls.js', () => {
  class FakeHls {
    static readonly Events = { MANIFEST_PARSED: 'hlsManifestParsed', ERROR: 'hlsError' }
    static isSupported = vi.fn((): boolean => false)
    on = vi.fn()
    loadSource = vi.fn()
    attachMedia = vi.fn()
    destroy = vi.fn()
    liveSyncPosition: number | null = null
  }
  return { default: FakeHls }
})

vi.mock('@tauri-apps/api/core', () => ({
  isTauri: () => true,
  invoke: vi.fn(async (cmd: string, args?: Record<string, unknown>) => {
    const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
    switch (cmd) {
      case 'target_os':
        return 'linux'
      case 'mpv_available':
        return { available: true }
      case 'mpv_load':
        calls.mpvLoads.push({ kind: String(args?.kind), url: String(args?.url) })
        return null
      case 'mpv_stop':
        calls.mpvStops++
        return null
      case 'resolve_stream':
        await sleep(RESOLVE_STREAM_DELAY_MS)
        return { ok: true, url: 'https://cdn.example.invalid/live.m3u8' }
      case 'resolve_vod':
        return { ok: true, url: 'https://cdn.example.invalid/vod.m3u8' }
      case 'streamlink_status':
        return { present: true, targetOs: 'linux' }
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
        if (body.includes('videos(')) {
          const edges = [
            {
              node: {
                id: 'v1',
                title: 'Some VOD',
                lengthSeconds: 3600,
                viewCount: 5,
                createdAt: '2026-01-01T00:00:00Z',
                previewThumbnailURL: '',
                broadcastType: 'ARCHIVE',
                game: { displayName: 'g' },
              },
            },
          ]
          return JSON.stringify({ data: { user: { videos: { edges } } } })
        }
        if (body.includes('clips(')) {
          return JSON.stringify({ data: { user: { clips: { edges: [] } } } })
        }
        if (body.includes('comments(')) {
          return JSON.stringify({ data: { video: { comments: { edges: [] } } } })
        }
        if (body.includes('seekPreviewsURL')) {
          return JSON.stringify({ data: { video: null } })
        }
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
class ImmediateIntersectionObserver {
  callback: IntersectionObserverCallback
  constructor(cb: IntersectionObserverCallback) {
    this.callback = cb
  }
  observe(): void {
    queueMicrotask(() => this.callback([{ isIntersecting: true } as IntersectionObserverEntry], this as never))
  }
  unobserve(): void {}
  disconnect(): void {}
  takeRecords(): IntersectionObserverEntry[] {
    return []
  }
}
globalThis.IntersectionObserver = ImmediateIntersectionObserver as unknown as typeof IntersectionObserver
HTMLMediaElement.prototype.play = function (): Promise<void> {
  return Promise.resolve()
}
HTMLMediaElement.prototype.pause = function (): void {}
HTMLMediaElement.prototype.load = function (): void {}

localStorage.setItem('twitch-favorites-v1', JSON.stringify([{ name: 'chan2', addedAt: 1, order: 1 }]))

const App = (await import('../App.svelte')).default
const { settings } = await import('./settings.svelte.ts')

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

function q(sel: string): HTMLElement {
  const el = document.querySelector(sel)
  if (!el) throw new Error('missing element: ' + sel)
  return el as HTMLElement
}

async function firstCard(): Promise<HTMLButtonElement> {
  for (let i = 0; i < 40; i++) {
    const el = document.querySelector<HTMLButtonElement>('.cc-card')
    if (el) return el
    await sleep(25)
  }
  throw new Error('no VOD card rendered')
}

let view: ReturnType<typeof mount> | null = null

afterEach(() => {
  if (view) void unmount(view)
  view = null
  settings.setMpvEngine(false)
  localStorage.clear()
  localStorage.setItem('twitch-favorites-v1', JSON.stringify([{ name: 'chan2', addedAt: 1, order: 1 }]))
  calls.mpvLoads.length = 0
  calls.mpvStops = 0
})

describe('opening a VOD while the live load is still resolving (native engine)', () => {
  it('the stale live load never reaches the engine', async () => {
    settings.setMpvEngine(true)
    localStorage.setItem('app-last-seen-version-v1', '99.0.0')
    const target = document.createElement('div')
    document.body.appendChild(target)
    view = mount(App, { target })
    await sleep(150)

    // Join the favorite — the live resolve hangs (still in flight).
    q('.fav').click()
    await sleep(50)

    // Open the channel's VOD inside the window: it resolves + attaches
    // immediately on the (faked) native engine.
    ;(await firstCard()).click()
    await sleep(300)
    expect(calls.mpvLoads).toEqual([{ kind: 'vod', url: 'https://cdn.example.invalid/vod.m3u8' }])

    // Wait past the live resolve + the stale tail window.
    await sleep(RESOLVE_STREAM_DELAY_MS)

    // THE PIN: the stale live load returned silently — no live loadfile
    // over the VOD, no engine stop, no error overlay.
    expect(calls.mpvLoads).toEqual([{ kind: 'vod', url: 'https://cdn.example.invalid/vod.m3u8' }])
    expect(calls.mpvStops).toBe(0)
    expect(document.querySelector('.player-overlay--error')).toBeNull()
  }, 20000)
})
