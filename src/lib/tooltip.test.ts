import { describe, it, expect, afterEach, vi } from 'vitest'
import { tooltip } from './tooltip'
import { tooltipState } from './tooltip.svelte.ts'

/*
 * The `use:tooltip` action's lifecycle contract. The load-bearing case is
 * destroy: a host unmounted while hovered (a button that hides its own
 * container, a chat row rolling off) never receives mouseleave — there is
 * no element left to deliver it — so destroy must clear the node's OWN
 * tooltip while leaving a different host's live tooltip untouched.
 */

function mountHost(params: string | { text: string; delay?: number }): { node: HTMLElement; destroy(): void } {
  const node = document.createElement('button')
  document.body.appendChild(node)
  const action = tooltip(node, params)
  return {
    node,
    destroy() {
      action?.destroy?.()
      node.remove()
    },
  }
}

function hover(node: HTMLElement): void {
  node.dispatchEvent(new MouseEvent('mouseenter'))
}

function unhover(node: HTMLElement): void {
  node.dispatchEvent(new MouseEvent('mouseleave'))
}

describe('tooltip action', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('shows on mouseenter and hides on mouseleave', () => {
    const host = mountHost('Hello')
    hover(host.node)
    expect(tooltipState.visible).toBe(true)
    expect(tooltipState.text).toBe('Hello')
    unhover(host.node)
    expect(tooltipState.visible).toBe(false)
    host.destroy()
  })

  it('hides its own tooltip when the hovered host unmounts', () => {
    const host = mountHost('Hide status bar')
    hover(host.node)
    expect(tooltipState.visible).toBe(true)
    // Unmount while still hovered: no mouseleave ever fires on a removed
    // node — destroy is the only cleanup that runs.
    host.destroy()
    expect(tooltipState.visible).toBe(false)
  })

  it('leaves another host’s tooltip visible on destroy', () => {
    const churn = mountHost('A row that rolls off')
    churn.destroy()
    const live = mountHost('The button being hovered')
    hover(live.node)
    expect(tooltipState.visible).toBe(true)
    // Some unrelated tooltip host unmounts elsewhere in the app while the
    // pointer stays put — the hovered button's tooltip must survive.
    const other = mountHost('Unrelated, unmounts now')
    other.destroy()
    expect(tooltipState.visible).toBe(true)
    expect(tooltipState.text).toBe('The button being hovered')
    live.destroy()
  })

  it('update() swaps the text live for the hovered host (Play → Pause)', () => {
    const node = document.createElement('button')
    document.body.appendChild(node)
    const action = tooltip(node, 'Play')
    hover(node)
    expect(tooltipState.text).toBe('Play')
    action?.update?.('Pause')
    expect(tooltipState.text).toBe('Pause')
    action?.destroy?.()
    node.remove()
  })

  it('update() does not steal another host’s visible tooltip', () => {
    const live = mountHost('The button being hovered')
    const other = document.createElement('button')
    document.body.appendChild(other)
    const otherAction = tooltip(other, 'Somewhere else')
    hover(live.node)
    otherAction?.update?.('Somewhere else, re-rendered')
    expect(tooltipState.text).toBe('The button being hovered')
    otherAction?.destroy?.()
    other.remove()
    live.destroy()
  })

  it('cancels a pending delayed show on destroy', () => {
    vi.useFakeTimers()
    const host = mountHost({ text: 'Delayed', delay: 50 })
    hover(host.node)
    host.destroy()
    vi.advanceTimersByTime(500)
    expect(tooltipState.visible).toBe(false)
  })
})
