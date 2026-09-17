import { beforeEach, describe, expect, it, vi } from 'vitest'
import { HtmlVideoBackend, MpvBackend, selectVideoBackend, type VideoBackendEvent } from './video-backend'

// A deterministic stand-in for HTMLVideoElement: real EventTarget semantics
// (subscribe/unsubscribe/dispatch actually work) with plain fields for the
// media state, so the tests pin the WRAPPER's delegation without depending
// on happy-dom's media-element internals.
class FakeVideoElement extends EventTarget {
  currentTime = 12.5
  duration = 90
  paused = false
  volume = 0.7
  muted = false
  playCalls = 0
  pauseCalls = 0
  buffered = { length: 1, end: (i: number) => (i === 0 ? 41 : 0) }

  play(): Promise<void> {
    this.playCalls++
    return Promise.resolve()
  }
  pause(): void {
    this.pauseCalls++
  }
}

function makeBackend(): { backend: HtmlVideoBackend; el: FakeVideoElement } {
  const el = new FakeVideoElement()
  return { backend: new HtmlVideoBackend(el as unknown as HTMLVideoElement), el }
}

describe('HtmlVideoBackend', () => {
  it('delegates every state read to the element', () => {
    const { backend, el } = makeBackend()
    expect(backend.currentTime).toBe(12.5)
    expect(backend.duration).toBe(90)
    expect(backend.paused).toBe(false)
    expect(backend.volume).toBe(0.7)
    expect(backend.muted).toBe(false)
    expect(backend.buffered).toBe(41)
    expect(backend.element).toBe(el)
  })

  it('delegates transport writes to the element', () => {
    const { backend, el } = makeBackend()
    backend.seek(30)
    expect(el.currentTime).toBe(30)
    backend.setVolume(0.25)
    expect(el.volume).toBe(0.25)
    backend.setMuted(true)
    expect(el.muted).toBe(true)
    backend.pause()
    expect(el.pauseCalls).toBe(1)
    void backend.play()
    expect(el.playCalls).toBe(1)
  })

  it('subscribes to the element events and unsubscribes on the returned handle', () => {
    const { backend, el } = makeBackend()
    const onTime = vi.fn()
    const off = backend.on('timeupdate', onTime)
    el.dispatchEvent(new Event('timeupdate'))
    expect(onTime).toHaveBeenCalledTimes(1)
    off()
    el.dispatchEvent(new Event('timeupdate'))
    expect(onTime).toHaveBeenCalledTimes(1)
  })

  it('supports several independent subscriptions for the same event', () => {
    const { backend, el } = makeBackend()
    const a = vi.fn()
    const b = vi.fn()
    const offA = backend.on('seeking', a)
    backend.on('seeking', b)
    el.dispatchEvent(new Event('seeking'))
    expect(a).toHaveBeenCalledTimes(1)
    expect(b).toHaveBeenCalledTimes(1)
    offA()
    el.dispatchEvent(new Event('seeking'))
    expect(a).toHaveBeenCalledTimes(1)
    expect(b).toHaveBeenCalledTimes(2)
  })

  it('dispose is a safe no-op (nothing backend-side to release)', () => {
    const { backend } = makeBackend()
    expect(() => backend.dispose()).not.toThrow()
  })

  it('the event union covers every event the consumers subscribe to', () => {
    // Compile-time pin: these all have to be valid VideoBackendEvents. If a
    // consumer needs a new one, it must be added to the union (and to the
    // native backend's synthesis) deliberately.
    const needed = [
      'timeupdate',
      'seeking',
      'seeked',
      'pause',
      'play',
      'playing',
      'waiting',
      'ended',
      'error',
      'durationchange',
      'volumechange',
      'progress',
    ] as const
    const { backend } = makeBackend()
    for (const ev of needed) {
      expect(() => backend.on(ev as VideoBackendEvent, () => {})).not.toThrow()
    }
  })

  it('buffered reports 0 when the element has no buffered ranges', () => {
    const el = new FakeVideoElement()
    el.buffered = { length: 0, end: () => 0 }
    const backend = new HtmlVideoBackend(el as unknown as HTMLVideoElement)
    expect(backend.buffered).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// Native-engine selection + MpvBackend (Tauri APIs mocked — never a live
// invoke; the mpv commands do not even exist in default builds, where every
// call rejects and the backend must stay inert).

import { invoke } from '@tauri-apps/api/core'
import * as eventModule from '@tauri-apps/api/event'

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn().mockResolvedValue(undefined) }))
vi.mock('@tauri-apps/api/event', () => {
  const handlers = new Map<string, Array<(e: { payload: unknown }) => void>>()
  return {
    listen: vi.fn(async (name: string, handler: (e: { payload: unknown }) => void) => {
      let arr = handlers.get(name)
      if (!arr) {
        arr = []
        handlers.set(name, arr)
      }
      arr.push(handler)
      return () => {
        const current = handlers.get(name)
        if (current) {
          const i = current.indexOf(handler)
          if (i >= 0) current.splice(i, 1)
        }
      }
    }),
    // Test-side access to the registered handlers (the mock factory cannot
    // close over outer scope — vi.mock is hoisted).
    __handlers: handlers,
  }
})

const invokeMock = vi.mocked(invoke)
// The mock factory cannot close over outer scope (vi.mock is hoisted), so the
// handler registry travels on the mocked module itself.
type MpvHandlerMap = Map<string, Array<(e: { payload: unknown }) => void>>
const mpvHandlers = (eventModule as unknown as { __handlers: MpvHandlerMap }).__handlers

function dispatch(name: string, payload: unknown): void {
  for (const h of [...(mpvHandlers.get(name) ?? [])]) h({ payload })
}

describe('selectVideoBackend', () => {
  const base = { mpvEngineOn: false, mpvAvailable: false, multiView: false, pipOpen: false }

  it('uses mpv only when every gate holds', () => {
    expect(selectVideoBackend({ ...base, mpvEngineOn: true, mpvAvailable: true })).toBe('mpv')
  })

  it('falls back to html when the setting is off', () => {
    expect(selectVideoBackend({ ...base, mpvAvailable: true })).toBe('html')
  })

  it('falls back to html when the engine is unavailable (default builds)', () => {
    expect(selectVideoBackend({ ...base, mpvEngineOn: true })).toBe('html')
  })

  it('falls back to html in multi-view (the single player steps aside for the tile grid)', () => {
    expect(selectVideoBackend({ mpvEngineOn: true, mpvAvailable: true, multiView: true, pipOpen: false })).toBe('html')
  })

  it('falls back to html while the PiP window is open (PiP owns playback)', () => {
    expect(selectVideoBackend({ mpvEngineOn: true, mpvAvailable: true, multiView: false, pipOpen: true })).toBe('html')
  })
})

describe('MpvBackend', () => {
  beforeEach(() => {
    mpvHandlers.clear()
    invokeMock.mockReset()
    invokeMock.mockResolvedValue(undefined)
  })

  it('starts paused with no duration and zero buffered', async () => {
    const b = new MpvBackend()
    expect(b.paused).toBe(true)
    expect(b.currentTime).toBe(0)
    expect(Number.isNaN(b.duration)).toBe(true)
    expect(b.buffered).toBe(0)
    await b.dispose()
  })

  it('transport writes invoke the matching commands', async () => {
    const b = new MpvBackend()
    b.pause()
    expect(invokeMock).toHaveBeenCalledWith('mpv_set_paused', { id: 0, paused: true })
    await b.play()
    expect(invokeMock).toHaveBeenCalledWith('mpv_set_paused', { id: 0, paused: false })
    expect(b.paused).toBe(false)
    b.seek(12.5)
    expect(invokeMock).toHaveBeenCalledWith('mpv_seek', { id: 0, seconds: 12.5 })
    b.setVolume(0.5)
    expect(invokeMock).toHaveBeenCalledWith('mpv_set_volume', { id: 0, volume: 0.5 })
    expect(b.volume).toBe(0.5)
    b.setMuted(true)
    expect(invokeMock).toHaveBeenCalledWith('mpv_set_muted', { id: 0, muted: true })
    expect(b.muted).toBe(true)
    await b.dispose()
  })

  it('setVolume/setMuted emit volumechange (the settings round-trip)', async () => {
    const b = new MpvBackend()
    const onVol = vi.fn()
    b.on('volumechange', onVol)
    b.setVolume(0.25)
    b.setMuted(false)
    expect(onVol).toHaveBeenCalledTimes(2)
    await b.dispose()
  })

  it('mpv://time updates position/duration and emits timeupdate + durationchange', async () => {
    const b = new MpvBackend()
    const onTime = vi.fn()
    const onDur = vi.fn()
    b.on('timeupdate', onTime)
    b.on('durationchange', onDur)
    dispatch('mpv://time', { id: 0, position: 10, duration: 3600 })
    expect(b.currentTime).toBe(10)
    expect(b.duration).toBe(3600)
    expect(onTime).toHaveBeenCalledTimes(1)
    expect(onDur).toHaveBeenCalledTimes(1)
    dispatch('mpv://time', { id: 0, position: 11, duration: 3600 })
    expect(onTime).toHaveBeenCalledTimes(2)
    expect(onDur).toHaveBeenCalledTimes(1) // unchanged duration stays silent
    await b.dispose()
  })

  it('maps the mpv states onto the interface events', async () => {
    const b = new MpvBackend()
    const seen: string[] = []
    b.on('play', () => seen.push('play'))
    b.on('playing', () => seen.push('playing'))
    b.on('pause', () => seen.push('pause'))
    b.on('waiting', () => seen.push('waiting'))
    b.on('ended', () => seen.push('ended'))
    b.on('error', () => seen.push('error'))
    dispatch('mpv://state', { id: 0, state: 'playing' })
    expect(seen).toEqual(['play', 'playing'])
    expect(b.paused).toBe(false)
    dispatch('mpv://state', { id: 0, state: 'buffering' })
    expect(seen).toEqual(['play', 'playing', 'waiting'])
    dispatch('mpv://state', { id: 0, state: 'paused' })
    expect(b.paused).toBe(true)
    expect(seen).toEqual(['play', 'playing', 'waiting', 'pause'])
    dispatch('mpv://state', { id: 0, state: 'ended' })
    expect(seen).toEqual(['play', 'playing', 'waiting', 'pause', 'ended'])
    dispatch('mpv://state', { id: 0, state: 'error', error: 'mpv error 5' })
    expect(seen).toEqual(['play', 'playing', 'waiting', 'pause', 'ended', 'error'])
    expect(b.lastError).toBe('mpv error 5')
    await b.dispose()
  })

  it('passes seeking/seeked through', async () => {
    const b = new MpvBackend()
    const onSeeking = vi.fn()
    const onSeeked = vi.fn()
    b.on('seeking', onSeeking)
    b.on('seeked', onSeeked)
    dispatch('mpv://seeking', 0)
    dispatch('mpv://seeked', 0)
    expect(onSeeking).toHaveBeenCalledTimes(1)
    expect(onSeeked).toHaveBeenCalledTimes(1)
    await b.dispose()
  })

  it('load passes the full argument set and reports ok', async () => {
    const b = new MpvBackend()
    b.setVolume(0.7)
    b.setMuted(true)
    const r = await b.load('https://cdn.example/x.m3u8', { kind: 'vod', hwdec: 'auto-safe', startAt: 91.4 })
    expect(r).toEqual({ ok: true })
    expect(invokeMock).toHaveBeenCalledWith('mpv_load', {
      id: 0,
      url: 'https://cdn.example/x.m3u8',
      kind: 'vod',
      startAt: 91.4,
      hwdec: 'auto-safe',
      volume: 0.7,
      muted: true,
    })
    await b.dispose()
  })

  it('load failure carries the invoke error message', async () => {
    const b = new MpvBackend()
    invokeMock.mockRejectedValueOnce('mpv engine unavailable')
    const r = await b.load('x', { kind: 'live', hwdec: 'no' })
    expect(r).toEqual({ ok: false, error: 'mpv engine unavailable' })
    await b.dispose()
  })

  it('dispose unsubscribes (no further event delivery) and stops the engine', async () => {
    const b = new MpvBackend()
    const onTime = vi.fn()
    b.on('timeupdate', onTime)
    await b.dispose()
    expect(invokeMock).toHaveBeenCalledWith('mpv_stop', { id: 0 })
    invokeMock.mockClear()
    dispatch('mpv://time', { id: 0, position: 42, duration: 100 })
    expect(onTime).not.toHaveBeenCalled()
    expect(invokeMock).not.toHaveBeenCalled()
  })

  it('on() unsubscribers work per event', async () => {
    const b = new MpvBackend()
    const cb = vi.fn()
    const off = b.on('timeupdate', cb)
    dispatch('mpv://time', { id: 0, position: 1, duration: 2 })
    off()
    dispatch('mpv://time', { id: 0, position: 2, duration: 2 })
    expect(cb).toHaveBeenCalledTimes(1)
    await b.dispose()
  })

  it('routes events per engine id (tiles coexist with the single player)', async () => {
    const single = new MpvBackend(0)
    const tile = new MpvBackend(2)
    const onSingle = vi.fn()
    const onTile = vi.fn()
    single.on('timeupdate', onSingle)
    tile.on('timeupdate', onTile)
    dispatch('mpv://time', { id: 0, position: 5, duration: 100 })
    dispatch('mpv://time', { id: 2, position: 7, duration: 100 })
    expect(onSingle).toHaveBeenCalledTimes(1)
    expect(onTile).toHaveBeenCalledTimes(1)
    expect(single.currentTime).toBe(5)
    expect(tile.currentTime).toBe(7)
    // Transport writes carry the bound id, so a tile never pauses the
    // single player's engine.
    tile.pause()
    expect(invokeMock).toHaveBeenCalledWith('mpv_set_paused', { id: 2, paused: true })
    await single.dispose()
    await tile.dispose()
  })
})
