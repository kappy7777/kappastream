// Pins the VOD quality menu's data sources: the variant list comes from the
// per-VOD probe (vod_qualities — VODs transcode independently of the live
// stream), and a requested rung the VOD does not offer falls back to best
// ONCE instead of erroring. The error path used to strand the player on a
// raw "streamlink exited with code 1" overlay whenever a quality carried
// over from live (or the old full-vocabulary menu) named a rung the VOD
// never transcoded.
import { describe, it, expect, vi, afterEach } from 'vitest'
import { mount, unmount } from 'svelte'

const calls = vi.hoisted(() => ({
  resolveVod: [] as string[],
  vodQualities: [] as string[],
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

import { STREAMLINK_STATUS_OK } from './test-streamlink-status'

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
      case 'resolve_vod': {
        // Only 'best' is offered by this VOD; anything else is unavailable.
        const requested = String(args?.quality)
        calls.resolveVod.push(requested)
        if (requested === 'best') return { ok: true, url: 'https://cdn.example.invalid/vod.m3u8' }
        return {
          ok: false,
          url: null,
          error: "error: The specified stream(s) 'x' are not available",
          unavailable: true,
        }
      }
      case 'vod_qualities':
        calls.vodQualities.push(String(args?.videoId))
        return ['best', '720p60', '160p']
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

function emitManifestParsed(): void {
  const inst = hlsMock.instances[hlsMock.instances.length - 1]
  if (!inst) throw new Error('no FakeHls instance was created')
  for (const call of inst.on.mock.calls) {
    if (call[0] === 'hlsManifestParsed') (call[1] as (e: unknown, d: unknown) => void)(undefined, {})
  }
}

let view: ReturnType<typeof mount> | null = null

afterEach(() => {
  if (view) void unmount(view)
  view = null
  settings.setMpvEngine(false)
  localStorage.clear()
  localStorage.setItem('twitch-favorites-v1', JSON.stringify([{ name: 'chan2', addedAt: 1, order: 1 }]))
  hlsMock.instances.length = 0
  calls.resolveVod.length = 0
  calls.vodQualities.length = 0
})

describe('VOD quality menu', () => {
  it('probes the VOD variant list and falls back to best for an unoffered rung', async () => {
    // A saved live quality this VOD does not transcode — the exact path
    // that used to end on a raw streamlink error overlay.
    settings.setQualityFor('chan2', '1080p60')
    localStorage.setItem('app-last-seen-version-v1', '99.0.0')
    const target = document.createElement('div')
    document.body.appendChild(target)
    view = mount(App, { target })
    await sleep(150)

    q('.fav').click()
    await sleep(300)
    emitManifestParsed()
    await sleep(50)

    // Open the VOD while `quality` is still the live 1080p60 preference.
    let card: HTMLButtonElement | null = null
    for (let i = 0; i < 40 && !card; i++) {
      card = document.querySelector<HTMLButtonElement>('.cc-card')
      if (!card) await sleep(50)
    }
    if (!card) throw new Error('no VOD card rendered')
    card.click()
    await sleep(150)
    emitManifestParsed()
    await sleep(250)

    // THE FALLBACK PIN: 1080p60 was tried once, the load retried at best,
    // and the player reached playing — no error overlay.
    expect(calls.resolveVod).toEqual(['1080p60', 'best'])
    expect(document.querySelector('.player-overlay--error')).toBeNull()
    // THE PROBE PIN: the menu's variant list was probed per-VOD.
    expect(calls.vodQualities).toEqual(['v1'])
  }, 20000)
})
