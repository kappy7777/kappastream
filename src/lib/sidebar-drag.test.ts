// Pins the pointer-driven drag-to-reorder on sidebar rows. Two contracts:
//
// 1. Manual sort (switched LIVE, no remount): pressing a row and moving it
//    past the threshold floats a full clone of the row, tracks the hovered
//    sibling via geometry (the drop indicator), and releasing reorders.
//    This replaces HTML5 drag-and-drop, whose dragover events the webview
//    stopped delivering to the rows once they changed at runtime — the
//    drag picked up but no drop was accepted anywhere until a restart.
// 2. Auto sort: presses stay plain clicks — no drag starts, so no drop
//    line can promise a reorder that Auto sort would silently swallow
//    (it ignores the manual order entirely).
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
if (!('setPointerCapture' in Element.prototype)) {
  const proto = Element.prototype as unknown as {
    setPointerCapture?: () => void
    releasePointerCapture?: () => void
  }
  proto.setPointerCapture = (): void => {}
  proto.releasePointerCapture = (): void => {}
}

localStorage.setItem(
  'twitch-favorites-v1',
  JSON.stringify([
    { name: 'chan1', addedAt: 1, order: 1 },
    { name: 'chan2', addedAt: 2, order: 2 },
  ]),
)

const Sidebar = (await import('./Sidebar.svelte')).default
const { settings } = await import('./settings.svelte.ts')

let view: ReturnType<typeof mount> | null = null
let rectSpy: ReturnType<typeof vi.spyOn> | null = null

function rows(): HTMLElement[] {
  return [...document.querySelectorAll<HTMLElement>('.sidebar .fav')].filter((el) => !el.dataset.dragGhost)
}

function pointer(type: string, target: Element, x: number, y: number): void {
  target.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0 }))
}

function storedOrder(): string[] {
  const raw = localStorage.getItem('twitch-favorites-v1') ?? '[]'
  return (JSON.parse(raw) as { name: string }[]).map((e) => e.name)
}

afterEach(() => {
  rectSpy?.mockRestore()
  rectSpy = null
  if (view) void unmount(view)
  view = null
  document.querySelectorAll('[data-drag-ghost]').forEach((el) => el.remove())
  settings.setSortMode('auto')
  localStorage.setItem(
    'twitch-favorites-v1',
    JSON.stringify([
      { name: 'chan1', addedAt: 1, order: 1 },
      { name: 'chan2', addedAt: 2, order: 2 },
    ]),
  )
})

describe('sidebar pointer drag-to-reorder', () => {
  it('reorders after a live switch to manual: clone, indicator, drop', async () => {
    // Row geometry: two 42px rows, one below the other.
    rectSpy = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      const i = this.dataset.favName === 'chan2' ? 1 : 0
      const top = i * 42
      return {
        x: 0,
        y: top,
        left: 0,
        top,
        right: 220,
        bottom: top + 42,
        width: 220,
        height: 42,
        toJSON: () => ({}),
      } as DOMRect
    })

    const onselect = vi.fn()
    const target = document.createElement('div')
    document.body.appendChild(target)
    // zoomK 2 pins the coordinate spaces: pointer + rects are visual, the
    // ghost's css translate/width must be divided by the factor.
    view = mount(Sidebar, { target, props: { currentChannel: null, onselect, zoomK: 2 } })
    await tick()
    expect(rows()).toHaveLength(2)

    // LIVE switch (no remount) — this is the path that used to die.
    settings.setSortMode('manual')
    await tick()

    // Press on chan1, still below the threshold: nothing floats yet.
    pointer('pointerdown', rows()[0], 100, 20)
    pointer('pointermove', rows()[0], 100, 22)
    expect(document.querySelector('[data-drag-ghost]')).toBeNull()

    // Cross the threshold: a clone of the row floats and follows. Grab
    // offset (100, 20) visual → css translate (0, 21) at the 2× factor;
    // row width 220 visual → 110 css.
    pointer('pointermove', rows()[0], 100, 62)
    const ghost = document.querySelector<HTMLElement>('[data-drag-ghost]')
    expect(ghost).not.toBeNull()
    expect(ghost!.textContent).toContain('chan1')
    expect(ghost!.style.transform).toBe('translate(0px, 21px)')
    expect(ghost!.style.width).toBe('110px')

    // Hovering chan2's band shows the drop indicator there.
    await tick()
    expect(rows()[1].classList.contains('fav--drag-over')).toBe(true)

    // Release: the reorder lands without a restart.
    pointer('pointerup', rows()[0], 100, 62)
    await tick()
    expect(storedOrder()).toEqual(['chan2', 'chan1'])
    expect(rows()[0].dataset.favName).toBe('chan2')
    expect(document.querySelector('[data-drag-ghost]')).toBeNull()

    // The drag must not double as a row click: the trailing click the
    // browser fires on the (now moved) original node is swallowed…
    rows()[1].click()
    expect(onselect).not.toHaveBeenCalled()
    // …and a plain click afterwards still selects.
    rows()[0].click()
    expect(onselect).toHaveBeenCalledWith('chan2')
    target.remove()
  })

  it('auto sort: presses never become drags', async () => {
    const onselect = vi.fn()
    const target = document.createElement('div')
    document.body.appendChild(target)
    view = mount(Sidebar, { target, props: { currentChannel: null, onselect } })
    await tick()

    pointer('pointerdown', rows()[0], 100, 20)
    pointer('pointermove', rows()[0], 100, 200)
    pointer('pointerup', rows()[0], 100, 200)
    await tick()

    expect(document.querySelector('[data-drag-ghost]')).toBeNull()
    expect(rows()[0].dataset.favName).toBe('chan1')
    expect(storedOrder()).toEqual(['chan1', 'chan2'])
    target.remove()
  })
})
