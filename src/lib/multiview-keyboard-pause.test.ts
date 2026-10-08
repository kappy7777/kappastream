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
      case 'streamlink_status':
        return STREAMLINK_STATUS_OK
      case 'stream_qualities':
        return []
      case 'gql_fetch': {
        // The real transport returns a JSON STRING (gqlRequest JSON.parses).
        const body = typeof args?.body === 'string' ? args.body : ''
        if (body.includes('users(logins:')) {
          return JSON.stringify({
            data: {
              users: ['chan1', 'chan2', 'chan3', 'chan4'].map((login, i) => ({
                id: String(100 + i),
                login,
                profileImageURL: 'a',
                followers: { totalCount: 1 },
                stream: null,
              })),
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
// shortcuts entirely. Four favorites — the keyboard-target test needs a grid
// that grows past one tile.
localStorage.setItem('app-last-seen-version-v1', '99.0.0')
localStorage.setItem(
  'twitch-favorites-v1',
  JSON.stringify(['chan1', 'chan2', 'chan3', 'chan4'].map((name, i) => ({ name, addedAt: i + 1, order: i + 1 }))),
)

const App = (await import('../App.svelte')).default
const { tileStore } = await import('./tile-store.svelte')
const { settings } = await import('./settings.svelte.ts')
const { sleepTimer } = await import('./sleep-timer.svelte')

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
  sleepTimer.cancel()
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

// Pins the authority-handle registry in MultiView: every Tile used to write
// App's three shared shortcut slots, and each non-authority tile's report
// nulled them — so K/space/F/arrows went dead the moment a SECOND tile
// opened and only came back when authority landed on the LAST tile in grid
// order. Tiles now report per tile id and MultiView forwards the authority's
// set, so the shortcut must work at every grid size.
describe('multi-view keyboard target survives sibling tiles', () => {
  function fireManifestParsed(): void {
    for (const inst of hlsMock.instances) {
      for (const call of inst.on.mock.calls) {
        if (call[0] === 'hlsManifestParsed') (call[1] as (e: unknown, d: unknown) => void)(undefined, {})
      }
    }
  }

  it('K pauses the authority tile with 1, 2 and 4 tiles open', async () => {
    const target = document.createElement('div')
    document.body.appendChild(target)
    view = mount(App, { target })
    await sleep(150)

    q('button[aria-label="Multi-stream view"]').click()
    await sleep(80)
    // Re-query every iteration: the favorites poll re-renders the sidebar,
    // and a click on a stale detached node never reaches Svelte's delegated
    // handler.
    const favs = (): HTMLButtonElement[] => [...document.querySelectorAll<HTMLButtonElement>('.fav')]
    expect(favs().length).toBe(4)

    let favIndex = 0
    for (const count of [1, 2, 4]) {
      // Open favorites one by one until the grid holds `count` tiles.
      while (document.querySelectorAll('[data-tile-id]').length < count && favIndex < 4) {
        favs()[favIndex++]?.click()
        await sleep(300)
      }
      fireManifestParsed()
      await sleep(150)
      expect(document.querySelectorAll('[data-tile-id]').length).toBe(count)

      // The newly opened tile is the authority; its video must be playing.
      const video = document.querySelector<HTMLVideoElement>('.mv-tile--authority video')
      expect(video).toBeTruthy()
      expect(video!.paused).toBe(false)

      // The shortcut targets the AUDIO AUTHORITY only: every OTHER tile's
      // video must keep playing through the pause (and never re-play()).
      const others = [...document.querySelectorAll<HTMLVideoElement>('[data-tile-id] video')].filter((v) => v !== video)
      const playsBefore = others.map((v) => playCalls.get(v) ?? 0)
      for (const v of others) expect(v.paused).toBe(false)

      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', bubbles: true }))
      await sleep(50)
      expect(video!.paused).toBe(true)
      for (const v of others) expect(v.paused).toBe(false)
      expect(others.map((v) => playCalls.get(v) ?? 0)).toEqual(playsBefore)

      // Resume so the next iteration starts from a playing grid.
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', bubbles: true }))
      await sleep(50)
      expect(video!.paused).toBe(false)
    }
  }, 30000)
})

// Search-box Enter funnels through App.openChannel, which now normalizes and
// validates in BOTH views: the multi-view branch used to skip connect()'s
// validation and open raw typed text (empty, `#Chan2 `, `a,b`) as a tile.
describe('multi-view search Enter validates the channel name', () => {
  function typeAndEnter(text: string): void {
    const input = q('.channel-input') as HTMLInputElement
    input.value = text
    input.dispatchEvent(new Event('input', { bubbles: true }))
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
  }

  it('normalizes a typed name into a tile and refuses invalid input with a toast', async () => {
    const target = document.createElement('div')
    document.body.appendChild(target)
    view = mount(App, { target })
    await sleep(150)

    q('button[aria-label="Multi-stream view"]').click()
    await sleep(80)

    typeAndEnter(' #Chan2 ')
    await sleep(300)
    let tiles = [...document.querySelectorAll('[data-tile-id]')]
    expect(tiles.map((el) => el.getAttribute('aria-label'))).toEqual(['chan2'])

    // Invalid text never becomes a tile; the shared invalid-name toast shows.
    typeAndEnter('chan3,chan4')
    await sleep(120)
    tiles = [...document.querySelectorAll('[data-tile-id]')]
    expect(tiles.length).toBe(1)
    expect(document.querySelector('.notif-toast')?.textContent).toBeTruthy()

    // Whitespace-only Enter is a plain no-op.
    typeAndEnter('   ')
    await sleep(120)
    expect(document.querySelectorAll('[data-tile-id]').length).toBe(1)
  }, 20000)
})

// Pins the sleep-timer arming paths: the cancel-on-idle $effect used to read
// the timer's own `armed` state through cancel(), so ARMING re-ran the
// effect, saw 'idle' and cancelled the fresh timer — the sleep timer could
// never be armed in multi-view (the single player is idle there by design),
// and arming single-view-idle failed just as silently. Arming is now
// refused with a toast when nothing plays (single view) and stays armed in
// multi-view.
describe('sleep timer arming', () => {
  async function openSleepPresets(): Promise<HTMLButtonElement> {
    q('button[aria-label="Settings"]').click()
    await sleep(60)
    // Playback is the 4th nav section (general, appearance, chat, playback).
    const nav = [...document.querySelectorAll<HTMLButtonElement>('.settings-nav-item')]
    nav[3]!.click()
    await sleep(60)
    const preset = [...document.querySelectorAll<HTMLButtonElement>('.seg .seg-btn')].find(
      (b) => b.textContent === '15m',
    )
    if (!preset) throw new Error('sleep preset button not found')
    return preset
  }

  it('refuses to arm with nothing playing (toast) and stays armed in multi-view', async () => {
    const target = document.createElement('div')
    document.body.appendChild(target)
    view = mount(App, { target })
    await sleep(150)

    // Single view, nothing playing: refused, with the why toast.
    ;(await openSleepPresets()).click()
    await sleep(100)
    expect(sleepTimer.armed).toBe(false)
    expect(document.querySelector('.notif-toast')?.textContent).toBeTruthy()

    // Multi-view: arming targets the tile grid and must stick.
    q('.settings-close').click()
    await sleep(50)
    q('button[aria-label="Multi-stream view"]').click()
    await sleep(80)
    ;(await openSleepPresets()).click()
    await sleep(150)
    expect(sleepTimer.armed).toBe(true)
    sleepTimer.cancel()
  }, 20000)
})
