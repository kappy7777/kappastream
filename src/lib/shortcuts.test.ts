import { describe, it, expect } from 'vitest'
import { resolveShortcut, isEditableTarget, isActivatableTarget, type ShortcutCtx } from './shortcuts'

/*
 * Player keyboard shortcuts. The two load-bearing invariants under test:
 *   1. shortcuts are SUPPRESSED in every editable target (input/textarea/select/
 *      contentEditable) and behind open modals (about/browse/help) — the most
 *      common way this feature ships broken;
 *   2. the rest of the map resolves to the right action, including the live vs
 *      VOD split for the arrow keys (seeking is meaningless on live).
 */

function makeKey(key: string, target: HTMLElement | null = null, mods: Partial<KeyboardEvent> = {}): KeyboardEvent {
  // KeyboardEvent.target is assigned during dispatch (the constructor option
  // is ignored), so dispatch onto the element to populate it.
  const ev = new KeyboardEvent('keydown', { key, bubbles: true, ...mods })
  if (target) target.dispatchEvent(ev)
  return ev
}

const ctx = (over: Partial<ShortcutCtx> = {}): ShortcutCtx => ({
  aboutOpen: false,
  browseOpen: false,
  helpOpen: false,
  welcomeOpen: false,
  isLive: true,
  ...over,
})

function el(tag: string, opts: { contentEditable?: boolean; role?: string } = {}): HTMLElement {
  const node = document.createElement(tag)
  if (opts.contentEditable) node.contentEditable = 'true'
  if (opts.role) node.setAttribute('role', opts.role)
  return node
}

describe('isEditableTarget', () => {
  it('flags input, textarea, and select', () => {
    expect(isEditableTarget(el('input'))).toBe(true)
    expect(isEditableTarget(el('textarea'))).toBe(true)
    expect(isEditableTarget(el('select'))).toBe(true)
  })

  it('flags contentEditable elements', () => {
    const div = el('div', { contentEditable: true })
    expect(isEditableTarget(div)).toBe(true)
  })

  it('does not flag buttons / divs / the body', () => {
    expect(isEditableTarget(el('button'))).toBe(false)
    expect(isEditableTarget(el('div'))).toBe(false)
    expect(isEditableTarget(document.body)).toBe(false)
  })

  it('is safe for non-element targets', () => {
    expect(isEditableTarget(null)).toBe(false)
  })
})

describe('isActivatableTarget (Space must not double-fire)', () => {
  it('flags buttons, links, and ARIA widget roles', () => {
    expect(isActivatableTarget(el('button'))).toBe(true)
    expect(isActivatableTarget(el('a'))).toBe(true)
    expect(isActivatableTarget(el('div', { role: 'switch' }))).toBe(true)
    expect(isActivatableTarget(el('div', { role: 'radio' }))).toBe(true)
    expect(isActivatableTarget(el('div', { role: 'tab' }))).toBe(true)
  })

  it('does not flag plain divs or the video element', () => {
    expect(isActivatableTarget(el('div'))).toBe(false)
    expect(isActivatableTarget(el('video'))).toBe(false)
  })
})

describe('shortcuts are suppressed in every text input', () => {
  for (const tag of ['input', 'textarea', 'select']) {
    it(`${tag}: typing "m" is NOT mute`, () => {
      const target = el(tag)
      expect(resolveShortcut(makeKey('m', target), ctx())).toBeNull()
    })
    it(`${tag}: Space is NOT play/pause`, () => {
      const target = el(tag)
      expect(resolveShortcut(makeKey(' ', target), ctx())).toBeNull()
    })
    it(`${tag}: arrows are NOT volume/seek`, () => {
      const target = el(tag)
      expect(resolveShortcut(makeKey('ArrowLeft', target), ctx())).toBeNull()
      expect(resolveShortcut(makeKey('ArrowUp', target), ctx())).toBeNull()
    })
  }

  it('contentEditable: typing "f" is NOT fullscreen', () => {
    const target = el('div', { contentEditable: true })
    expect(resolveShortcut(makeKey('f', target), ctx())).toBeNull()
  })
})

describe('shortcuts are a no-op behind open modals/overlays', () => {
  it('about modal open: every player shortcut is suppressed', () => {
    const c = ctx({ aboutOpen: true })
    expect(resolveShortcut(makeKey(' ', null), c)).toBeNull()
    expect(resolveShortcut(makeKey('f', null), c)).toBeNull()
    expect(resolveShortcut(makeKey('m', null), c)).toBeNull()
  })

  it('browse overlay open: every player shortcut is suppressed', () => {
    const c = ctx({ browseOpen: true })
    expect(resolveShortcut(makeKey('k', null), c)).toBeNull()
    expect(resolveShortcut(makeKey('t', null), c)).toBeNull()
  })

  it('help overlay open: player shortcuts suppressed, Escape closes help', () => {
    const c = ctx({ helpOpen: true })
    expect(resolveShortcut(makeKey(' ', null), c)).toBeNull()
    expect(resolveShortcut(makeKey('Escape', null), c)).toEqual({ type: 'close-help' })
  })

  it('welcome/what\'s-new overlay open: player shortcuts suppressed, Escape closes it', () => {
    const c = ctx({ welcomeOpen: true })
    expect(resolveShortcut(makeKey(' ', null), c)).toBeNull()
    expect(resolveShortcut(makeKey('f', null), c)).toBeNull()
    expect(resolveShortcut(makeKey('m', null), c)).toBeNull()
    expect(resolveShortcut(makeKey('Escape', null), c)).toEqual({ type: 'close-welcome' })
  })
})

