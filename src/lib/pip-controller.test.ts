import { describe, it, expect, beforeEach, vi } from 'vitest'
import { STORAGE_KEYS } from './storage-keys'

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
  windowsDestroyed: 0,
  lastWindowOpts: null as Record<string, unknown> | null,
  monitor: null as { width: number; height: number; scaleFactor: number } | null,
}))

vi.mock('@tauri-apps/api/core', () => ({
  isTauri: () => tauri.tauriEnabled,
}))
vi.mock('@tauri-apps/api/window', () => ({
  currentMonitor: () =>
    Promise.resolve(
      tauri.monitor === null
        ? null
        : {
            size: { width: tauri.monitor.width, height: tauri.monitor.height },
            position: { x: 0, y: 0 },
            scaleFactor: tauri.monitor.scaleFactor,
          },
    ),
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
vi.mock('@tauri-apps/api/webviewWindow', () => {
  // The created-window registry getByLabel reads from (the pip label is the
  // only one the controller ever looks up).
  const created: { destroyed: boolean }[] = []
  class WebviewWindow {
    destroyed = false
    once(_event: string, _cb: () => void): void {
      /* pip tests never trigger it */
    }
    destroy(): Promise<void> {
      this.destroyed = true
      tauri.windowsDestroyed++
      return Promise.resolve()
    }
    constructor(_label: string, opts: unknown) {
      tauri.windowsCreated++
      tauri.lastWindowOpts = opts as Record<string, unknown>
      created.push(this)
    }
    static getByLabel(label: string): Promise<unknown> {
      return Promise.resolve(label === 'pip' ? (created[created.length - 1] ?? null) : null)
    }
  }
  return { WebviewWindow }
})

type PipMod = typeof import('./pip-controller.svelte')
let P: PipMod

const EV_INIT = 'ks://pip-init'
const EV_STREAM = 'ks://pip-stream'
const EV_READY = 'ks://pip-ready'
const EV_CLOSED = 'ks://pip-closed'
const EV_DO_CLOSE = 'ks://pip-do-close'
const EV_QUALITIES = 'ks://pip-qualities'
const EV_QUALITY_REQ = 'ks://pip-quality'

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
  tauri.windowsDestroyed = 0
  tauri.lastWindowOpts = null
  tauri.monitor = { width: 2560, height: 1440, scaleFactor: 1 }
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
    expect(payloadsOf(EV_STREAM)).toEqual([
      { url: 'https://x/2.m3u8', mediaKind: 'hls', isLive: true, lowLatency: false },
    ])
  })

  it('emits isLive: false for an explicit false', async () => {
    await openPip()
    P.pipController.setStream({ url: 'https://x/2.m3u8', channel: 'chan1', quality: 'best', isLive: false })
    expect(payloadsOf(EV_STREAM)).toEqual([
      { url: 'https://x/2.m3u8', mediaKind: 'hls', isLive: false, lowLatency: false },
    ])
  })

  it('emits isLive: false when the field is ABSENT (the VOD-in-PiP safety default)', async () => {
    await openPip()
    P.pipController.setStream({ url: 'https://x/2.m3u8', channel: 'chan1', quality: 'best' })
    expect(payloadsOf(EV_STREAM)).toEqual([
      { url: 'https://x/2.m3u8', mediaKind: 'hls', isLive: false, lowLatency: false },
    ])
  })

  it('defaults mediaKind to hls and passes mp4 through', async () => {
    await openPip()
    P.pipController.setStream({ url: 'https://x/a.m3u8', channel: 'chan1', quality: 'best' })
    P.pipController.setStream({ url: 'https://x/b.mp4', channel: 'chan1', quality: 'best', mediaKind: 'mp4' })
    expect(payloadsOf(EV_STREAM)).toEqual([
      { url: 'https://x/a.m3u8', mediaKind: 'hls', isLive: false, lowLatency: false },
      { url: 'https://x/b.mp4', mediaKind: 'mp4', isLive: false, lowLatency: false },
    ])
  })

  it('carries lowLatency so the floating window config matches the playlist', async () => {
    // The PiP webview keeps its own settings instance (booted once at window
    // creation), so the hls.js low-latency mode MUST ride the payload — a
    // main-window toggle while PiP is open otherwise leaves the exact
    // config/playlist mismatch hls-config.ts warns about.
    await openPip()
    P.pipController.setStream({
      url: 'https://x/ll.m3u8',
      channel: 'chan1',
      quality: 'best',
      isLive: true,
      lowLatency: true,
    })
    expect(payloadsOf(EV_STREAM)).toEqual([
      { url: 'https://x/ll.m3u8', mediaKind: 'hls', isLive: true, lowLatency: true },
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

  it('continues the persisted audio state (muted included) and the low-latency flag', async () => {
    // The init handshake is the floating window's ONLY volume/mute seed: a
    // hardcoded unmute used to blast sound the user had explicitly muted,
    // and a missing lowLatency re-created the stale-settings mismatch.
    const { settings } = await import('./settings.svelte')
    settings.setMuted(true)
    const p = initPayloadAfter({
      url: 'https://x/1.m3u8',
      channel: 'chan1',
      quality: 'best',
      isLive: true,
      lowLatency: true,
    })
    expect(p.muted).toBe(true)
    expect(p.lowLatency).toBe(true)
    settings.setMuted(false)
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

  it('opening PiP creates the window exactly once; a second toggle asks it to close', async () => {
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

  it('a ks://pip-closed report flips isOpen back and resyncs the main video audio', async () => {
    // Non-default audio state on BOTH sides, or the restore cannot fail: a
    // muted session must STAY muted after the close (the resync follows the
    // persisted truth, it is not a forced unmute), and a non-default volume
    // must come back to the element.
    const { settings } = await import('./settings.svelte')
    // Volume FIRST, then the mute: a positive setVolume is an explicit unmute
    // in the settings store, so the reverse order would not stay muted.
    settings.setVolume(0.3)
    settings.setMuted(true)
    const el = document.createElement('video')
    el.muted = false
    el.volume = 0.9
    P.pipController.setVideoElement(el)
    P.pipController.setStream({ url: 'https://x/1.m3u8', channel: 'chan1', quality: 'best' })
    await P.pipController.toggle()
    expect(P.pipController.overridingMainMute).toBe(true)
    expect(el.muted).toBe(true) // main video force-muted while PiP is audio authority

    deliver(EV_CLOSED, { rect: { x: 1, y: 2, width: 320, height: 180 } })
    expect(P.pipController.isOpen).toBe(false)
    expect(P.pipController.overridingMainMute).toBe(false)
    expect(el.muted).toBe(true) // the persisted session was muted — stays muted
    expect(el.volume).toBe(0.3) // resynced to the persisted truth
    settings.setMuted(false)
    settings.setVolume(1)
  })
})

describe('pip-controller: VOD resume handoff', () => {
  it('setStream passes a VOD startAt through; absent stays absent', async () => {
    P.pipController.setStream({ url: 'https://x/1.m3u8', channel: 'chan1', quality: 'best' })
    await P.pipController.toggle()
    P.pipController.setStream({ url: 'https://x/2.m3u8', channel: 'chan1', quality: 'best' })
    P.pipController.setStream({ url: 'https://x/3.m3u8', channel: 'chan1', quality: 'best', startAt: 42 })
    expect(payloadsOf(EV_STREAM)).toEqual([
      { url: 'https://x/2.m3u8', mediaKind: 'hls', isLive: false, lowLatency: false },
      { url: 'https://x/3.m3u8', mediaKind: 'hls', isLive: false, lowLatency: false, startAt: 42 },
    ])
  })

  it('a live stream never carries a startAt, even if one is set', async () => {
    P.pipController.setStream({ url: 'https://x/live.m3u8', channel: 'chan1', quality: 'best' })
    await P.pipController.toggle()
    P.pipController.setStream({
      url: 'https://x/live.m3u8',
      channel: 'chan1',
      quality: 'best',
      isLive: true,
      startAt: 42,
    })
    expect(payloadsOf(EV_STREAM)).toEqual([
      { url: 'https://x/live.m3u8', mediaKind: 'hls', isLive: true, lowLatency: false },
    ])
  })

  it('updatePosition refreshes the stored startAt for the init handshake', () => {
    // The position as PiP takes over a VOD mid-playback must reach the
    // floating window through ks://pip-init — that is the whole handoff.
    P.pipController.setStream({ url: 'https://x/v.m3u8', channel: 'chan1', quality: 'best', startAt: 5 })
    P.pipController.updatePosition(1234.5)
    deliver(EV_READY)
    const p = payloadsOf(EV_INIT)[0] as Record<string, unknown>
    expect(p.startAt).toBe(1234.5)
  })

  it('updatePosition is a no-op for live streams and without a stored stream', () => {
    P.pipController.setStream({ url: 'https://x/live.m3u8', channel: 'chan1', quality: 'best', isLive: true })
    P.pipController.updatePosition(99)
    deliver(EV_READY)
    const p = payloadsOf(EV_INIT)[0] as Record<string, unknown>
    expect(p.startAt).toBeUndefined()
  })

  it('ks://pip-closed carries the media position into closedMedia (non-live only)', async () => {
    P.pipController.setStream({ url: 'https://x/v.m3u8', channel: 'chan1', quality: 'best' })
    await P.pipController.toggle()
    deliver(EV_CLOSED, { position: 321, duration: 3600, isLive: false })
    expect(P.pipController.closedMedia).toEqual({ position: 321, duration: 3600 })

    // A live close reports no resumable position (a live playhead is not a
    // checkpoint) — the stale VOD value must not survive it.
    P.pipController.setStream({ url: 'https://x/live.m3u8', channel: 'chan1', quality: 'best', isLive: true })
    await P.pipController.toggle()
    deliver(EV_CLOSED, { position: 500, isLive: true })
    expect(P.pipController.closedMedia).toBeNull()
  })
})

describe('pip-controller: quality menu plumbing', () => {
  it('pushQualityMenu caches for the init handshake and emits nothing while closed', () => {
    // The probe is async and often answers after the window opens, so the
    // menu must be refreshable post-handshake — but a closed pip gets no
    // dead events; the cache is what the NEXT sendInit serves.
    P.pipController.pushQualityMenu(['best', '720p60', '480p'], '720p60')
    expect(payloadsOf(EV_QUALITIES)).toEqual([])
    P.pipController.setStream({ url: 'https://x/1.m3u8', channel: 'chan1', quality: '720p60' })
    deliver(EV_READY)
    const p = payloadsOf(EV_INIT)[0] as Record<string, unknown>
    expect(p.qualities).toEqual(['best', '720p60', '480p'])
    expect(p.quality).toBe('720p60')
  })

  it('pushQualityMenu emits a live refresh to an OPEN pip', async () => {
    P.pipController.setStream({ url: 'https://x/1.m3u8', channel: 'chan1', quality: 'best' })
    await P.pipController.toggle()
    P.pipController.pushQualityMenu(['best', '160p'], 'best')
    expect(payloadsOf(EV_QUALITIES)).toEqual([{ quality: 'best', qualities: ['best', '160p'] }])
  })

  it('ks://pip-quality forwards to onQualityRequest; junk payloads are dropped', () => {
    const seen: Array<[string, number | undefined]> = []
    P.pipController.onQualityRequest = (q, position) => seen.push([q, position])
    deliver(EV_QUALITY_REQ, { quality: '480p', position: 123 })
    deliver(EV_QUALITY_REQ, { quality: '720p' })
    deliver(EV_QUALITY_REQ, { quality: 42 })
    deliver(EV_QUALITY_REQ, {})
    deliver(EV_QUALITY_REQ, undefined)
    expect(seen).toEqual([
      ['480p', 123],
      ['720p', undefined],
    ])
  })
})

describe('pip-controller: hung-window close fallback', () => {
  it('destroys the orphan window when ks://pip-closed never arrives', async () => {
    P.pipController.setStream({ url: 'https://x/1.m3u8', channel: 'chan1', quality: 'best' })
    await P.pipController.toggle()
    expect(P.pipController.isOpen).toBe(true)
    expect(tauri.windowsCreated).toBe(1)

    // Close WITHOUT delivering ks://pip-closed — the PiP webview is hung.
    // After the 1.5 s fallback the orphan must be destroyed (an
    // always-on-top, undecorated, skip-taskbar window nothing else can
    // reach, and the next open would fail on the duplicate label) and the
    // controller must be closed.
    vi.useFakeTimers()
    try {
      const closing = P.pipController.toggle()
      expect(payloadsOf(EV_DO_CLOSE)).toHaveLength(1)
      await vi.advanceTimersByTimeAsync(1600)
      expect(tauri.windowsDestroyed).toBe(1)
      expect(P.pipController.isOpen).toBe(false)
      await closing
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('pip-controller: saved-rect restore clamping', () => {
  // The floating window saves its rect in RAW PHYSICAL pixels (resize-event
  // values relayed verbatim), but rects written before that model can carry
  // grown sizes — the restore must clamp against the current monitor (also
  // physical) so they heal on the first open instead of coming back nearly
  // fullscreen. The WebviewWindow constructor takes LOGICAL pixels, so the
  // clamped physical rect is converted for it.
  function saveRect(x: number, y: number, width: number, height: number): void {
    localStorage.setItem(STORAGE_KEYS.pipWindowRect, JSON.stringify({ x, y, width, height }))
  }

  async function openOpts(): Promise<Record<string, unknown>> {
    P.pipController.setStream({ url: 'https://x/1.m3u8', channel: 'chan1', quality: 'best' })
    await P.pipController.toggle()
    expect(tauri.lastWindowOpts).toBeTruthy()
    return tauri.lastWindowOpts!
  }

  it('opens at the default 320×180 with no saved rect', async () => {
    const opts = await openOpts()
    expect(opts.width).toBe(320)
    expect(opts.height).toBe(180)
    expect(opts.x).toBeUndefined()
    expect(opts.y).toBeUndefined()
  })

  it('converts an in-range saved PHYSICAL rect to logical constructor options', async () => {
    // The stored rect is physical; the WebviewWindow constructor takes
    // logical. On this sf=1 mock the values pass through unchanged.
    saveRect(40, 50, 480, 270)
    const opts = await openOpts()
    expect(opts.width).toBe(480)
    expect(opts.height).toBe(270)
    expect(opts.x).toBe(40)
    expect(opts.y).toBe(50)
    // In-range rects are written back unchanged.
    expect(localStorage.getItem(STORAGE_KEYS.pipWindowRect)).toContain('"width":480')
  })

  it('clamps a grown rect to 60% of the monitor (physical) and heals the store', async () => {
    saveRect(3, 4, 2400, 1350)
    const opts = await openOpts()
    // 2560×1440 monitor → physical caps 1536×864.
    expect(opts.width).toBe(1536)
    expect(opts.height).toBe(864)
    expect(opts.x).toBe(3)
    expect(opts.y).toBe(4)
    // The clamped value is written back so the floating window's own
    // physical restore reads a healed rect.
    expect(JSON.parse(localStorage.getItem(STORAGE_KEYS.pipWindowRect)!)).toMatchObject({
      width: 1536,
      height: 864,
    })
  })

  it('clamps in PHYSICAL units on a scaled monitor and converts for the constructor', async () => {
    // 3840×2160 physical at 2.0: the stored rect and the cap are physical
    // (0.6×3840 = 2304×1296); the constructor gets LOGICAL (÷2 → 1152×648).
    tauri.monitor = { width: 3840, height: 2160, scaleFactor: 2 }
    saveRect(0, 0, 3600, 2025)
    const opts = await openOpts()
    expect(opts.width).toBe(1152)
    expect(opts.height).toBe(648)
    expect(JSON.parse(localStorage.getItem(STORAGE_KEYS.pipWindowRect)!)).toMatchObject({
      width: 2304,
      height: 1296,
    })
  })

  it('falls back to the default constructor size when no monitor answers', async () => {
    // The floating window restores the stored physical size itself after
    // mapping, so without a monitor answer the constructor just opens small.
    tauri.monitor = null
    saveRect(3, 4, 2400, 1350)
    const opts = await openOpts()
    expect(opts.width).toBe(320)
    expect(opts.height).toBe(180)
    // The store is left untouched — no clamp, no write-back.
    expect(JSON.parse(localStorage.getItem(STORAGE_KEYS.pipWindowRect)!)).toMatchObject({
      width: 2400,
      height: 1350,
    })
  })
})

describe('pip-controller: vodId passthrough for the PiP scrub-bar extras', () => {
  it('setStream forwards vodId on ks://pip-stream; absent stays absent', async () => {
    P.pipController.setStream({ url: 'https://x/1.m3u8', channel: 'chan1', quality: 'best' })
    await P.pipController.toggle()
    P.pipController.setStream({
      url: 'https://x/v.m3u8',
      channel: 'chan1',
      quality: 'best',
      isLive: false,
      vodId: '987654321',
    })
    P.pipController.setStream({ url: 'https://x/v2.m3u8', channel: 'chan1', quality: 'best', isLive: false })
    expect(payloadsOf(EV_STREAM)).toEqual([
      { url: 'https://x/v.m3u8', mediaKind: 'hls', isLive: false, lowLatency: false, vodId: '987654321' },
      { url: 'https://x/v2.m3u8', mediaKind: 'hls', isLive: false, lowLatency: false },
    ])
  })

  it('sendInit serves the stored vodId alongside startAt', () => {
    P.pipController.setStream({
      url: 'https://x/v.m3u8',
      channel: 'chan1',
      quality: 'best',
      startAt: 42,
      vodId: '123',
    })
    deliver(EV_READY)
    const p = payloadsOf(EV_INIT)[0] as Record<string, unknown>
    expect(p.startAt).toBe(42)
    expect(p.vodId).toBe('123')
  })
})
