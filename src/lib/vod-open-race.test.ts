// Pins the superseded-VOD tail: opening VOD A and switching to VOD B while
// A's resolve is still in flight used to let A's playVod tail run anyway —
// loadVod returned early on its staleness check, but the caller couldn't
// tell, so A's chat replay loop started over B's player and A's (later)
// extras response overwrote B's chapters. loadVod now reports whether it
// is still current and playVod skips the follow-ups when it isn't.
import { describe, it, expect, vi, afterEach } from 'vitest'
import { mount, unmount } from 'svelte'

const gqlCalls = vi.hoisted(() => ({
  extrasFor: [] as string[],
  commentsFor: [] as string[],
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

// VOD 111 resolves slowly, VOD 222 immediately: opening A then quickly B
// makes A the superseded load once B attaches.
const RESOLVE_VOD_DELAY_MS = 250

vi.mock('@tauri-apps/api/core', () => ({
  isTauri: () => true,
  invoke: vi.fn(async (cmd: string, args?: Record<string, unknown>) => {
    const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
    switch (cmd) {
      case 'target_os':
        return 'linux'
      case 'mpv_available':
        return { available: false }
      case 'resolve_stream':
        return { ok: true, url: 'https://cdn.example.invalid/live.m3u8' }
      case 'resolve_vod':
        if (args?.videoId === '111') await sleep(RESOLVE_VOD_DELAY_MS)
        return { ok: true, url: `https://cdn.example.invalid/vod-${String(args?.videoId)}.m3u8` }
      case 'streamlink_status':
        return STREAMLINK_STATUS_OK
      case 'stream_qualities':
        return []
      case 'gql_fetch': {
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
          const edge = (id: string, title: string) => ({
            node: {
              id,
              title,
              lengthSeconds: 3600,
              viewCount: 5,
              createdAt: '2026-01-01T00:00:00Z',
              previewThumbnailURL: '',
              broadcastType: 'ARCHIVE',
              game: { displayName: 'g' },
            },
          })
          return JSON.stringify({
            data: { user: { videos: { edges: [edge('111', 'VOD A'), edge('222', 'VOD B')] } } },
          })
        }
        if (body.includes('clips(')) {
          return JSON.stringify({ data: { user: { clips: { edges: [] } } } })
        }
        if (body.includes('comments(')) {
          gqlCalls.commentsFor.push(String(vars.videoID))
          return JSON.stringify({ data: { video: { comments: { edges: [] } } } })
        }
        if (body.includes('seekPreviewsURL')) {
          gqlCalls.extrasFor.push(String(vars.id))
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
// The VOD chat replay only fetches while the player reports unpaused; the
// stubbed play() above never flips the element's paused flag, so pin it
// false here (nothing in this scenario depends on a paused player).
Object.defineProperty(HTMLMediaElement.prototype, 'paused', {
  configurable: true,
  get: () => false,
})

localStorage.setItem('twitch-favorites-v1', JSON.stringify([{ name: 'chan2', addedAt: 1, order: 1 }]))

const App = (await import('../App.svelte')).default
const { settings } = await import('./settings.svelte.ts')

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

function q(sel: string): HTMLElement {
  const el = document.querySelector(sel)
  if (!el) throw new Error('missing element: ' + sel)
  return el as HTMLElement
}

async function cardByTitle(title: string): Promise<HTMLButtonElement> {
  for (let i = 0; i < 40; i++) {
    const el = [...document.querySelectorAll<HTMLButtonElement>('.cc-card')].find((c) => c.textContent?.includes(title))
    if (el) return el
    await sleep(50)
  }
  throw new Error('no card titled: ' + title)
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
  gqlCalls.extrasFor.length = 0
  gqlCalls.commentsFor.length = 0
})

describe('switching VODs while the first is still resolving', () => {
  it('the superseded VOD starts no chat replay and no extras fetch', async () => {
    localStorage.setItem('app-last-seen-version-v1', '99.0.0')
    const target = document.createElement('div')
    document.body.appendChild(target)
    view = mount(App, { target })
    await sleep(150)

    // Join the favorite → live attaches.
    q('.fav').click()
    await sleep(300)

    // Open VOD A, then VOD B while A's resolve is in flight.
    ;(await cardByTitle('VOD A')).click()
    await sleep(40)
    ;(await cardByTitle('VOD B')).click()
    // Let B attach + reach playing (manifest parse promotes the attach).
    await sleep(120)
    emitManifestParsed()
    // Wait past A's delayed resolve + the buggy tail window.
    await sleep(RESOLVE_VOD_DELAY_MS + 350)

    // THE PIN: only B's chat replay and extras were ever requested.
    expect(gqlCalls.commentsFor).toEqual(['222'])
    expect(gqlCalls.extrasFor).toEqual(['222'])
  }, 20000)
})
