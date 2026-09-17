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
  // offline (no sockets, no emote fetches).
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
    }
    start(): void {}
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

const MultiView = (await import('./MultiView.svelte')).default
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
})
