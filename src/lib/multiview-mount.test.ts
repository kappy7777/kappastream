// MultiView MOUNT regression test. Pins the 2026-09-17 freeze: a tile-layout
// version was bumped with `version++` inside a `$effect` — the increment
// READ the state it wrote, the effect re-triggered itself past Svelte's
// update-depth limit at mount, and the uncaught error killed MultiView's
// effect tree (mpv tiles never pushed their surface rect → audio without
// picture; hls tiles stuck loading; the grid unresponsive). Mounting the
// component and adding tiles in BOTH engine modes must settle cleanly —
// any read-write-same-state effect loop hangs the awaits (vitest timeout)
// or surfaces as an uncaught `effect_update_depth_exceeded`.
import { describe, it, vi, expect, afterEach } from 'vitest'
import { mount, unmount } from 'svelte'
import { tileStore } from './tile-store.svelte'
import { settings } from './settings.svelte.ts'
import { invoke } from '@tauri-apps/api/core'

vi.mock('@tauri-apps/api/core', () => ({
  // Shaped like a successful resolve_stream/mpv_load result — callers that
  // need other shapes never run their success paths here anyway.
  invoke: vi.fn(async () => ({ ok: true, url: 'https://example.invalid/x.m3u8' })),
  isTauri: () => false,
}))
vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(async () => () => {}),
  emit: vi.fn(async () => {}),
}))
vi.mock('./chat-session.svelte', () => {
  // Chat is not under test here — a no-op session keeps the mount cheap and
  // offline (no sockets, no emote fetches). Constructed + disposed channels
  // are recorded so the merge test can assert a headless session spawns for
  // a chat-only member (a channel with no tile) and the full-grid-replace
  // test can assert the session swap.
  const constructed: string[] = []
  const disposed: string[] = []
  class ChatSession {
    channel: string
    messages: unknown[] = []
    status = 'idle'
    emoteStatus = 'idle'
    roomState: Record<string, unknown> = {}
    badgeOverride = null
    thirdParty = new Map()
    constructor(channel: string) {
      this.channel = channel
      constructed.push(channel)
    }
    start(): void {}
    setHoldTrim(_hold: boolean): void {}
    dispose(): void {
      disposed.push(this.channel)
    }
  }
  return { ChatSession, __constructed: constructed, __disposed: disposed }
})

if (!('ResizeObserver' in globalThis)) {
  globalThis.ResizeObserver = class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  } as unknown as typeof ResizeObserver
}

const MultiView = (await import('./MultiView.svelte')).default
// The mocked ChatSession's constructed/disposed-channel logs (extra exports
// the mock factory adds; the real module has none).
const chatMock = (await import('./chat-session.svelte')) as unknown as {
  __constructed: string[]
  __disposed: string[]
}
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

let view: ReturnType<typeof mount> | null = null
afterEach(() => {
  if (view) void unmount(view)
  view = null
  tileStore.exitAll()
  settings.setMpvEngine(false)
  chatMock.__constructed.length = 0
  chatMock.__disposed.length = 0
  // A test may override the invoke mock (e.g. failing mpv_load); restore the
  // factory's permissive default so later tests start clean.
  vi.mocked(invoke).mockImplementation(async () => ({ ok: true, url: 'https://example.invalid/x.m3u8' }))
})

function mountView(mpvAvailable: boolean): void {
  const target = document.createElement('div')
  document.body.appendChild(target)
  view = mount(MultiView, {
    target,
    props: {
      isWindows: false,
      chatSize: 300,
      onAuthorityVideo: () => {},
      onAuthorityBackend: () => {},
      onAuthorityControls: () => {},
      mpvAvailable,
    },
  })
}

