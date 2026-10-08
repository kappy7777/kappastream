// Pins the quality-fallback persistence rule: when a requested variant is
// unavailable (often transient at stream start), the fallback to "best" used
// to ALSO save 'best' as the channel's persisted quality — silently
// discarding the user's bandwidth-driven choice. The fallback is for that
// load only now; the toast still shows.
import { describe, it, expect, vi, afterEach } from 'vitest'
import { mount, unmount } from 'svelte'

const resolveCalls = vi.hoisted(() => ({
  qualities: [] as string[],
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
      case 'resolve_stream': {
        const reqQ = String(args?.quality ?? '')
        resolveCalls.qualities.push(reqQ)
        // Every non-best variant is "unavailable" — the transient start-of-
        // stream case the fallback exists for.
        if (reqQ !== 'best') return { ok: false, unavailable: true, offline: false, error: 'no such variant' }
        return { ok: true, url: 'https://cdn.example.invalid/live.m3u8' }
      }
      case 'streamlink_status':
        return STREAMLINK_STATUS_OK
      case 'stream_qualities':
        return ['720p60', 'audio_only', 'best']
      case 'gql_fetch': {
        const body = typeof args?.body === 'string' ? args.body : ''
        if (body.includes('users(logins:')) {
          return JSON.stringify({
            data: {
              users: [{ id: '111', login: 'chan6', profileImageURL: 'a', followers: { totalCount: 1 }, stream: null }],
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

vi.mock('hls.js', () => {
  class FakeHls {
    static readonly Events = { MANIFEST_PARSED: 'hlsManifestParsed', ERROR: 'hlsError' }
    static isSupported = vi.fn((): boolean => true)
    on = vi.fn()
    loadSource = vi.fn()
    attachMedia = vi.fn()
    destroy = vi.fn()
    liveSyncPosition: number | null = null
  }
  return { default: FakeHls }
})

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

// Seed BEFORE the App import (singletons classify at module construction):
// suppress the welcome overlay and give the channel a persisted 720p60.
localStorage.setItem('app-last-seen-version-v1', '99.0.0')
localStorage.setItem('twitch-favorites-v1', JSON.stringify([{ name: 'chan6', addedAt: 1, order: 1 }]))
localStorage.setItem('app-quality:chan6', '720p60')

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
  resolveCalls.qualities.length = 0
})

describe('the unavailable-quality fallback is not persisted', () => {
  it('falls back to best for the load but keeps the saved quality', async () => {
    const target = document.createElement('div')
    document.body.appendChild(target)
    view = mount(App, { target })
    await sleep(150)

    // Join with the persisted 720p60 → unavailable → fallback loads 'best'.
    q('.fav').click()
    await sleep(500)

    // The fallback happened: '720p60' was requested, then 'best'.
    expect(resolveCalls.qualities).toContain('720p60')
    expect(resolveCalls.qualities[resolveCalls.qualities.length - 1]).toBe('best')

    // The toast mentioned the fallback...
    expect(document.querySelector('.notif-toast')?.textContent ?? '').toMatch(/720p60|quality/i)

    // ...but the persisted choice survived (pre-fix it was overwritten with
    // 'best' by settings.setQualityFor).
    expect(settings.getQualityFor('chan6')).toBe('720p60')
    expect(localStorage.getItem('app-quality:chan6')).toBe('720p60')
  }, 20000)
})
