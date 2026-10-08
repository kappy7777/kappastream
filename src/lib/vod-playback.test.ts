import { describe, expect, it, beforeEach, vi } from 'vitest'
import { formatVodTime } from './vod-playback.svelte.ts'
import { STORAGE_KEYS } from './storage-keys'

/*
 * formatVodTime covers the shared formatter; the rest exercises
 * VodPlaybackController against a real HtmlVideoBackend wrapping a happy-dom
 * <video> (the restore path gates on `instanceof HtmlVideoBackend`, so the
 * class must come from the SAME module cycle as the controller). The gql
 * extras fetch is a controllable mock; seekable ranges are stubbed per
 * element; time (the save throttle and the resume-bar timeout) is driven
 * through a Date.now spy / fake timers so no test waits wall-clock seconds.
 */

const extras = vi.hoisted(() => ({
  handler: null as null | ((id: string) => Promise<unknown>),
}))

vi.mock('./gql', () => ({
  fetchVideoExtras: (id: string): Promise<unknown> => {
    if (!extras.handler) return Promise.reject(new Error('extras handler not configured'))
    return extras.handler(id)
  },
}))

describe('formatVodTime', () => {
  it('formats seconds-only positions as m:ss', () => {
    expect(formatVodTime(0)).toBe('0:00')
    expect(formatVodTime(9)).toBe('0:09')
    expect(formatVodTime(65)).toBe('1:05')
    expect(formatVodTime(599)).toBe('9:59')
  })

  it('pads minutes once an hour is present', () => {
    expect(formatVodTime(3600)).toBe('1:00:00')
    expect(formatVodTime(3661)).toBe('1:01:01')
    expect(formatVodTime(7325)).toBe('2:02:05')
  })

  it('clamps negative / non-finite input to 0:00', () => {
    expect(formatVodTime(-30)).toBe('0:00')
    expect(formatVodTime(Number.NaN)).toBe('0:00')
    expect(formatVodTime(Number.POSITIVE_INFINITY)).toBe('0:00')
  })
})

interface Harness {
  controller: InstanceType<(typeof import('./vod-playback.svelte.ts'))['VodPlaybackController']>
  el: HTMLVideoElement
  backend: import('./video-backend').HtmlVideoBackend
  vodPositions: import('./vod-positions.svelte.ts').VodPositionsStore
}

// Fresh module cycle per call: vodPositions loads its map at construction
// (localStorage must be seeded BEFORE), and the controller + backend class
// must share one registry for the instanceof gate.
async function makeController(): Promise<Harness> {
  const V = await import('./vod-playback.svelte.ts')
  const { HtmlVideoBackend } = await import('./video-backend')
  const { vodPositions } = await import('./vod-positions.svelte.ts')
  const el = document.createElement('video')
  el.play = () => Promise.resolve()
  let seekEnd = 0
  Object.defineProperty(el, 'seekable', {
    configurable: true,
    get: () => ({ length: seekEnd > 0 ? 1 : 0, end: () => seekEnd }),
  })
  const backend = new HtmlVideoBackend(el)
  const controller = new V.VodPlaybackController({
    proxyUrl: (u) => 'proxied:' + u,
    getBackend: () => backend,
  })
  return {
    controller,
    el,
    backend,
    vodPositions,
    set seekEnd(v: number) {
      seekEnd = v
    },
  } as Harness & { seekEnd: number }
}

/** Seed a checkpoint the way a previous session would have left it. */
function seedPosition(vodId: string, position: number, duration = 7200): void {
  localStorage.setItem(STORAGE_KEYS.vodPositions, JSON.stringify({ [vodId]: { position, duration, updatedAt: 1 } }))
}

beforeEach(() => {
  vi.resetModules()
  localStorage.clear()
  extras.handler = null
})

describe('VodPlaybackController — save', () => {
  it('throttles saves to the interval; pause/leave forces a flush', async () => {
    const h = (await makeController()) as Harness & { seekEnd: number }
    const now = vi.spyOn(Date, 'now').mockReturnValue(1_000_000)
    try {
      h.el.currentTime = 120
      h.controller.save('v1')
      h.el.currentTime = 200
      h.controller.save('v1') // inside the 5 s window — dropped
      expect(h.vodPositions.get('v1')?.position).toBe(120)

      now.mockReturnValue(1_005_001)
      h.controller.save('v1')
      expect(h.vodPositions.get('v1')?.position).toBe(200)

      h.el.currentTime = 300
      h.controller.save('v1', true) // force (pause / leaving the VOD)
      expect(h.vodPositions.get('v1')?.position).toBe(300)
    } finally {
      now.mockRestore()
    }
  })

  it('is a no-op without a videoId or a backend', async () => {
    const h = (await makeController()) as Harness & { seekEnd: number }
    h.el.currentTime = 120
    h.controller.save(null)
    const V = await import('./vod-playback.svelte.ts')
    const bare = new V.VodPlaybackController({ proxyUrl: (u) => u, getBackend: () => null })
    bare.save('v9')
    expect(h.vodPositions.get('v9')).toBeNull()
    expect(localStorage.getItem(STORAGE_KEYS.vodPositions)).toBeNull()
  })
})

