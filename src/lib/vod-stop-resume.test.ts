// Pins the idle overlay's Resume button during VOD/clip playback. The
// overlay appears in VOD/clip mode after a sleep-timer stop (which keeps
// `playback` in its VOD/clip kind while the player goes idle). Resume used
// to call loadStream unconditionally, so the LIVE stream played under the
// still-VOD UI (badge, title, scrubber) and the timeupdate handler kept
// saving the live playhead under the VOD id, overwriting its saved resume
// position. Resume now replays what was interrupted: playVod/playClip, live
// only for live.
//
// Also pins the two control postures around VOD/clip playback: PiP takes a
// VOD over with a position handoff (main stops; the floating window's last
// position on close becomes the checkpoint main resumes from), and the
// external-mpv handoff button is live-only.
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
const { sleepTimer } = await import('./sleep-timer.svelte.ts')
const { pipController } = await import('./pip-controller.svelte.ts')
const { STORAGE_KEYS } = await import('./storage-keys')
const { vodPositions } = await import('./vod-positions.svelte.ts')

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

function mpvButton(): HTMLButtonElement | null {
  return document.querySelector<HTMLButtonElement>(`button[aria-label="${t('pc_mpv')}"]`)
}

/** Stop playback the way the sleep timer does on a VOD/clip (minutes=0 fires
 *  on the next macrotask): the ONLY remaining path that leaves the idle
 *  overlay + Resume button under the still-VOD/clip UI. */
async function fireSleepTimer(kind: 'vod' | 'clip'): Promise<void> {
  sleepTimer.arm({ channel: 'chan2', playbackKind: kind }, 0)
  await sleep(120)
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
  sleepTimer.cancel()
  pipController.isOpen = false
  pipController.closedMedia = null
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
    // Live playing: both floating-window controls are offered.
    expect(pipButton()).toBeTruthy()
    expect(mpvButton()).toBeTruthy()

    // Open the channel's VOD.
    ;(await cardByTitle('Some VOD')).click()
    await sleep(250)
    emitManifestParsed()
    await sleep(120)
    expect(calls.resolveVod).toBe(1)
    // THE CONTROL PINS: PiP is offered during a VOD (position handoff); the
    // external-mpv handoff is live-only and must be gone.
    expect(pipButton()).toBeTruthy()
    expect(mpvButton()).toBeNull()

    // The sleep timer stops the VOD — the idle overlay (with Resume)
    // appears while the UI stays in VOD mode.
    await fireSleepTimer('vod')
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

    await fireSleepTimer('clip')
    ;(q('.overlay-action') as HTMLButtonElement).click()
    await sleep(300)
    expect(calls.resolveClip).toBe(2)
    expect(calls.resolveStream).toBe(1)
  }, 20000)
})

describe('PiP takeover during VOD playback (position handoff)', () => {
  it('stops the main player and restores the VOD at the floating window position on close', async () => {
    view = await mountApp()
    ;(await cardByTitle('Some VOD')).click()
    await sleep(250)
    emitManifestParsed()
    await sleep(120)
    expect(calls.resolveVod).toBe(1)

    // Simulate the floating window opening (the window-creation side of
    // pipController is not under test here — only the main-player takeover).
    pipController.isOpen = true
    await sleep(120)
    // Main stopped: the PiP-active overlay shows, no Resume button while
    // PiP owns the player.
    expect(q('.overlay-title').textContent).toBe(t('player_pipActive'))
    expect(document.querySelector('.overlay-action')).toBeNull()
    expect(calls.resolveVod).toBe(1)

    // Simulate the window closing with its last reported position.
    pipController.closedMedia = { position: 123, duration: 3600 }
    pipController.isOpen = false
    await sleep(400)
    // THE HANDOFF PIN: the VOD is re-resolved (not live) and the floating
    // window's position landed as the resume checkpoint.
    expect(calls.resolveVod).toBe(2)
    expect(calls.resolveStream).toBe(1)
    const saved = vodPositions.get('v1')
    expect(saved?.position).toBe(123)
    expect(saved?.duration).toBe(3600)
    // The checkpoint is live in storage too (resume survives a restart).
    expect(JSON.parse(localStorage.getItem(STORAGE_KEYS.vodPositions) ?? '{}')).toHaveProperty('v1')
  }, 20000)
})
