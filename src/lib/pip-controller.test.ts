import { describe, it, expect, beforeEach, vi } from 'vitest'

/*
 * Unit tests for src/lib/pip-controller.svelte.ts.
 *
 * The Tauri event/window surface is the ONLY thing mocked (the favorites
 * suite's pattern): every emit is recorded, every listen handler is captured
 * so tests can drive the pip→main signals, and WebviewWindow creation is
 * counted. Each test re-imports the module (vi.resetModules) so the exported
 * singleton — whose constructor wires the listeners — starts clean.
 *
 * The load-bearing rule under test: BOTH emit paths that carry a stream to
 * the PiP window (ks://pip-stream from setStream, ks://pip-init from
 * sendInit) must normalize `isLive` and `mediaKind` IDENTICALLY. The flag
 * gates PiP's stall recovery — a `true` leaking onto a VOD would force-seek
 * it to its own end, silently. These two paths drift independently; a
 * regression on either must fail here, not in a user's floating window.
 */

const tauri = vi.hoisted(() => ({
  emitCalls: [] as { event: string; payload?: unknown }[],
  listeners: new Map<string, (e: { payload: unknown }) => void>(),
  tauriEnabled: true,
  windowsCreated: 0,
}))

vi.mock('@tauri-apps/api/core', () => ({
  isTauri: () => tauri.tauriEnabled,
}))
vi.mock('@tauri-apps/api/event', () => ({
  emit: (event: string, payload?: unknown) => {
    tauri.emitCalls.push({ event, payload })
    return Promise.resolve()
  },
  listen: (event: string, handler: (e: { payload: unknown }) => void) => {
    tauri.listeners.set(event, handler)
    return Promise.resolve(() => {
      tauri.listeners.delete(event)
    })
  },
}))
vi.mock('@tauri-apps/api/webviewWindow', () => ({
  WebviewWindow: class {
    once(_event: string, _cb: () => void): void {
      /* pip tests never trigger it */
    }
    constructor(_label: string, _opts: unknown) {
      tauri.windowsCreated++
    }
  },
}))

type PipMod = typeof import('./pip-controller.svelte')
let P: PipMod

const EV_INIT = 'ks://pip-init'
const EV_STREAM = 'ks://pip-stream'
const EV_READY = 'ks://pip-ready'
const EV_CLOSED = 'ks://pip-closed'
const EV_DO_CLOSE = 'ks://pip-do-close'

/** Let the constructor's void-listen() chain register its handlers. */
async function flush(): Promise<void> {
  await new Promise((r) => setTimeout(r, 0))
  await new Promise((r) => setTimeout(r, 0))
}

function payloadsOf(event: string): unknown[] {
  return tauri.emitCalls.filter((c) => c.event === event).map((c) => c.payload)
}

/** Fire the captured listener for an event the way Tauri would deliver it. */
function deliver(event: string, payload: unknown = undefined): void {
  const h = tauri.listeners.get(event)
  if (!h) throw new Error('no listener registered for ' + event)
  h({ payload })
}

beforeEach(async () => {
  vi.resetModules()
  localStorage.clear()
  tauri.emitCalls.length = 0
  tauri.listeners.clear()
  tauri.tauriEnabled = true
  tauri.windowsCreated = 0
  P = await import('./pip-controller.svelte')
  await flush()
})

describe('pip-controller: setStream → ks://pip-stream normalization', () => {
  async function openPip(): Promise<void> {
    P.pipController.setStream({ url: 'https://x/1.m3u8', channel: 'chan1', quality: 'best' })
    await P.pipController.toggle()
  }

  it('emits isLive: true when the stream info says live', async () => {
    await openPip()
    P.pipController.setStream({ url: 'https://x/2.m3u8', channel: 'chan1', quality: 'best', isLive: true })
    expect(payloadsOf(EV_STREAM)).toEqual([{ url: 'https://x/2.m3u8', mediaKind: 'hls', isLive: true }])
  })

  it('emits isLive: false for an explicit false', async () => {
    await openPip()
    P.pipController.setStream({ url: 'https://x/2.m3u8', channel: 'chan1', quality: 'best', isLive: false })
    expect(payloadsOf(EV_STREAM)).toEqual([{ url: 'https://x/2.m3u8', mediaKind: 'hls', isLive: false }])
  })

  it('emits isLive: false when the field is ABSENT (the VOD-in-PiP safety default)', async () => {
    await openPip()
    P.pipController.setStream({ url: 'https://x/2.m3u8', channel: 'chan1', quality: 'best' })
    expect(payloadsOf(EV_STREAM)).toEqual([{ url: 'https://x/2.m3u8', mediaKind: 'hls', isLive: false }])
  })

  it('defaults mediaKind to hls and passes mp4 through', async () => {
    await openPip()
    P.pipController.setStream({ url: 'https://x/a.m3u8', channel: 'chan1', quality: 'best' })
    P.pipController.setStream({ url: 'https://x/b.mp4', channel: 'chan1', quality: 'best', mediaKind: 'mp4' })
    expect(payloadsOf(EV_STREAM)).toEqual([
      { url: 'https://x/a.m3u8', mediaKind: 'hls', isLive: false },
      { url: 'https://x/b.mp4', mediaKind: 'mp4', isLive: false },
    ])
  })
})