describe('VodPlaybackController — restore', () => {
  it('seeks a saved position once seekable covers it and shows the bar; the bar times out', async () => {
    vi.useFakeTimers()
    try {
      seedPosition('v1', 600)
      const h = (await makeController()) as Harness & { seekEnd: number }
      h.controller.restore('v1')
      // Seekable is still empty — the wait is armed, nothing sought yet.
      expect(h.el.currentTime).toBe(0)

      h.seekEnd = 3600
      h.el.dispatchEvent(new Event('progress'))
      expect(h.el.currentTime).toBe(600)
      expect(h.controller.resumeBar).toEqual({ vodId: 'v1', position: 600 })

      vi.advanceTimersByTime(8_001)
      expect(h.controller.resumeBar).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })

  it('never resumes a checkpoint below the 30 s threshold', async () => {
    seedPosition('v1', 29)
    const h = (await makeController()) as Harness & { seekEnd: number }
    h.seekEnd = 3600
    h.controller.restore('v1')
    h.el.dispatchEvent(new Event('progress'))
    expect(h.el.currentTime).toBe(0)
    expect(h.controller.resumeBar).toBeNull()
  })

  it('a new restore drops the previous wait — a stale listener cannot seek a later VOD', async () => {
    const h = (await makeController()) as Harness & { seekEnd: number }
    h.controller.restore('a', { startAt: 600 }) // arms wait A (seekable empty)
    h.controller.restore('b', { startAt: 120 }) // must drop A, arm B
    h.seekEnd = 3600
    h.el.dispatchEvent(new Event('progress'))
    expect(h.el.currentTime).toBe(120)
    expect(h.controller.resumeBar).toEqual({ vodId: 'b', position: 120 })
    // B's wait tore itself down after succeeding: further progress is inert.
    h.el.dispatchEvent(new Event('progress'))
    expect(h.el.currentTime).toBe(120)
  })

  it('a quiet restore (internal reload) seeks without the bar', async () => {
    const h = (await makeController()) as Harness & { seekEnd: number }
    h.seekEnd = 3600
    h.controller.restore('v1', { startAt: 480, quiet: true })
    expect(h.el.currentTime).toBe(480)
    expect(h.controller.resumeBar).toBeNull()
  })
})

describe('VodPlaybackController — restart', () => {
  it('seeks to 0, plays, forgets the checkpoint, and drops the bar', async () => {
    seedPosition('v1', 600)
    const h = (await makeController()) as Harness & { seekEnd: number }
    const plays = vi.fn(() => Promise.resolve())
    h.el.play = plays
    h.seekEnd = 3600
    h.controller.restore('v1')
    h.el.dispatchEvent(new Event('progress'))
    expect(h.el.currentTime).toBe(600)

    h.controller.restart('v1')
    expect(h.el.currentTime).toBe(0)
    expect(plays).toHaveBeenCalled()
    expect(h.vodPositions.get('v1')).toBeNull()
    expect(h.controller.resumeBar).toBeNull()
  })
})

describe('VodPlaybackController — extras token', () => {
  it('clearExtras invalidates an in-flight fetch: stale chapters never land', async () => {
    const h = (await makeController()) as Harness & { seekEnd: number }
    let release!: (v: unknown) => void
    extras.handler = () => new Promise((res) => (release = res))
    const pending = h.controller.loadExtras('a')
    h.controller.clearExtras() // playback mode changed mid-flight
    release({ chapters: [{ startSec: 0, label: 'Intro' }], mutedSpans: [], seekPreviewsUrl: null })
    await pending
    expect(h.controller.chapters).toEqual([])
    expect(h.controller.mutedSpans).toEqual([])
    expect(h.controller.storyboard).toBeNull()
  })

  it('lands chapters and muted spans for the live token', async () => {
    const h = (await makeController()) as Harness & { seekEnd: number }
    extras.handler = async () => ({
      chapters: [{ startSec: 0, label: 'Intro' }],
      mutedSpans: [{ startSec: 10, endSec: 20 }],
      seekPreviewsUrl: null,
    })
    await h.controller.loadExtras('b')
    expect(h.controller.chapters).toEqual([{ startSec: 0, label: 'Intro' }])
    expect(h.controller.mutedSpans).toEqual([{ startSec: 10, endSec: 20 }])
  })

  it('routes the storyboard through the proxy; a token bump mid-fetch drops it', async () => {
    const h = (await makeController()) as Harness & { seekEnd: number }
    extras.handler = async () => ({
      chapters: [],
      mutedSpans: [],
      seekPreviewsUrl: 'https://d.example/vod/storyboards/sb.json',
    })
    const fetched: string[] = []
    let releaseSb!: (v: unknown) => void
    vi.stubGlobal('fetch', (url: string) => {
      fetched.push(url)
      return new Promise((res) => (releaseSb = res))
    })
    try {
      const pending = h.controller.loadExtras('c')
      await new Promise((r) => setTimeout(r, 0))
      await new Promise((r) => setTimeout(r, 0))
      expect(fetched).toEqual(['proxied:https://d.example/vod/storyboards/sb.json'])
      h.controller.clearExtras() // mode change while the storyboard downloads
      releaseSb([{ width: 320, height: 180, cols: 10, rows: 10, count: 100, interval: 5, images: ['s-0.jpg'] }])
      await pending
      // Valid storyboard + superseded token: the drop is the token check,
      // not a parse failure (that would be indistinguishable otherwise).
      expect(h.controller.storyboard).toBeNull()
    } finally {
      vi.unstubAllGlobals()
    }
  })
})
