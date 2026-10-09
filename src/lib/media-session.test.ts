import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { bindMediaSessionPlayPause, setMediaSessionMetadata } from './media-session'

/*
 * The Media Session helpers against a stubbed navigator.mediaSession. The
 * real engines differ (WebKitGTK partial support, happy-dom none), which is
 * exactly what the feature detection is for — these tests pin the routing
 * semantics: each action toggles only when it would change the state, a
 * rejected action name is skipped without losing the other, unbind removes
 * what was bound, and everything degrades to a no-op without mediaSession
 * or MediaMetadata. (Native-engine media keys are served by the Rust-side
 * MPRIS service, not this module.)
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
    const unbind = bindMediaSessionPlayPause(() => ({ playing: () => true, toggle: () => {} }))
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

describe('setMediaSessionMetadata', () => {
  interface MetadataStub {
    title: string
    artwork?: Array<{ src: string; sizes: string; type: string }>
  }
  function stubMetadata() {
    class MediaMetadataStub {
      title: string
      artwork?: Array<{ src: string; sizes: string; type: string }>
      constructor(init: { title: string; artwork?: Array<{ src: string; sizes: string; type: string }> }) {
        this.title = init.title
        this.artwork = init.artwork
      }
    }
    vi.stubGlobal('MediaMetadata', MediaMetadataStub)
    return MediaMetadataStub
  }

  it('writes MediaMetadata with the title, and null clears it', () => {
    const Stub = stubMetadata()
    const ms = navigator.mediaSession as { metadata: unknown }
    setMediaSessionMetadata('chan1')
    expect(ms.metadata).toBeInstanceOf(Stub)
    expect((ms.metadata as MetadataStub).title).toBe('chan1')
    setMediaSessionMetadata(null)
    expect(ms.metadata).toBeNull()
  })

  it('carries the artwork with an honest mime type when given', () => {
    stubMetadata()
    const ms = navigator.mediaSession as { metadata: unknown }
    setMediaSessionMetadata('chan1', 'https://static-cdn.jtvnw.net/jtv_user_pictures/x-profile_image-70x70.png')
    expect((ms.metadata as MetadataStub).artwork).toEqual([
      {
        src: 'https://static-cdn.jtvnw.net/jtv_user_pictures/x-profile_image-70x70.png',
        sizes: '70x70',
        type: 'image/png',
      },
    ])
    setMediaSessionMetadata('chan1', 'https://static-cdn.jtvnw.net/other.jpg')
    expect((ms.metadata as MetadataStub).artwork?.[0]?.type).toBe('image/jpeg')
  })

  it('artwork without a title keeps a metadata object (empty title), not null', () => {
    stubMetadata()
    const ms = navigator.mediaSession as { metadata: unknown }
    setMediaSessionMetadata(null, 'https://static-cdn.jtvnw.net/x.png')
    expect((ms.metadata as MetadataStub).title).toBe('')
    expect((ms.metadata as MetadataStub).artwork).toHaveLength(1)
  })

  it('does nothing (and does not throw) without MediaMetadata', () => {
    expect(() => setMediaSessionMetadata('chan1')).not.toThrow()
  })
})