describe('pip-controller: sendInit → ks://pip-init normalization', () => {
  // The init payload is built from the STORED currentStream — this is the
  // path taken when PiP opens against an already-playing stream, and it
  // must normalize exactly like setStream's emit or the two paths drift.
  function initPayloadAfter(info: Parameters<typeof P.pipController.setStream>[0]): Record<string, unknown> {
    P.pipController.setStream(info) // stored; PiP is closed so nothing emits
    expect(payloadsOf(EV_STREAM)).toEqual([])
    deliver(EV_READY)
    const payloads = payloadsOf(EV_INIT)
    expect(payloads).toHaveLength(1)
    return payloads[0] as Record<string, unknown>
  }

  it.each([
    ['true stays true', { isLive: true }, true],
    ['explicit false stays false', { isLive: false }, false],
    ['ABSENT becomes false (the safety default)', {}, false],
  ])('isLive: %s', (_name, extra, expected) => {
    const p = initPayloadAfter({ url: 'https://x/1.m3u8', channel: 'chan1', quality: 'best', ...extra })
    expect(p.isLive).toBe(expected)
  })

  it('carries url/channel/quality and defaults mediaKind to hls', () => {
    const p = initPayloadAfter({ url: 'https://x/1.m3u8', channel: 'chan1', quality: '720p' })
    expect(p.url).toBe('https://x/1.m3u8')
    expect(p.channel).toBe('chan1')
    expect(p.quality).toBe('720p')
    expect(p.mediaKind).toBe('hls')
  })

  it('passes an mp4 mediaKind through to the init payload', () => {
    const p = initPayloadAfter({ url: 'https://x/1.mp4', channel: 'chan1', quality: 'best', mediaKind: 'mp4' })
    expect(p.mediaKind).toBe('mp4')
    expect(p.isLive).toBe(false)
  })
})

describe('pip-controller: closed-PiP storage semantics', () => {
  it('setStream while PiP is CLOSED stores the stream but emits nothing', () => {
    P.pipController.setStream({ url: 'https://x/1.m3u8', channel: 'chan1', quality: 'best', isLive: true })
    expect(tauri.emitCalls).toEqual([])
    // …and the stored value is exactly what a later sendInit serves.
    deliver(EV_READY)
    const p = payloadsOf(EV_INIT)
    expect(p).toHaveLength(1)
    expect((p[0] as Record<string, unknown>).isLive).toBe(true)
  })

  it('opening PiP creates the window exactly once; a second toggle is a no-op', async () => {
    P.pipController.setStream({ url: 'https://x/1.m3u8', channel: 'chan1', quality: 'best' })
    await P.pipController.toggle()
    expect(P.pipController.isOpen).toBe(true)
    expect(tauri.windowsCreated).toBe(1)
    await P.pipController.toggle() // now a close request
    expect(tauri.windowsCreated).toBe(1)
    expect(payloadsOf(EV_DO_CLOSE)).toHaveLength(1)
  })
})

describe('pip-controller: clearStream + close lifecycle', () => {
  it('clearStream nulls currentStream and requests a close on an OPEN pip', async () => {
    P.pipController.setStream({ url: 'https://x/1.m3u8', channel: 'chan1', quality: 'best' })
    await P.pipController.toggle()
    expect(P.pipController.isOpen).toBe(true)

    P.pipController.clearStream()
    expect(payloadsOf(EV_DO_CLOSE)).toHaveLength(1)
    // currentStream is gone: a READY re-init now emits nothing at all.
    tauri.emitCalls.length = 0
    deliver(EV_READY)
    expect(tauri.emitCalls).toEqual([])

    // Let the pip window report closed (clears the close-fallback timer).
    deliver(EV_CLOSED, { rect: undefined })
    expect(P.pipController.isOpen).toBe(false)
  })

  it('clearStream on a CLOSED pip neither emits nor arms anything', () => {
    P.pipController.setStream({ url: 'https://x/1.m3u8', channel: 'chan1', quality: 'best' })
    P.pipController.clearStream()
    expect(tauri.emitCalls).toEqual([])
    expect(P.pipController.isOpen).toBe(false)
  })

  it('a ks://pip-closed report flips isOpen back and restores the main video audio', async () => {
    const el = document.createElement('video')
    P.pipController.setVideoElement(el)
    P.pipController.setStream({ url: 'https://x/1.m3u8', channel: 'chan1', quality: 'best' })
    await P.pipController.toggle()
    expect(P.pipController.overridingMainMute).toBe(true)
    expect(el.muted).toBe(true) // main video force-muted while PiP is audio authority

    deliver(EV_CLOSED, { rect: { x: 1, y: 2, width: 320, height: 180 } })
    expect(P.pipController.isOpen).toBe(false)
    expect(P.pipController.overridingMainMute).toBe(false)
    expect(el.muted).toBe(false) // resynced to the persisted truth
  })
})
