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
  // offline (no sockets, no emote fetches). Constructed channels are recorded
  // so the merge test can assert a headless session spawns for a chat-only
  // member (a channel with no tile).
  const constructed: string[] = []
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
    dispose(): void {}
  }
  return { ChatSession, __constructed: constructed }
})

if (!('ResizeObserver' in globalThis)) {
  globalThis.ResizeObserver = class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  } as unknown as typeof ResizeObserver
}

const MultiView = (await import('./MultiView.svelte')).default
// The mocked ChatSession's constructed-channel log (extra export the mock
// factory adds; the real module has none).
const chatMock = (await import('./chat-session.svelte')) as unknown as { __constructed: string[] }
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

let view: ReturnType<typeof mount> | null = null
afterEach(() => {
  if (view) void unmount(view)
  view = null
  tileStore.exitAll()
  settings.setMpvEngine(false)
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
})