describe('MultiView mount (effect-loop regression)', () => {
  // The default timeouts are the assertion: a loop hangs them.
  it('hls mode: mount cold, then add two tiles without wedging', async () => {
    settings.setMpvEngine(false)
    mountView(false)
    await sleep(60)
    tileStore.addOrReplace('chan1', 'best', 1)
    await sleep(120)
    expect(tileStore.count).toBe(1)
    tileStore.addOrReplace('chan2', 'best', 1)
    await sleep(200)
    expect(tileStore.count).toBe(2)
  })

  it('mpv mode: mount cold, then add two tiles without wedging', async () => {
    settings.setMpvEngine(true)
    mountView(true)
    await sleep(60)
    tileStore.addOrReplace('chan1', 'best', 1)
    await sleep(120)
    expect(tileStore.count).toBe(1)
    tileStore.addOrReplace('chan2', 'best', 1)
    await sleep(200)
    expect(tileStore.count).toBe(2)
  })

  // The mpv id allocator must react to tiles added AFTER mount (the store
  // pushes in place — a $state property read alone never fires). When it
  // didn't, every post-mount tile found mpvEnabled=false and silently fell
  // back to hls.js — the "second stream opens in hls" regression. Pinned by
  // asserting each added tile's attach goes through mpv_load with a fresh
  // engine id (1..4, never reused while its tile lives).
  it('mpv mode: every tile added after mount gets its own engine id', async () => {
    settings.setMpvEngine(true)
    mountView(true)
    await sleep(60)
    const loads = (): Map<number, number> => {
      const seen = new Map<number, number>()
      for (const call of vi.mocked(invoke).mock.calls) {
        if (call[0] !== 'mpv_load') continue
        const id = (call[1] as { id?: number }).id ?? 0
        seen.set(id, (seen.get(id) ?? 0) + 1)
      }
      return seen
    }
    tileStore.addOrReplace('chan1', 'best', 1)
    await sleep(150)
    tileStore.addOrReplace('chan2', 'best', 1)
    await sleep(150)
    tileStore.addOrReplace('chan3', 'best', 1)
    await sleep(250)
    const seen = loads()
    // Three distinct engine ids, one load each (plus engine... none extra —
    // the single player is idle in multiview).
    const distinct = [...seen.keys()].filter((id) => seen.get(id) === 1)
    expect(distinct.length).toBe(3)
    expect(Math.min(...distinct)).toBeGreaterThanOrEqual(1)
    expect(Math.max(...distinct)).toBeLessThanOrEqual(4)
    expect(tileStore.count).toBe(3)
  })

  // The merge picker's input joins a chat WITHOUT a tile: the typed channel
  // gets a headless session (the mocked ChatSession), appears as a member
  // row, and the merged tab covers both members — all without wedging the
  // effect tree.
  it('merge picker: a typed channel joins the merge with no tile of its own', async () => {
    settings.setMpvEngine(false)
    mountView(false)
    await sleep(60)
    tileStore.addOrReplace('chan1', 'best', 1)
    tileStore.addOrReplace('chan2', 'best', 1)
    await sleep(200)
    expect(tileStore.count).toBe(2)

    // Open the picker and tick the first tile (the pending member).
    document.querySelector<HTMLButtonElement>('.mv-merge-btn')!.click()
    await sleep(30)
    const panel = document.querySelector<HTMLElement>('.mv-merge-panel')!
    expect(panel).toBeTruthy()
    panel.querySelector<HTMLButtonElement>('.mv-merge-row')!.click()
    await sleep(30)

    // Submit a chat-only channel through the input.
    const input = panel.querySelector<HTMLInputElement>('.mv-merge-add-input')!
    input.value = 'chan9'
    input.dispatchEvent(new Event('input'))
    panel.querySelector<HTMLFormElement>('.mv-merge-add')!.dispatchEvent(new Event('submit', { bubbles: true }))
    await sleep(80)

    // The channel spawned a headless session, is listed as a member, and the
    // merged tab names both members (tile first, chat-only after).
    expect(chatMock.__constructed.filter((c) => c === 'chan9')).toEqual(['chan9'])
    const names = [...document.querySelectorAll('.mv-merge-panel .mv-merge-name')].map((el) => el.textContent)
    expect(names).toContain('chan9')
    const tab = document.querySelector<HTMLButtonElement>('.mv-chat-tab')!
    expect(tab.getAttribute('title')).toBe('chan1, chan9')
  })

  // A full grid replaces a tile by rewriting its channel IN PLACE (same tile
  // id — see addOrReplace). The session reconcile used to read tile.channel
  // under untrack, so the replace never re-ran it: the tab named after the
  // NEW channel kept the OLD channel's chat (socket, pins, modes) until an
  // unrelated tile change. The channels are tracked reads now, so the
  // replace must connect a session for the new channel and dispose the old
  // one's.
  it('full-grid replace swaps the chat session for the new channel', async () => {
    settings.setMpvEngine(false)
    mountView(false)
    await sleep(60)
    for (const c of ['chan1', 'chan2', 'chan3', 'chan4']) tileStore.addOrReplace(c, 'best', 1)
    await sleep(200)
    expect(chatMock.__constructed).toEqual(['chan1', 'chan2', 'chan3', 'chan4'])
    expect(chatMock.__disposed).toEqual([])

    // The 5th open rewrites the AUTHORITY tile (chan4 after four adds).
    tileStore.addOrReplace('chan5', 'best', 1)
    await sleep(120)
    expect(chatMock.__constructed).toEqual(['chan1', 'chan2', 'chan3', 'chan4', 'chan5'])
    expect(chatMock.__disposed).toEqual(['chan4'])
    expect(tileStore.count).toBe(4)
  })

  // A native tile whose surface is NOT up — an mpv_load that fails and falls
  // back to hls.js, an offline/error resolve, a mid-stream engine error —
  // has no mpv OSC to fall back on. Gating the HTML bar on mpvEnabled alone
  // left those tiles with NO controls (uncloseable, unmutable); it must be
  // gated on the surface actually showing instead.
  it('mpv mode: a tile without a live native surface keeps the HTML controls', async () => {
    settings.setMpvEngine(true)
    mountView(true)
    await sleep(60)
    // Tile 1: the native load fails → the tile falls back to the page
    // player path and the HTML bar must render. (A failed mpv_load is a
    // REJECTED invoke — a resolved one is always a success.)
    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      if (cmd === 'mpv_load') throw new Error('engine unavailable')
      return { ok: true, url: 'https://example.invalid/x.m3u8' }
    })
    tileStore.addOrReplace('chan1', 'best', 1)
    await sleep(250)
    const tiles = () => [...document.querySelectorAll('[data-tile-id]')]
    expect(tiles().length).toBe(1)
    expect(tiles()[0]!.querySelector('.mv-tile-controls')).toBeTruthy()
    expect(tiles()[0]!.querySelector('.mv-close')).toBeTruthy()

    // Tile 2: the engine loads fine → the surface is up, the mpv OSC owns
    // the tile, and the HTML bar stays out of the way.
    vi.mocked(invoke).mockImplementation(async () => ({ ok: true, url: 'https://example.invalid/x.m3u8' }))
    tileStore.addOrReplace('chan2', 'best', 1)
    await sleep(250)
    expect(tiles().length).toBe(2)
    expect(tiles()[1]!.querySelector('.mv-tile-controls')).toBeNull()
    // The fallback tile keeps its bar.
    expect(tiles()[0]!.querySelector('.mv-tile-controls')).toBeTruthy()
  })

  // Held-move clicks feed the OSC's drag synthesis — but ONLY while a press
  // that started on the tile is held. A splitter or drag-handle press
  // crossing a native tile used to forward a click per move, and the OSC
  // activates the button under any forwarded click (even from its hidden
  // state), so resizing the grid could close or pause a tile.
  it('mpv mode: held moves without an on-tile press forward no OSC clicks', async () => {
    settings.setMpvEngine(true)
    mountView(true)
    await sleep(60)
    tileStore.addOrReplace('chan1', 'best', 1)
    await sleep(250)
    const stage = document.querySelector<HTMLElement>('.mv-video-area')
    expect(stage).toBeTruthy()
    // happy-dom lays out nothing — stub a real rect so the forwarder's
    // fraction math runs.
    stage!.getBoundingClientRect = () =>
      ({ x: 0, y: 0, left: 0, top: 0, width: 400, height: 300, right: 400, bottom: 300 }) as DOMRect
    const PE: new (type: string, init?: MouseEventInit) => PointerEvent = ((
      globalThis as { PointerEvent?: typeof MouseEvent }
    ).PointerEvent ?? MouseEvent) as new (type: string, init?: MouseEventInit) => PointerEvent
    const clicks = (): number =>
      vi
        .mocked(invoke)
        .mock.calls.filter((c) => c[0] === 'mpv_pointer' && (c[1] as { kind?: string } | undefined)?.kind === 'click')
        .length
    const move = (x: number, y: number): void => {
      stage!.dispatchEvent(new PE('pointermove', { buttons: 1, clientX: x, clientY: y }))
    }

    // A splitter-style drag: button held, but the press started elsewhere.
    move(390, 290)
    await sleep(80)
    expect(clicks()).toBe(0)

    // A press on the tile itself forwards its down click and held moves.
    stage!.dispatchEvent(new PE('pointerdown', { button: 0, buttons: 1, clientX: 200, clientY: 150 }))
    await sleep(80)
    expect(clicks()).toBe(1)
    move(210, 150)
    await sleep(80)
    expect(clicks()).toBe(2)
  })
})

