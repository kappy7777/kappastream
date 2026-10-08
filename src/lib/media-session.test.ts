import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { bindMediaSessionPlayPause, setMediaSessionTitle } from './media-session'

/*
 * The Media Session helpers against a stubbed navigator.mediaSession. The
 * real engines differ (WebKitGTK partial support, happy-dom none), which is
 * exactly what the feature detection is for — these tests pin the routing
 * semantics: each action toggles only when it would change the state, a
 * rejected action name is skipped without losing the other, unbind removes
 * what was bound, and everything degrades to a no-op without mediaSession
 * or MediaMetadata.
 */

type Handler = (details: MediaSessionActionDetails) => void

function stubMediaSession(opts?: { rejectActions?: string[] }) {
  const handlers = new Map<MediaSessionAction, Handler>()
  const ms = {
    metadata: null as unknown,
    setActionHandler: (action: MediaSessionAction, handler: Handler | null) => {
      if (opts?.rejectActions?.includes(action)) throw new DOMException('not supported', 'NotSupportedError')
      if (handler === null) handlers.delete(action)
      else handlers.set(action, handler)
    },
  }
  Object.defineProperty(navigator, 'mediaSession', { value: ms, configurable: true })
  return {
    fire(action: MediaSessionAction): void {
      handlers.get(action)?.({ action } as MediaSessionActionDetails)
    },
    bound: (): MediaSessionAction[] => [...handlers.keys()],
  }
}

beforeEach(() => {
  stubMediaSession()
})

afterEach(() => {
  Reflect.deleteProperty(navigator, 'mediaSession')
  vi.unstubAllGlobals()
})

describe('bindMediaSessionPlayPause', () => {
  it("a 'pause' action toggles only while the surface is playing", () => {
    const ctx = stubMediaSession()
    let playing = true
    const toggle = vi.fn()
    const unbind = bindMediaSessionPlayPause(() => ({ playing: () => playing, toggle }))

    ctx.fire('pause')
    expect(toggle).toHaveBeenCalledTimes(1)
    // The paused surface ignores further pause presses — never a resume.
    playing = false
    ctx.fire('pause')
    expect(toggle).toHaveBeenCalledTimes(1)
    unbind()
  })

  it("a 'play' action toggles only while the surface is paused", () => {
    const ctx = stubMediaSession()
    let playing = false
    const toggle = vi.fn()
    const unbind = bindMediaSessionPlayPause(() => ({ playing: () => playing, toggle }))

    ctx.fire('play')
    expect(toggle).toHaveBeenCalledTimes(1)
    playing = true
    ctx.fire('play')
    expect(toggle).toHaveBeenCalledTimes(1)
    unbind()
  })

  it('a null target (no stream) swallows the action', () => {
    const ctx = stubMediaSession()
    const toggle = vi.fn()
    const unbind = bindMediaSessionPlayPause(() => null)
    ctx.fire('pause')
    ctx.fire('play')
    expect(toggle).not.toHaveBeenCalled()
    unbind()
  })

  it('unbind removes the handlers', () => {
    const ctx = stubMediaSession()
    expect(ctx.bound()).toEqual([])
    const unbind = bindMediaSessionPlayPause(() => null)
    expect(ctx.bound().sort()).toEqual(['pause', 'play'])
    unbind()
    expect(ctx.bound()).toEqual([])
  })

  it('an action name the engine rejects is skipped; the other still binds', () => {
    const ctx = stubMediaSession({ rejectActions: ['play'] })
    const unbind = bindMediaSessionPlayPause(() => ({ playing: () => true, toggle: () => {} }))
    expect(ctx.bound()).toEqual(['pause'])
    unbind()
    expect(ctx.bound()).toEqual([])
  })

  it('is a harmless no-op without navigator.mediaSession', () => {
    Reflect.deleteProperty(navigator, 'mediaSession')
    Object.defineProperty(navigator, 'mediaSession', { value: undefined, configurable: true })
    const unbind = bindMediaSessionPlayPause(() => ({ playing: () => true, toggle: () => {} }))
    expect(() => unbind()).not.toThrow()
  })
})

describe('setMediaSessionTitle', () => {
  it('writes MediaMetadata with the title, and null clears it', () => {
    class MediaMetadataStub {
      title: string
      constructor(init: { title: string }) {
        this.title = init.title
      }
    }
    vi.stubGlobal('MediaMetadata', MediaMetadataStub)
    const ms = navigator.mediaSession as { metadata: unknown }
    setMediaSessionTitle('chan1')
    expect(ms.metadata).toBeInstanceOf(MediaMetadataStub)
    expect((ms.metadata as MediaMetadataStub).title).toBe('chan1')
    setMediaSessionTitle(null)
    expect(ms.metadata).toBeNull()
  })

  it('does nothing (and does not throw) without MediaMetadata', () => {
    expect(() => setMediaSessionTitle('chan1')).not.toThrow()
  })
})
