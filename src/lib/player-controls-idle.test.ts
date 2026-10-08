// Pins the control-bar idle-hide suspension. The bar used to vanish after
// the idle window even while the pointer was ON it or inside the quality
// menu: the <video>'s mouse listeners are the only activity source, and
// .controls plus its full-screen .menu-backdrop sit above the element and
// swallow every move, so nothing refreshed the idle timer. The bar must
// stay up while the pointer is over it, while the menu is open, and while
// keyboard focus is inside it — and resume hiding once each engagement
// ends.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mount, unmount, tick } from 'svelte'

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

let view: ReturnType<typeof mount> | null = null
let video: HTMLVideoElement | null = null
let target: HTMLDivElement | null = null

function controls(): HTMLElement | null {
  return document.querySelector('.controls')
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] })
  target = document.createElement('div')
  document.body.appendChild(target)
  video = document.createElement('video')
  document.body.appendChild(video)
  view = mount(PlayerControls, {
    target,
    props: {
      video,
      backend: makeBackend(),
      visible: true,
      quality: 'auto',
      onqualitychange: () => {},
      onmpv: () => {},
      onstop: () => {},
      onplayintent: () => {},
      activeStatus: { state: 'unknown' } satisfies LiveStatus,
      isFullscreen: false,
      ontogglefullscreen: () => {},
    },
  })
})

afterEach(() => {
  if (view) void unmount(view)
  view = null
  video?.remove()
  target?.remove()
  video = null
  target = null
  vi.useRealTimers()
})

describe('control-bar idle hide', () => {
  it('hides after the idle window with no activity', async () => {
    expect(controls()).not.toBeNull()
    await vi.advanceTimersByTimeAsync(4_100)
    expect(controls()).toBeNull()
  })

  it('stays up while the pointer is over the controls', async () => {
    controls()!.dispatchEvent(new MouseEvent('pointerenter'))
    await vi.advanceTimersByTimeAsync(4_100)
    expect(controls()).not.toBeNull()
    // Leaving hands the stage back to the idle hide.
    controls()!.dispatchEvent(new MouseEvent('pointerleave'))
    await vi.advanceTimersByTimeAsync(4_100)
    expect(controls()).toBeNull()
  })

  it('refreshes the idle timer on moves over the bar', async () => {
    await vi.advanceTimersByTimeAsync(1_000)
    controls()!.dispatchEvent(new MouseEvent('pointermove', { bubbles: true }))
    await vi.advanceTimersByTimeAsync(3_000)
    expect(controls()).not.toBeNull()
    await vi.advanceTimersByTimeAsync(1_500)
    expect(controls()).toBeNull()
  })

  it('stays up while the quality menu is open, hides after it closes', async () => {
    const gear = [...document.querySelectorAll<HTMLButtonElement>('.ctrl-btn')].find((b) =>
      b.parentElement?.classList.contains('menu-wrap'),
    )
    gear!.click()
    await tick()
    expect(document.querySelector('.menu')).not.toBeNull()
    // No pointer engagement in this scenario — the open menu alone must
    // carry the suspension.
    await vi.advanceTimersByTimeAsync(4_100)
    expect(document.querySelector('.menu')).not.toBeNull()
    expect(controls()).not.toBeNull()
    ;(document.querySelector('.menu-backdrop') as HTMLButtonElement).click()
    await tick()
    expect(document.querySelector('.menu')).toBeNull()
    await vi.advanceTimersByTimeAsync(4_100)
    expect(controls()).toBeNull()
  })

  it('stays up while keyboard focus is inside the controls', async () => {
    controls()!.dispatchEvent(new Event('focusin', { bubbles: true }))
    await vi.advanceTimersByTimeAsync(4_100)
    expect(controls()).not.toBeNull()
    controls()!.dispatchEvent(new Event('focusout', { bubbles: true }))
    await vi.advanceTimersByTimeAsync(4_100)
    expect(controls()).toBeNull()
  })
})
