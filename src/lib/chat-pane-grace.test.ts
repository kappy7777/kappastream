// Pins the scroll-grace logic in ChatPane (the follow-snap vs wheel-scroll
// fight): WebKitGTK animates wheel scrolls and assigning scrollTop cancels
// the animation, so an incoming message snapping to the bottom mid-scroll
// killed the scroll and the user could never leave the bottom. The pane now
// holds its snap for a short grace window after each UPWARD wheel tick, then
// re-checks once when the grace ends. Scroll geometry is stubbed per element
// (happy-dom lays nothing out), entries flow through a $state holder so
// pushes are reactive, and time runs on fake timers including
// performance.now — the grace comparisons are all performance-clock based.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mount, unmount } from 'svelte'
import type { ChatEntry } from './merged-chat'
import { ChatPaneTestEntries } from './chat-pane-test-entries.svelte'

const ChatPane = (await import('./ChatPane.svelte')).default

let seq = 0
function entry(): ChatEntry {
  const id = 'm' + ++seq
  return {
    key: id,
    tileId: null,
    channel: null,
    override: null,
    msg: {
      kind: 'message',
      id,
      username: 'user' + seq,
      color: '#FF0000',
      raw: 'hello ' + seq,
      parts: [{ type: 'text', text: 'hello ' + seq }],
      badges: [],
      isAction: false,
      emoteOnly: false,
      timestamp: seq,
      bits: null,
      userId: null,
      login: 'user' + seq,
      deleted: false,
      deletedReason: null,
      systemText: null,
      noticeMsgId: null,
    },
  }
}

/** Stub the layout happy-dom never computes; scrollTop stays writable. */
function stubGeometry(el: HTMLElement, scrollHeight: number, clientHeight: number): void {
  Object.defineProperty(el, 'scrollHeight', { configurable: true, value: scrollHeight })
  Object.defineProperty(el, 'clientHeight', { configurable: true, value: clientHeight })
}

let entries = new ChatPaneTestEntries()
let view: ReturnType<typeof mount> | null = null
let follows: boolean[] = []

function mountPane(): { el: HTMLElement; target: HTMLElement } {
  const target = document.createElement('div')
  document.body.appendChild(target)
  view = mount(ChatPane, {
    target,
    props: {
      entries: entries.current,
      placeholder: 'nothing yet',
      onlink: () => {},
      resetKey: 'test',
      onfollow: (f: boolean) => follows.push(f),
    },
  })
  const el = target.querySelector<HTMLElement>('.chat-pane-scroll')
  if (!el) throw new Error('chat pane scroll container missing')
  stubGeometry(el, 1000, 600)
  return { el, target }
}

async function settle(): Promise<void> {
  await vi.advanceTimersByTimeAsync(0)
  await vi.advanceTimersByTimeAsync(0)
}

beforeEach(() => {
  // The grace window and its deferred re-check read performance.now(), so
  // the performance clock must advance with the timer clock or the "grace
  // expired" branch can never run inside a test.
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance', 'Date'] })
  entries = new ChatPaneTestEntries([entry()])
})

afterEach(() => {
  if (view) void unmount(view)
  view = null
  follows = []
  vi.useRealTimers()
  document.body.innerHTML = ''
})

describe('ChatPane scroll grace', () => {
  it('an upward wheel tick holds the snap through the grace window, then re-checks', async () => {
    const { el } = mountPane()
    await settle()
    expect(el.scrollTop).toBe(1000) // initial follow snapped

    // User scrolls up (animated): wheel tick + a mid-flight position.
    el.dispatchEvent(new WheelEvent('wheel', { deltaY: -120, bubbles: true }))
    el.scrollTop = 400
    entries.push(entry())
    await settle()
    // THE GRACE: the arriving message must NOT snap (that would cancel the
    // in-flight scroll).
    expect(el.scrollTop).toBe(400)

    // Past the 350 ms window the deferred re-check snaps to the bottom.
    await vi.advanceTimersByTimeAsync(360)
    expect(el.scrollTop).toBe(1000)
  })

  it('a downward wheel tick arms nothing — the next message snaps immediately', async () => {
    const { el } = mountPane()
    await settle()
    el.dispatchEvent(new WheelEvent('wheel', { deltaY: 120, bubbles: true }))
    el.scrollTop = 400
    entries.push(entry())
    await settle()
    expect(el.scrollTop).toBe(1000)
  })

  it('ctrl+wheel (the browser zoom gesture) arms nothing', async () => {
    const { el } = mountPane()
    await settle()
    // happy-dom's WheelEvent extends UIEvent, so ctrlKey does not ride the
    // init dict — it has to be patched onto the instance.
    const ev = new WheelEvent('wheel', { deltaY: -120, bubbles: true })
    Object.defineProperty(ev, 'ctrlKey', { value: true })
    el.dispatchEvent(ev)
    el.scrollTop = 400
    entries.push(entry())
    await settle()
    expect(el.scrollTop).toBe(1000)
  })

  it('a detached pane counts unseen messages into the pill; the pill jumps back', async () => {
    const { el, target } = mountPane()
    await settle()

    // Leave the bottom (a real scroll event detaches the follow).
    el.scrollTop = 0
    el.dispatchEvent(new Event('scroll', { bubbles: true }))
    await settle()
    expect(follows.at(-1)).toBe(false)

    entries.push(entry(), entry())
    await settle()
    expect(el.scrollTop).toBe(0) // still reading history — nothing snaps
    const pill = target.querySelector<HTMLElement>('.chat-pane-jump')
    expect(pill).toBeTruthy()
    expect(pill!.querySelector('.chat-pane-jump-count')?.textContent).toBe('2')

    pill!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await settle()
    expect(el.scrollTop).toBe(1000)
    expect(target.querySelector('.chat-pane-jump')).toBeNull()
  })
})
