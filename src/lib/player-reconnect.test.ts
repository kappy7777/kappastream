// Pins the IRC-reconnect unmount bug: `playerActive` used to be derived from
// the chat socket status, so a reconnect drop (status 'connecting') unmounted
// the single-view <video> — WebKit pauses detached media, and the reconnect
// path deliberately never restarts the stream, leaving a black player with
// live controls and no error overlay. The render gate now hangs off the
// joined channel instead; this test fails if the video element is ever
// destroyed again while the channel stays joined.
import { describe, it, expect, vi, afterEach } from 'vitest'
import { mount, unmount } from 'svelte'

const chatMock = vi.hoisted(() => ({
  dropAfterConnect: false,
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
  invoke: vi.fn(async (cmd: string) => {
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
      case 'gql_fetch':
        return { data: { users: [] } }
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
  // Universal no-op window handle: every method returns a promise; the
  // event-subscription style methods resolve to an unlisten fn.
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
  // The stub's status is a real $state rune, so the reconnect drop is seen
  // by App's `status` derived — a plain mock class could never trigger the
  // re-render this test exists to pin.
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
// happy-dom's media element methods are inert stubs; the playback path needs
// play() to resolve (autoplay promise → onPlayed → status promotion).
HTMLMediaElement.prototype.play = function (): Promise<void> {
  return Promise.resolve()
}
HTMLMediaElement.prototype.pause = function (): void {}
HTMLMediaElement.prototype.load = function (): void {}

const App = (await import('../App.svelte')).default
const { settings } = await import('./settings.svelte.ts')
const { chatStubControl, chatStubSessions } = await import('./chat-session-test-stub.svelte.ts')

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

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

function q(sel: string): HTMLElement {
  const el = document.querySelector(sel)
  if (!el) throw new Error('missing element: ' + sel)
  return el as HTMLElement
}

let view: ReturnType<typeof mount> | null = null

afterEach(() => {
  if (view) void unmount(view)
  view = null
  chatStubControl.dropAfterConnect = false
  chatStubSessions.length = 0
  settings.setMpvEngine(false)
  localStorage.clear()
  hlsMock.instances.length = 0
})

describe('single-view player survives a chat reconnect drop', () => {
  it('the <video> element is not unmounted while the channel stays joined', async () => {
    chatStubControl.dropAfterConnect = true
    // Suppress the first-run welcome (a downgrade lastSeen never shows it).
    localStorage.setItem('app-last-seen-version-v1', '99.0.0')
    const target = document.createElement('div')
    document.body.appendChild(target)
    view = mount(App, { target })
    await sleep(150)

    // Join a channel through the sidebar (add favorite, then click the row).
    q('.add-fav-btn').click()
    await sleep(30)
    const input = q('.add-fav-input') as HTMLInputElement
    input.value = 'chan1'
    input.dispatchEvent(new Event('input', { bubbles: true }))
    await sleep(30)
    ;(q('.add-fav-submit') as HTMLButtonElement).click()
    await sleep(100)
    const rows = document.querySelectorAll<HTMLButtonElement>('.fav')
    expect(rows.length).toBe(1)
    rows[0]!.click()
    await sleep(250)

    const video = document.querySelector('video.video')
    expect(video).toBeTruthy()
    emitManifestParsed()
    await sleep(120)

    // The stub session has flipped to 'connecting' by now (reconnect drop).
    expect(chatStubSessions[chatStubSessions.length - 1]!.status).toBe('connecting')
    await sleep(80)

    // THE PIN: same element, still mounted, still exactly one video.
    expect(document.contains(video)).toBe(true)
    expect(document.querySelectorAll('video.video').length).toBe(1)
  }, 15000)
})
