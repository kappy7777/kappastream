// Pins the external-player button's render gate: live-only AND only where a
// handler was passed. App omits `onmpv` on builds without the handoff (the
// Flatpak sandbox cannot start programs on the host), and the button must
// disappear with it — a dead button that errors on click is worse than none.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mount, unmount } from 'svelte'

vi.mock('@tauri-apps/api/core', () => ({
  isTauri: () => false,
  invoke: vi.fn(async () => ({})),
}))
vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(async () => () => {}),
  emit: vi.fn(async () => {}),
}))
vi.mock('@tauri-apps/api/webviewWindow', () => ({
  WebviewWindow: class {},
}))

if (!('ResizeObserver' in globalThis)) {
  globalThis.ResizeObserver = class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  } as unknown as typeof ResizeObserver
}

import PlayerControls from './PlayerControls.svelte'
import type { VideoBackend } from './video-backend'
import type { LiveStatus } from './favorites.svelte'

function makeBackend(): VideoBackend {
  return {
    currentTime: 0,
    duration: NaN,
    paused: true,
    volume: 1,
    muted: false,
    buffered: 0,
    aspect: 16 / 9,
    play: async () => {},
    pause: () => {},
    seek: () => {},
    setVolume: () => {},
    setMuted: () => {},
    on: () => () => {},
    dispose: () => {},
  }
}

// Untyped return on purpose: the inferred concrete object type keeps the
// per-test spreads checkable against the component's Props.
function baseProps() {
  return {
    video: document.createElement('video'),
    backend: makeBackend(),
    visible: true,
    quality: 'auto',
    onqualitychange: () => {},
    onstop: () => {},
    onplayintent: () => {},
    activeStatus: { state: 'unknown' } satisfies LiveStatus,
    isFullscreen: false,
    ontogglefullscreen: () => {},
  }
}

function mpvButton(): HTMLButtonElement | null {
  return document.querySelector<HTMLButtonElement>('button[aria-label="Play in mpv"]')
}

let view: ReturnType<typeof mount> | null = null
let player: HTMLElement | null = null

beforeEach(() => {
  player = document.createElement('section')
  player.className = 'player'
  document.body.appendChild(player)
})

afterEach(() => {
  if (view) void unmount(view)
  view = null
  player?.remove()
  player = null
})

describe('external-player button gate', () => {
  it('renders on a live stream when the handler is passed', () => {
    view = mount(PlayerControls, {
      target: player!,
      props: { ...baseProps(), live: true, onmpv: () => {} },
    })
    expect(mpvButton()).not.toBeNull()
  })

  it('is absent without a handler (builds without the handoff)', () => {
    view = mount(PlayerControls, {
      target: player!,
      props: { ...baseProps(), live: true },
    })
    expect(mpvButton()).toBeNull()
  })

  it('is absent during VOD/clip playback even with a handler', () => {
    view = mount(PlayerControls, {
      target: player!,
      props: { ...baseProps(), live: false, onmpv: () => {} },
    })
    expect(mpvButton()).toBeNull()
  })

  it('forwards clicks to the passed handler only', async () => {
    const onmpv = vi.fn()
    view = mount(PlayerControls, {
      target: player!,
      props: { ...baseProps(), live: true, onmpv },
    })
    mpvButton()!.click()
    expect(onmpv).toHaveBeenCalledTimes(1)
  })
})
