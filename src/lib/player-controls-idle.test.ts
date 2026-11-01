// Pins the control-bar idle-hide suspension. The bar used to vanish after
// the idle window even while the pointer was ON it or inside the quality
// menu: the <video>'s mouse listeners are the only activity source, and
// .controls plus its full-screen .menu-backdrop sit above the element and
// swallow every move, so nothing refreshed the idle timer. The bar must
// stay up while the pointer is over it, while the menu is open, and while
// keyboard focus is inside it — and resume hiding once each engagement
// ends.
//
// Also pins the leave semantics: the bar hides AT ONCE when the pointer
// leaves the whole .player box (not after the idle window), and click
// focus inside the bar must never suspend the hide — WebKitGTK focuses a
// control on mousedown, and that click-focused button used to pin the bar
// open forever (no pointer event can clear a focus flag).
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
let player: HTMLElement | null = null

function controls(): HTMLElement | null {
  return document.querySelector('.controls')
}

// The harness mirrors App's single-view DOM: the anchor <video> and the
// mounted bar are siblings inside section.player, which is the region the
// immediate hide rides on (resolved via video.closest('.player')).
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] })
  player = document.createElement('section')
  player.className = 'player'
  document.body.appendChild(player)
  const video = document.createElement('video')
  player.appendChild(video)
  view = mount(PlayerControls, {
    target: player,
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
  player?.remove()
  player = null
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
    const btn = document.querySelector<HTMLButtonElement>('.ctrl-btn--play')!
    btn.focus()
    btn.dispatchEvent(new Event('focusin', { bubbles: true }))
    await vi.advanceTimersByTimeAsync(4_100)
    expect(controls()).not.toBeNull()
    btn.dispatchEvent(new Event('focusout', { bubbles: true }))
    await vi.advanceTimersByTimeAsync(4_100)
    expect(controls()).toBeNull()
  })
})

describe('control-bar leave semantics', () => {
  it('hides at once when the pointer leaves the whole player box', async () => {
    expect(controls()).not.toBeNull()
    player!.dispatchEvent(new MouseEvent('pointerleave'))
    await tick()
    expect(controls()).toBeNull()
  })

  it('is not pinned open by click focus inside the controls', async () => {
    // WebKitGTK focuses a control on mousedown, and :focus-visible is
    // false for that mouse-focused button. happy-dom equates the
    // pseudo-class with being the active element, so a focusin dispatched
    // on an unfocused button stands in for the click-focused target.
    const btn = document.querySelector<HTMLButtonElement>('.ctrl-btn--play')!
    btn.dispatchEvent(new Event('focusin', { bubbles: true }))
    await vi.advanceTimersByTimeAsync(4_100)
    expect(controls()).toBeNull()
  })

  it('does not flash-hide when the pointer moves from the video onto the bar', async () => {
    // The video's own leave must never hide the bar: the immediate hide
    // rides .player only, and moving onto the bar (a sibling overlaying
    // the video's bottom strip) crosses only the video's boundary.
    const video = player!.querySelector('video')!
    video.dispatchEvent(new MouseEvent('mouseenter'))
    controls()!.dispatchEvent(new MouseEvent('pointerenter'))
    video.dispatchEvent(new MouseEvent('mouseleave'))
    await tick()
    expect(controls()).not.toBeNull()
  })

  it('stays up across a player leave while keyboard focus is inside', async () => {
    const btn = document.querySelector<HTMLButtonElement>('.ctrl-btn--play')!
    btn.focus()
    btn.dispatchEvent(new Event('focusin', { bubbles: true }))
    player!.dispatchEvent(new MouseEvent('pointerleave'))
    await tick()
    expect(controls()).not.toBeNull()
    btn.dispatchEvent(new Event('focusout', { bubbles: true }))
    await vi.advanceTimersByTimeAsync(4_100)
    expect(controls()).toBeNull()
  })

  it('ends the keyboard hold on a pointer press inside the bar', async () => {
    const btn = document.querySelector<HTMLButtonElement>('.ctrl-btn--play')!
    btn.focus()
    btn.dispatchEvent(new Event('focusin', { bubbles: true }))
    await vi.advanceTimersByTimeAsync(4_100)
    expect(controls()).not.toBeNull()
    controls()!.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }))
    // The bump rides the pointerdown, so the idle window restarts
    // mid-timeline — advance past the NEXT interval tick after the full
    // 4s window, not just 4.1s from the mount.
    await vi.advanceTimersByTimeAsync(4_600)
    expect(controls()).toBeNull()
  })

  it('keeps the bar fed by key interaction alone (click-focused scrubber)', async () => {
    // A CLICK-focused control gets no keyboard focus hold, but arrow use
    // with the pointer at rest must still keep the bar alive: without the
    // keydown bump the idle hide would unmount the bar — and the focused
    // scrubber with it — mid-seek.
    controls()!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }))
    await vi.advanceTimersByTimeAsync(3_000)
    controls()!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }))
    await vi.advanceTimersByTimeAsync(3_000)
    expect(controls()).not.toBeNull()
    await vi.advanceTimersByTimeAsync(4_600)
    expect(controls()).toBeNull()
  })

  it('keeps the bar and menu through a player leave while the menu is open', async () => {
    const gear = [...document.querySelectorAll<HTMLButtonElement>('.ctrl-btn')].find((b) =>
      b.parentElement?.classList.contains('menu-wrap'),
    )
    gear!.click()
    await tick()
    // Structurally unreachable live (the fixed .menu-backdrop is a
    // .player descendant, so the leave cannot fire while it covers the
    // window) — the guard is defensive and pinned as such.
    player!.dispatchEvent(new MouseEvent('pointerleave'))
    await tick()
    expect(document.querySelector('.menu')).not.toBeNull()
    expect(controls()).not.toBeNull()
    ;(document.querySelector('.menu-backdrop') as HTMLButtonElement).click()
    await tick()
    await vi.advanceTimersByTimeAsync(4_100)
    expect(controls()).toBeNull()
  })

  it('does not hide at once when the pointer leaves the bar but stays in the player', async () => {
    controls()!.dispatchEvent(new MouseEvent('pointerenter'))
    controls()!.dispatchEvent(new MouseEvent('pointerleave'))
    await tick()
    expect(controls()).not.toBeNull()
    await vi.advanceTimersByTimeAsync(4_100)
    expect(controls()).toBeNull()
  })
})
