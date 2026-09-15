import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { PlaybackSession, type AttachHlsOptions } from './playback-session.svelte'

/*
 * Tests for the shared playback engine (src/lib/playback-session.svelte.ts),
 * against a fake <video> element and a fake hls.js class (vi.mock). These pin
 * the exact discipline the three surfaces (App.svelte / Tile.svelte /
 * PipWindow.svelte) used to each carry a copy of: generation staleness,
 * finish-once, the 20s manifest timeout, fatal-vs-non-fatal ERROR handling,
 * the cancel hook on teardown, and the 1s stall-recovery snap.
 */

// Structural type of the fake instances the mock creates (keeps the tests
// `any`-free while still reaching into the mock's call log).
interface FakeHlsInstance {
  on: ReturnType<typeof vi.fn>
  loadSource: ReturnType<typeof vi.fn>
  attachMedia: ReturnType<typeof vi.fn>
  destroy: ReturnType<typeof vi.fn>
  liveSyncPosition: number | null
}

const hlsMock = vi.hoisted(() => {
  const instances: FakeHlsInstance[] = []
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
      hlsMock.instances.push(this as unknown as FakeHlsInstance)
    }
  }
  return { default: FakeHls }
})

type HlsListener = (event: unknown, data: unknown) => void

function lastInstance(): FakeHlsInstance {
  const inst = hlsMock.instances[hlsMock.instances.length - 1]
  if (!inst) throw new Error('no FakeHls instance was created')
  return inst
}

function emit(inst: FakeHlsInstance, event: string, data: unknown): void {
  for (const call of inst.on.mock.calls) {
    if (call[0] === event) (call[1] as HlsListener)(undefined, data)
  }
}

function makeVideo(): HTMLVideoElement {
  const el = document.createElement('video')
  el.play = vi.fn().mockResolvedValue(undefined)
  el.pause = vi.fn()
  el.load = vi.fn()
  let time = 0
  Object.defineProperty(el, 'currentTime', {
    get: () => time,
    set: (v: number) => {
      time = v
    },
    configurable: true,
  })
  // A single-entry seekable window ending at 600s (the live-edge fallback).
  Object.defineProperty(el, 'seekable', {
    value: { length: 1, end: (i: number) => (i === 0 ? 600 : NaN) },
    configurable: true,
  })
  return el
}

function baseOpts(video: HTMLVideoElement, over: Partial<AttachHlsOptions> = {}): AttachHlsOptions {
  return {
    video,
    url: 'https://example.test/playlist.m3u8',
    lowLatency: false,
    isCurrent: () => true,
    ...over,
  }
}

