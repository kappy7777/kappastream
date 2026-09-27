// Pins the low-latency toggle during VOD playback: the toggle effect used to
// reload loadStream(channelJoined) without checking playback.kind, and a VOD
// deliberately keeps `channelJoined` — so flipping the toggle mid-VOD loaded
// the LIVE stream while the UI stayed in VOD mode (VOD title, VOD chat replay
// against the live playhead, position saves under the VOD id). The effect is
// live-only now.
import { describe, it, expect, vi, afterEach } from 'vitest'
import { mount, unmount } from 'svelte'

const calls = vi.hoisted(() => ({
  resolveStream: 0,
}))

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
        calls.resolveStream++
        return { ok: true, url: 'https://cdn.example.invalid/live.m3u8' }
      case 'resolve_vod':
        return { ok: true, url: 'https://cdn.example.invalid/vod.m3u8' }
      case 'streamlink_status':
        return { present: true, targetOs: 'linux' }
      case 'stream_qualities':
        return []
      case 'gql_fetch': {
        // The real transport returns a JSON STRING (gqlRequest JSON.parses).
        const body = typeof args?.body === 'string' ? args.body : ''
        const vars = (() => {
          try {
            return JSON.parse(body).variables as Record<string, unknown>
          } catch {
            return {}
          }
        })()
        if (body.includes('users(logins:')) {
          return JSON.stringify({
            data: {
              users: [{ id: '111', login: 'chan2', profileImageURL: 'a', followers: { totalCount: 1 }, stream: null }],
            },
          })
        }
        if (body.includes('videos(')) {
          const edges =
            vars.type === 'ARCHIVE'
              ? [
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
              : []
          return JSON.stringify({ data: { user: { videos: { edges } } } })
        }
        if (body.includes('clips(')) {
          return JSON.stringify({ data: { user: { clips: { edges: [] } } } })
        }
        if (body.includes('comments(')) {
          return JSON.stringify({ data: { video: { comments: { edges: [] } } } })
        }
        if (body.includes('CollaboratorListQuery')) {
          return JSON.stringify({ data: {} })
        }
        if (body.includes('badges')) {
          return JSON.stringify({ data: { badges: [] } })
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
// ChannelContent lazy-fetches through an IntersectionObserver on a sentinel;
// firing isIntersecting immediately makes the channel's VOD list load as soon
// as the component mounts (what scrolling it into view does).
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

let view: ReturnType<typeof mount> | null = null

afterEach(() => {
  if (view) void unmount(view)
  view = null
  settings.setMpvEngine(false)
  localStorage.clear()
  hlsMock.instances.length = 0
  calls.resolveStream = 0
})

describe('low-latency toggle during VOD playback', () => {
  it('does not reload the live stream while a VOD plays', async () => {
    localStorage.setItem('app-last-seen-version-v1', '99.0.0')
    const target = document.createElement('div')
    document.body.appendChild(target)
    view = mount(App, { target })
    await sleep(150)

    // Join the favorite → live stream resolves + attaches.
    q('.fav').click()
    await sleep(300)
    expect(calls.resolveStream).toBe(1)
    expect(document.querySelector('video.video')).toBeTruthy()

    // ChannelContent's observer fired; the ARCHIVE list rendered. Click it.
    const card = await (async () => {
      for (let i = 0; i < 40; i++) {
        const el = document.querySelector<HTMLButtonElement>('.cc-card')
        if (el) return el
        await sleep(50)
      }
      throw new Error('no VOD card rendered')
    })()
    card.click()
    await sleep(400)
    // VOD attached (resolve_vod, not another resolve_stream).
    expect(calls.resolveStream).toBe(1)

    // THE TOGGLE: flipping low-latency mid-VOD must not touch the live path.
    settings.setLowLatency(!settings.lowLatency)
    await sleep(300)
    expect(calls.resolveStream).toBe(1)
  }, 20000)
})
