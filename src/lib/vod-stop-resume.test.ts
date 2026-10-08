// Pins the idle overlay's Resume button during VOD/clip playback. The
// overlay appears in VOD/clip mode after "Play in mpv" or a sleep-timer
// stop (both keep `playback` in its VOD/clip kind while the player goes
// idle). Resume used to call loadStream unconditionally, so the LIVE
// stream played under the still-VOD UI (badge, title, scrubber) and the
// timeupdate handler kept saving the live playhead under the VOD id,
// overwriting its saved resume position. Resume now replays what was
// interrupted: playVod/playClip, live only for live.
//
// Also pins the PiP control's live-only gating in the same mounted
// scenario: the floating PiP window receives a bare URL with no position
// handoff, so the control must stay hidden while a VOD/clip plays.
import { describe, it, expect, vi, afterEach } from 'vitest'
import { mount, unmount } from 'svelte'

const calls = vi.hoisted(() => ({
  resolveStream: 0,
  resolveVod: 0,
  resolveClip: 0,
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
        calls.resolveVod++
        return { ok: true, url: 'https://cdn.example.invalid/vod.m3u8' }
      case 'resolve_clip':
        calls.resolveClip++
        return { ok: true, url: 'https://cdn.example.invalid/clip.mp4' }
      case 'launch_player':
        return { ok: true }
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
          const edges = [
            {
              node: {
                id: 'c1',
                slug: 'clip-one',
                title: 'Some Clip',
                durationSeconds: 30,
                viewCount: 2,
                createdAt: '2026-01-02T00:00:00Z',
                thumbnailURL: '',
                game: { displayName: 'g' },
                curator: { login: 'someone' },
              },
            },
          ]
          return JSON.stringify({ data: { user: { clips: { edges } } } })
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
// The channel's VOD/clip lists load as soon as ChannelContent's sentinel
// reports intersecting (what scrolling it into view does).
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
const { t } = await import('./i18n/index.svelte')

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

function q(sel: string): HTMLElement {
  const el = document.querySelector(sel)
  if (!el) throw new Error('missing element: ' + sel)
  return el as HTMLElement
}

function lastInstance(): (typeof hlsMock)['instances'][number] {
  const inst = hlsMock.instances[hlsMock.instances.length - 1]
  if (!inst) throw new Error('no FakeHls instance was created')
  return inst
}

function emitManifestParsed(): void {
  const inst = lastInstance()
  for (const call of inst.on.mock.calls) {
    if (call[0] === 'hlsManifestParsed') (call[1] as (e: unknown, d: unknown) => void)(undefined, {})
  }
}

async function cardByTitle(title: string): Promise<HTMLButtonElement> {
  for (let i = 0; i < 40; i++) {
    const el = [...document.querySelectorAll<HTMLButtonElement>('.cc-card')].find((c) => c.textContent?.includes(title))
    if (el) return el
    await sleep(50)
  }
  throw new Error('no card titled: ' + title)
}

function pipButton(): HTMLButtonElement | null {
  return document.querySelector<HTMLButtonElement>(`button[aria-label="${t('pc_pip')}"]`)
}

function mpvButton(): HTMLButtonElement {
  const el = document.querySelector<HTMLButtonElement>(`button[aria-label="${t('pc_mpv')}"]`)
  if (!el) throw new Error('missing mpv handoff button')
  return el
}

async function mountApp(): Promise<ReturnType<typeof mount>> {
  localStorage.setItem('app-last-seen-version-v1', '99.0.0')
  const target = document.createElement('div')
  document.body.appendChild(target)
  const view = mount(App, { target })
  await sleep(150)
  // Join the favorite → the live stream resolves + attaches.
  q('.fav').click()
  await sleep(300)
  emitManifestParsed()
  await sleep(120)
  return view
}

let view: ReturnType<typeof mount> | null = null

afterEach(() => {
  if (view) void unmount(view)
  view = null
  settings.setMpvEngine(false)
  localStorage.clear()
  localStorage.setItem('twitch-favorites-v1', JSON.stringify([{ name: 'chan2', addedAt: 1, order: 1 }]))
  hlsMock.instances.length = 0
  calls.resolveStream = 0
  calls.resolveVod = 0
  calls.resolveClip = 0
})

describe('idle overlay Resume during VOD playback', () => {
  it('replays the VOD instead of loading the live stream', async () => {
    view = await mountApp()
    expect(calls.resolveStream).toBe(1)
    // Live playing: the PiP control is offered.
    expect(pipButton()).toBeTruthy()

    // Open the channel's VOD.
    ;(await cardByTitle('Some VOD')).click()
    await sleep(250)
    emitManifestParsed()
    await sleep(120)
    expect(calls.resolveVod).toBe(1)
    // THE PiP PIN: controls are visible over the playing VOD, but the PiP
    // button must not be among them (live-only control).
    expect(pipButton()).toBeNull()
    expect(mpvButton()).toBeTruthy()

    // "Play in mpv" hands the VOD off and stops the in-app player — the
    // idle overlay (with Resume) appears while the UI stays in VOD mode.
    mpvButton().click()
    await sleep(150)
    expect(document.querySelector('.overlay-action')).toBeTruthy()

    // THE RESUME PIN: Replay must re-resolve the VOD, never the live stream.
    ;(q('.overlay-action') as HTMLButtonElement).click()
    await sleep(300)
    expect(calls.resolveVod).toBe(2)
    expect(calls.resolveStream).toBe(1)
  }, 20000)

  it('replays a clip instead of loading the live stream', async () => {
    view = await mountApp()
    ;(await cardByTitle('Some Clip')).click()
    await sleep(300)
    expect(calls.resolveClip).toBe(1)

    mpvButton().click()
    await sleep(150)
    ;(q('.overlay-action') as HTMLButtonElement).click()
    await sleep(300)
    expect(calls.resolveClip).toBe(2)
    expect(calls.resolveStream).toBe(1)
  }, 20000)
})