describe('Escape + modifiers', () => {
  it('Escape closes the about modal when it is open', () => {
    expect(resolveShortcut(makeKey('Escape', null), ctx({ aboutOpen: true }))).toEqual({ type: 'close-about' })
  })

  it('Escape closes the welcome overlay when it is open (highest priority)', () => {
    // Welcome is the topmost overlay visually; Escape wins over about/help.
    expect(resolveShortcut(makeKey('Escape', null), ctx({ welcomeOpen: true }))).toEqual({ type: 'close-welcome' })
    expect(
      resolveShortcut(makeKey('Escape', null), ctx({ welcomeOpen: true, aboutOpen: true })),
    ).toEqual({ type: 'close-welcome' })
  })

  it('Escape does nothing when no overlay is open', () => {
    expect(resolveShortcut(makeKey('Escape', null), ctx())).toBeNull()
  })

  it('Escape still works while focused in a text field (closes the about modal)', () => {
    const target = el('input')
    expect(resolveShortcut(makeKey('Escape', target), ctx({ aboutOpen: true }))).toEqual({ type: 'close-about' })
  })

  it('Ctrl/Cmd/Alt chords are ignored (no hijack of browser shortcuts)', () => {
    expect(resolveShortcut(makeKey('f', null, { ctrlKey: true }), ctx())).toBeNull()
    expect(resolveShortcut(makeKey('k', null, { metaKey: true }), ctx())).toBeNull()
    expect(resolveShortcut(makeKey('m', null, { altKey: true }), ctx())).toBeNull()
  })
})

describe('key map (default, no overlay, body focused)', () => {
  it('Space and K toggle play/pause', () => {
    expect(resolveShortcut(makeKey(' ', null), ctx())).toEqual({ type: 'play-pause' })
    expect(resolveShortcut(makeKey('k', null), ctx())).toEqual({ type: 'play-pause' })
  })

  it('M mutes, F fullscreen, T theater', () => {
    expect(resolveShortcut(makeKey('m', null), ctx())).toEqual({ type: 'toggle-mute' })
    expect(resolveShortcut(makeKey('f', null), ctx())).toEqual({ type: 'toggle-fullscreen' })
    expect(resolveShortcut(makeKey('t', null), ctx())).toEqual({ type: 'toggle-theater' })
  })

  it('? toggles the help overlay', () => {
    expect(resolveShortcut(makeKey('?', null), ctx())).toEqual({ type: 'toggle-help' })
  })

  it('an unknown key resolves to null', () => {
    expect(resolveShortcut(makeKey('z', null), ctx())).toBeNull()
    expect(resolveShortcut(makeKey('1', null), ctx())).toBeNull()
  })
})

describe('arrows: seek on VOD, volume on live', () => {
  it('live: left/right nudge volume (seeking is meaningless)', () => {
    const c = ctx({ isLive: true })
    expect(resolveShortcut(makeKey('ArrowLeft', null), c)).toEqual({ type: 'volume', delta: -0.05 })
    expect(resolveShortcut(makeKey('ArrowRight', null), c)).toEqual({ type: 'volume', delta: 0.05 })
  })

  it('VOD/clip: left/right seek ±10s', () => {
    const c = ctx({ isLive: false })
    expect(resolveShortcut(makeKey('ArrowLeft', null), c)).toEqual({ type: 'seek', delta: -10 })
    expect(resolveShortcut(makeKey('ArrowRight', null), c)).toEqual({ type: 'seek', delta: 10 })
  })

  it('up/down always nudge volume (both live and VOD)', () => {
    for (const isLive of [true, false]) {
      const c = ctx({ isLive })
      expect(resolveShortcut(makeKey('ArrowUp', null), c)).toEqual({ type: 'volume', delta: 0.05 })
      expect(resolveShortcut(makeKey('ArrowDown', null), c)).toEqual({ type: 'volume', delta: -0.05 })
    }
  })
})

describe('Space on a focused button/switch does not double-fire', () => {
  it('a focused <button>: Space is NOT play/pause', () => {
    expect(resolveShortcut(makeKey(' ', el('button')), ctx())).toBeNull()
  })

  it('a focused role=switch: Space is NOT play/pause', () => {
    expect(resolveShortcut(makeKey(' ', el('div', { role: 'switch' })), ctx())).toBeNull()
  })

  it('a focused <video>: Space IS play/pause', () => {
    expect(resolveShortcut(makeKey(' ', el('video')), ctx())).toEqual({ type: 'play-pause' })
  })
})
