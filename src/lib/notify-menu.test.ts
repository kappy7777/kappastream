// Pins the notification bell panel's unread stripe. Opening the panel marks
// everything read at once (badge + aria count reset immediately), but the
// entries that were unread when it opened keep their accent stripe until the
// panel is closed and reopened — marking on open alone rendered every row
// already-read, so the stripe never showed at all. Entries recorded while the
// panel is open stripe via their own read flag.
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

const NotifyMenu = (await import('./NotifyMenu.svelte')).default
const { notifications } = await import('./notifications.svelte.ts')

let view: ReturnType<typeof mount> | null = null

function items(): HTMLElement[] {
  return [...document.querySelectorAll<HTMLElement>('.notif-item')]
}

afterEach(() => {
  if (view) void unmount(view)
  view = null
  notifications.clear()
})

describe('notify panel unread stripe', () => {
  it('stripes what was unread at open, keeps read rows plain, and resets on reopen', async () => {
    notifications.record('live', 'a is live', 'x', 'a')
    notifications.record('mention', 'mentioned', '', null)
    notifications.markAllRead()
    notifications.record('live', 'b is live', 'y', 'b') // the one unread entry

    const target = document.createElement('div')
    document.body.appendChild(target)
    view = mount(NotifyMenu, { target })
    await tick()
    target.querySelector<HTMLButtonElement>('.notify-btn')!.click()
    await tick()

    // Newest first: b (unread at open) stripes; the two read rows stay plain.
    const stripes = items().map((el) => el.dataset.unread)
    expect(stripes).toEqual(['true', 'false', 'false'])
    // Everything is read the moment the panel opens.
    expect(notifications.unreadCount).toBe(0)

    // An entry arriving while the panel is open stripes via its own flag.
    notifications.record('live', 'c is live', 'z', 'c')
    await tick()
    expect(items()[0].dataset.unread).toBe('true')

    // Close and reopen. The entry that arrived while open was never marked
    // read (the badge counted it after close), so it alone stripes; the
    // originally-unread row does not return.
    target.querySelector<HTMLButtonElement>('.notify-btn')!.click()
    await tick()
    expect(notifications.unreadCount).toBe(1)
    target.querySelector<HTMLButtonElement>('.notify-btn')!.click()
    await tick()
    expect(items().map((el) => el.dataset.unread)).toEqual(['true', 'false', 'false', 'false'])
    target.remove()
  })
})