// Chat-only merge members must not outlive the grid: the exitAll paths
// (sleep timer, hide-to-tray) keep multi-view mounted with an EMPTY grid,
// where the merge picker no longer renders (it needs a tile) — headless
// IRC sockets would camp there with no way to see or remove them.
it('exitAll disposes chat-only members and drops the merged tab', async () => {
  settings.setMpvEngine(false)
  mountView(false)
  await sleep(60)
  tileStore.addOrReplace('chan1', 'best', 1)
  tileStore.addOrReplace('chan2', 'best', 1)
  await sleep(200)

  // Form a group of one tile + two chat-only members via the picker.
  document.querySelector<HTMLButtonElement>('.mv-merge-btn')!.click()
  await sleep(30)
  const panel = document.querySelector<HTMLElement>('.mv-merge-panel')!
  panel.querySelector<HTMLButtonElement>('.mv-merge-row')!.click() // chan1
  await sleep(30)
  for (const name of ['chan9', 'chan10']) {
    const input = panel.querySelector<HTMLInputElement>('.mv-merge-add-input')!
    input.value = name
    input.dispatchEvent(new Event('input'))
    panel.querySelector<HTMLFormElement>('.mv-merge-add')!.dispatchEvent(new Event('submit', { bubbles: true }))
    await sleep(60)
  }
  expect(chatMock.__constructed).toEqual(expect.arrayContaining(['chan9', 'chan10']))
  expect(chatMock.__disposed).toEqual([])

  // Wholesale teardown (what the sleep timer / hide-to-tray paths run).
  tileStore.exitAll()
  await sleep(120)
  expect(chatMock.__disposed).toEqual(expect.arrayContaining(['chan1', 'chan2', 'chan9', 'chan10']))
  // The merged tab (and every tile tab) is gone over the empty grid.
  expect(document.querySelector('.mv-chat-tab')).toBeNull()
})

