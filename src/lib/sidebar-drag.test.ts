// Pins the Manual-only drag gate on sidebar rows. Auto sort ignores the
// manual order entirely (live-first by viewership), so a drag-drop in Auto
// showed a drop line, snapped the list back, and silently rewrote the
// hidden manual order that only shows up once the user later switches to
// Manual. Rows must only be draggable in Manual sort.
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

function rows(): HTMLElement[] {
  return [...document.querySelectorAll<HTMLElement>('.fav')]
}

afterEach(() => {
  if (view) void unmount(view)
  view = null
  settings.setSortMode('auto')
  localStorage.clear()
})

describe('sidebar drag-to-reorder gating', () => {
  it('rows are draggable only in Manual sort', async () => {
    const target = document.createElement('div')
    document.body.appendChild(target)
    view = mount(Sidebar, { target, props: { currentChannel: null, onselect: () => {} } })
    await tick()
    expect(rows()).toHaveLength(2)

    // Default install: Auto sort — no dragging.
    expect(settings.sortMode).toBe('auto')
    expect(rows()[0].getAttribute('draggable')).toBe('false')

    settings.setSortMode('manual')
    await tick()
    expect(rows()[0].getAttribute('draggable')).toBe('true')

    settings.setSortMode('auto')
    await tick()
    expect(rows()[0].getAttribute('draggable')).toBe('false')
    target.remove()
  })
})
