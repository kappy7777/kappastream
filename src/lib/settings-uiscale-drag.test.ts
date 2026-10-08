// Pins the deferred UI-scale commit. The settings modal is centered and
// zooms with the document root, so applying each stop the moment the knob
// passes it rescales the track under the captured pointer: the pointer's
// fraction of the track flips direction and a one-way drag ping-pongs
// between stops. The drag must only move the knob (and the pending value
// readouts); setUiScale is committed exactly once, on pointerup, and an
// aborted drag (pointercancel) reverts without committing.
import { describe, it, expect, vi, afterEach } from 'vitest'
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

const Settings = (await import('./Settings.svelte')).default
const { settings, UI_SCALE_DEFAULT } = await import('./settings.svelte.ts')

// Presets [0.5, 0.75, 1, 1.25, 1.5, 2, 2.5, 3, 4]: index 4 = 1.5× (the
// default 1× sits at index 2, one stop left of it), index 8 = 4×.
const IDX_150 = 4
const IDX_MAX = 8

const RECT_LEFT = 100
const RECT_WIDTH = 200

function clientXForIndex(i: number): number {
  return RECT_LEFT + (i / IDX_MAX) * RECT_WIDTH
}

function makeRect(): DOMRect {
  return {
    x: RECT_LEFT,
    y: 100,
    left: RECT_LEFT,
    right: RECT_LEFT + RECT_WIDTH,
    top: 100,
    bottom: 120,
    width: RECT_WIDTH,
    height: 20,
    toJSON: () => ({}),
  } as DOMRect
}

function pointer(type: string, clientX: number): MouseEvent {
  return new MouseEvent(type, { bubbles: true, clientX })
}

function scaleLine(): HTMLElement {
  const el = document.querySelector<HTMLElement>('.scale-line')
  if (!el) throw new Error('missing .scale-line')
  return el
}

function knobPct(): string {
  const knob = document.querySelector<HTMLElement>('.scale-knob')
  if (!knob) throw new Error('missing .scale-knob')
  return knob.style.left
}

function scaleValueText(): string {
  const el = document.querySelector<HTMLElement>('.scale-value')
  if (!el) throw new Error('missing .scale-value')
  return el.textContent ?? ''
}

let view: ReturnType<typeof mount> | null = null
let target: HTMLDivElement | null = null
let rectSpy: ReturnType<typeof vi.spyOn> | null = null

afterEach(() => {
  rectSpy?.mockRestore()
  rectSpy = null
  if (view) void unmount(view)
  view = null
  target?.remove()
  target = null
  settings.setUiScale(UI_SCALE_DEFAULT)
  localStorage.clear()
})

describe('UI-scale line drag commits on release', () => {
  it('moves the knob while dragging and applies the scale once on pointerup', async () => {
    target = document.createElement('div')
    document.body.appendChild(target)
    view = mount(Settings, { target })
    await tick()

    // The panel itself opens from its gear button; the scale line lives in
    // the Appearance section.
    ;(document.querySelector('.settings-btn') as HTMLButtonElement).click()
    await tick()
    const appearanceBtn = [...document.querySelectorAll<HTMLButtonElement>('.settings-nav-item')].find((b) =>
      /appearance/i.test(b.textContent ?? ''),
    )
    appearanceBtn!.click()
    await tick()

    const line = scaleLine()
    rectSpy = vi.spyOn(line, 'getBoundingClientRect').mockReturnValue(makeRect())
    line.setPointerCapture = () => {}
    line.releasePointerCapture = () => {}

    expect(settings.uiScale).toBe(UI_SCALE_DEFAULT)

    // Press on the max stop: knob + value readouts move, nothing applies.
    line.dispatchEvent(pointer('pointerdown', clientXForIndex(IDX_MAX)))
    await tick()
    expect(settings.uiScale).toBe(UI_SCALE_DEFAULT)
    expect(knobPct()).toBe('100%')
    expect(scaleValueText()).toBe('4×')

    // Drag back to the 1.5× stop: still only the visuals.
    line.dispatchEvent(pointer('pointermove', clientXForIndex(IDX_150)))
    await tick()
    expect(settings.uiScale).toBe(UI_SCALE_DEFAULT)
    expect(knobPct()).toBe('50%')
    expect(scaleValueText()).toBe('1.5×')

    // Release commits exactly the stop under the knob.
    line.dispatchEvent(pointer('pointerup', clientXForIndex(IDX_150)))
    await tick()
    expect(settings.uiScale).toBe(1.5)
    expect(knobPct()).toBe('50%')

    // An aborted drag reverts without committing.
    line.dispatchEvent(pointer('pointerdown', clientXForIndex(IDX_150)))
    await tick()
    line.dispatchEvent(pointer('pointermove', clientXForIndex(IDX_MAX)))
    await tick()
    expect(knobPct()).toBe('100%')
    line.dispatchEvent(new MouseEvent('pointercancel', { bubbles: true }))
    await tick()
    expect(settings.uiScale).toBe(1.5)
    expect(knobPct()).toBe('50%')
    expect(scaleValueText()).toBe('1.5×')
  })
})
