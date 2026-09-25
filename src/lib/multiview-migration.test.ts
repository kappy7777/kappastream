// The MIGRATION repro: mount the real App.svelte, join a channel so the
// single-stream player reaches 'playing', then flip multi-view via the top-bar
// toggle — the one path the cold-mount pin (multiview-mount.test.ts) does not
// cover, and the path the owner's freeze reproduces on (toggle WITH a stream
// open; cold entry is fine).
//
// Pins the 2026-09-19 freeze: on this path App's pinned-chat effect targets
// null (multiView on → not live) while MultiView's targets the new tile's
// channel, and PinnedChatStore.setTarget/refresh performed TRACKED reads
// (settings.chatPinned, this.pins) synchronously inside those effects. Each
// App run wrote a fresh `pins = []` (a new array reference re-dirties its
// readers), re-running both effects until Svelte threw
// effect_update_depth_exceeded uncaught and killed the component's effect
// tree (stuck spinner, dead UI, streams playing on). The store now runs
// untracked; this test fails if the cascade ever comes back.
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

vi.mock('./chat-session.svelte', () => {
  // Chat is not under test — a no-op session keeps the app offline (no
  // sockets, no emote fetches). start() flips to connected and fires onOpen
  // like the real socket-open coupling; the player no longer hangs off it
  // (the stream starts in connect() itself), but nothing here depends on
  // that either way.
  class ChatSession {
    channel: string
    opts: { onOpen?: (isReconnect: boolean) => void }
    messages: unknown[] = []
    status = 'idle'
    emoteStatus = 'idle'
    roomState: Record<string, unknown> = {}
    badgeOverride = null
    thirdParty = new Map()
    constructor(channel: string, opts: { onOpen?: (isReconnect: boolean) => void } = {}) {
      this.channel = channel
      this.opts = opts
    }
    start(): void {
      this.status = 'connected'
      this.opts.onOpen?.(false)
    }
    dispose(): void {}
  }
  return { ChatSession }
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
const { tileStore } = await import('./tile-store.svelte')
const { settings } = await import('./settings.svelte.ts')

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
const uncaught: unknown[] = []
const onUncaught = (e: unknown): void => {
  uncaught.push(e)
}
process.on('uncaughtException', onUncaught)
process.on('unhandledRejection', onUncaught)

afterEach(() => {
  if (view) void unmount(view)
  view = null
  tileStore.exitAll()
  settings.setMpvEngine(false)
  localStorage.clear()
  hlsMock.instances.length = 0
})

describe('App → multi-view migration (effect-loop regression)', () => {
  it('join a stream to playing, toggle multi-view, tree stays alive', async () => {
    // Suppress the first-run welcome (a downgrade lastSeen never shows it).
    localStorage.setItem('app-last-seen-version-v1', '99.0.0')
    const target = document.createElement('div')
    document.body.appendChild(target)
    view = mount(App, { target })
    await sleep(150)

    // Add + join a favorite (Sidebar: open the add menu, type, submit, click).
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
    // The resolve + attach ran; the single-stream player is in the DOM.
    expect(document.querySelector('video.video')).toBeTruthy()
    emitManifestParsed()
    await sleep(120)

    // THE MIGRATION: toggle multi-view with the stream playing. The loop, when
    // present, throws uncaught inside the flush — captured below.
    q('button[aria-label="Multi-stream view"]').click()
    await sleep(600)

    // No effect loop may have killed the tree.
    expect(uncaught.filter((e) => e instanceof Error && e.message.includes('effect_update_depth_exceeded'))).toEqual([])

    // Liveness: a dead tree stops re-rendering — closing the only tile must
    // fire onShouldExit → App exits multi-view → MultiView unmounts.
    const tile = document.querySelector('[data-tile-id]')
    expect(tile).toBeTruthy()
    const id = tile!.getAttribute('data-tile-id')!
    tileStore.close(id)
    await sleep(400)
    expect(document.querySelector('[data-tile-id]')).toBeNull()
    expect(uncaught.filter((e) => e instanceof Error && e.message.includes('depth'))).toEqual([])
  }, 15000)
})