describe('PlaybackSession.attachHls', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    hlsMock.instances.length = 0
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('resolves the happy path: manifest parsed → autoplay → ok, callbacks in order', async () => {
    const video = makeVideo()
    const session = new PlaybackSession()
    const events: string[] = []
    const p = session.attachHls(
      baseOpts(video, {
        onManifestParsed: () => events.push('manifest'),
        onPlayed: () => events.push('played'),
      }),
    )
    const inst = lastInstance()
    emit(inst, 'hlsManifestParsed', {})
    const r = await p
    expect(r).toEqual({ ok: true })
    await vi.advanceTimersByTimeAsync(0) // flush the play().then microtask
    expect(events).toEqual(['manifest', 'played'])
    expect(inst.loadSource).toHaveBeenCalledWith('https://example.test/playlist.m3u8')
    expect(inst.attachMedia).toHaveBeenCalledWith(video)
  })

  it('resolves a stale generation to the stale error instead of playing', async () => {
    const video = makeVideo()
    const session = new PlaybackSession()
    const gen = session.nextGeneration()
    const p = session.attachHls(
      baseOpts(video, {
        isCurrent: () => gen === session.generation,
      }),
    )
    session.nextGeneration() // supersede the in-flight attach
    emit(lastInstance(), 'hlsManifestParsed', {})
    const r = await p
    expect(r).toEqual({ ok: false, error: 'stale stream request' })
    expect(vi.mocked(video.play)).not.toHaveBeenCalled()
  })

  it('times out after 20s waiting for the manifest and destroys the instance', async () => {
    const video = makeVideo()
    const session = new PlaybackSession()
    const p = session.attachHls(baseOpts(video))
    const inst = lastInstance()
    await vi.advanceTimersByTimeAsync(20_000)
    const r = await p
    expect(r).toEqual({ ok: false, error: 'timeout waiting for manifest' })
    expect(inst.destroy).toHaveBeenCalled()
  })

  it('destroys the instance and resolves ok:false on a fatal ERROR with the unified string', async () => {
    const video = makeVideo()
    const session = new PlaybackSession()
    const p = session.attachHls(baseOpts(video))
    const inst = lastInstance()
    emit(inst, 'hlsError', { fatal: true, type: 'networkError', details: 'manifestLoadError' })
    const r = await p
    expect(r).toEqual({ ok: false, error: 'network/manifest error: networkError (manifestLoadError)' })
    expect(inst.destroy).toHaveBeenCalled()
  })

  it('formats a non-networkish fatal error with the generic prefix + details suffix', async () => {
    const video = makeVideo()
    const session = new PlaybackSession()
    const p = session.attachHls(baseOpts(video))
    emit(lastInstance(), 'hlsError', { fatal: true, type: 'mediaError', details: 'bufferStalledError' })
    expect(await p).toEqual({ ok: false, error: 'hls error: mediaError (bufferStalledError)' })
  })

  it('lets the VOD call site keep its own error taxonomy via formatFatalError', async () => {
    const video = makeVideo()
    const session = new PlaybackSession()
    const p = session.attachHls(
      baseOpts(video, {
        formatFatalError: (d) => 'media error: ' + d.type,
      }),
    )
    emit(lastInstance(), 'hlsError', { fatal: true, type: 'mediaError', details: 'bufferStalledError' })
    expect(await p).toEqual({ ok: false, error: 'media error: mediaError' })
  })

  it('ignores a non-fatal ERROR (instance survives; a later manifest still resolves ok)', async () => {
    const video = makeVideo()
    const session = new PlaybackSession()
    const p = session.attachHls(baseOpts(video))
    const inst = lastInstance()
    emit(inst, 'hlsError', { fatal: false, type: 'mediaError', details: 'bufferStalledError' })
    expect(inst.destroy).not.toHaveBeenCalled()
    emit(inst, 'hlsManifestParsed', {})
    expect(await p).toEqual({ ok: true })
  })

  it('finishes exactly once (the ok resolution clears the timeout; a later tick cannot overwrite it)', async () => {
    const video = makeVideo()
    const session = new PlaybackSession()
    const p = session.attachHls(baseOpts(video))
    emit(lastInstance(), 'hlsManifestParsed', {})
    expect(await p).toEqual({ ok: true })
    await vi.advanceTimersByTimeAsync(25_000)
    expect(lastInstance().destroy).not.toHaveBeenCalled()
  })

  it('resolves (rather than hangs) a pending attach when teardown runs, and cleans the element', async () => {
    const video = makeVideo()
    const session = new PlaybackSession()
    const p = session.attachHls(baseOpts(video))
    const inst = lastInstance()
    session.teardown(video)
    const r = await p
    expect(r).toEqual({ ok: false, error: 'stale stream request' })
    expect(inst.destroy).toHaveBeenCalled()
    expect(vi.mocked(video.pause)).toHaveBeenCalled()
    expect(video.getAttribute('src')).toBeNull()
    expect(vi.mocked(video.load)).toHaveBeenCalled()
  })

  it('attachHls after dispose resolves ok:false without creating an instance', async () => {
    hlsMock.instances.length = 0
    const session = new PlaybackSession()
    session.dispose()
    const r = await session.attachHls(baseOpts(makeVideo()))
    expect(r.ok).toBe(false)
    expect(hlsMock.instances.length).toBe(0)
  })
})

describe('PlaybackSession generations & disposal', () => {
  it('teardown bumps the generation so old isCurrent predicates go stale', () => {
    const session = new PlaybackSession()
    const gen = session.nextGeneration()
    expect(gen === session.generation).toBe(true)
    session.teardown()
    expect(gen === session.generation).toBe(false)
  })

  it('dispose() is idempotent — a second call does not throw', () => {
    const video = makeVideo()
    const session = new PlaybackSession()
    session.dispose(video)
    expect(() => session.dispose(video)).not.toThrow()
  })
})