// Opening a chat-only member's channel as a tile ADOPTS its headless
// session (scrollback + connection survive the migration to the tile id);
// the one-flush gap before mergedIds migrates must not spawn a SECOND
// connection to the channel.
it('opening a chat-only member as a tile adopts its session without reconnecting', async () => {
  settings.setMpvEngine(false)
  mountView(false)
  await sleep(60)
  tileStore.addOrReplace('chan1', 'best', 1)
  tileStore.addOrReplace('chan2', 'best', 1)
  await sleep(200)

  document.querySelector<HTMLButtonElement>('.mv-merge-btn')!.click()
  await sleep(30)
  const panel = document.querySelector<HTMLElement>('.mv-merge-panel')!
  panel.querySelector<HTMLButtonElement>('.mv-merge-row')!.click() // chan1 (pending)
  await sleep(30)
  const input = panel.querySelector<HTMLInputElement>('.mv-merge-add-input')!
  input.value = 'chan9'
  input.dispatchEvent(new Event('input'))
  panel.querySelector<HTMLFormElement>('.mv-merge-add')!.dispatchEvent(new Event('submit', { bubbles: true }))
  await sleep(80)
  expect(chatMock.__constructed.filter((c) => c === 'chan9')).toEqual(['chan9'])

  // Open chan9 as a tile: its session moves to the tile, no reconnect.
  tileStore.addOrReplace('chan9', 'best', 1)
  await sleep(150)
  expect(chatMock.__constructed.filter((c) => c === 'chan9')).toEqual(['chan9'])
  expect(chatMock.__disposed).toEqual([])
  expect(tileStore.count).toBe(3)
})