describe('PlaybackSession stall recovery', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    hlsMock.instances.length = 0
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('seeks to liveSyncPosition − 1.5s and resumes after the grace period', async () => {
    const video = makeVideo()
    const session = new PlaybackSession()
    const p = session.attachHls(baseOpts(video))
    const inst = lastInstance()
    inst.liveSyncPosition = 100
    emit(inst, 'hlsManifestParsed', {})
    await p
    video.currentTime = 40 // fell behind the live edge
    session.scheduleStallRecover(video)
    await vi.advanceTimersByTimeAsync(1_000)
    expect(video.currentTime).toBe(98.5)
    expect(vi.mocked(video.play)).toHaveBeenCalledTimes(2) // initial + recovery
  })

  it('falls back to the seekable end when there is no liveSyncPosition', async () => {
    const video = makeVideo()
    const session = new PlaybackSession()
    video.currentTime = 40
    session.scheduleStallRecover(video) // no hls instance attached
    await vi.advanceTimersByTimeAsync(1_000)
    expect(video.currentTime).toBe(598.5)
  })

  it('clearStallRecover cancels a scheduled recovery', async () => {
    const video = makeVideo()
    const session = new PlaybackSession()
    video.currentTime = 40
    session.scheduleStallRecover(video) // no hls instance attached
    session.clearStallRecover()
    await vi.advanceTimersByTimeAsync(2_000)
    expect(video.currentTime).toBe(40)
    expect(vi.mocked(video.play)).not.toHaveBeenCalled()
  })

  it('a recovery whose play() is REJECTED fires onPlayBlocked (PiP gesture prompt)', async () => {
    const video = makeVideo()
    vi.mocked(video.play).mockRejectedValue(new Error('NotAllowedError'))
    const session = new PlaybackSession()
    let blocked = false
    session.scheduleStallRecover(video, {
      onPlayBlocked: () => {
        blocked = true
      },
    })
    await vi.advanceTimersByTimeAsync(1_000)
    expect(blocked).toBe(true)
    expect(video.currentTime).toBe(598.5) // the seek still happened before the resume attempt
  })

  it('a recovery whose play() RESOLVES does not fire onPlayBlocked', async () => {
    const video = makeVideo()
    const session = new PlaybackSession()
    let blocked = false
    session.scheduleStallRecover(video, {
      onPlayBlocked: () => {
        blocked = true
      },
    })
    await vi.advanceTimersByTimeAsync(1_000)
    expect(blocked).toBe(false)
  })

  it('a REJECTED resume with no onPlayBlocked callback is swallowed without throwing (App/Tile path)', async () => {
    const video = makeVideo()
    vi.mocked(video.play).mockRejectedValue(new Error('NotAllowedError'))
    const session = new PlaybackSession()
    session.scheduleStallRecover(video)
    await vi.advanceTimersByTimeAsync(1_000)
    // No assertion beyond "did not throw": the rejection is handled, the
    // user can still press play on a surface with a visible control bar.
    expect(video.currentTime).toBe(598.5)
  })
})

describe('PlaybackSession.attachNative', () => {
  it('plays natively and reports ok with the onPlayed callback', async () => {
    const video = makeVideo()
    const session = new PlaybackSession()
    let played = false
    const r = await session.attachNative(video, 'https://example.test/x.m3u8', {
      errorPrefix: 'native HLS play failed: ',
      onPlayed: () => {
        played = true
      },
    })
    expect(r).toEqual({ ok: true })
    expect(played).toBe(true)
    expect(video.src).toContain('x.m3u8')
  })

  it('returns the stale error when play resolves but the attach went stale', async () => {
    const video = makeVideo()
    const session = new PlaybackSession()
    const gen = session.nextGeneration()
    session.nextGeneration()
    const r = await session.attachNative(video, 'https://example.test/x.m3u8', {
      isCurrent: () => gen === session.generation,
      errorPrefix: 'native HLS play failed: ',
    })
    expect(r).toEqual({ ok: false, error: 'stale stream request' })
  })

  it('formats a failed native play with the call-site prefix', async () => {
    const video = makeVideo()
    vi.mocked(video.play).mockRejectedValueOnce(new Error('NotAllowedError'))
    const session = new PlaybackSession()
    const r = await session.attachNative(video, 'https://example.test/x.m3u8', {
      errorPrefix: 'playback failed: ',
    })
    expect(r).toEqual({ ok: false, error: 'playback failed: NotAllowedError' })
  })
})
