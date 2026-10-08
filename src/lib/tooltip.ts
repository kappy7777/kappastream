import type { Action } from 'svelte/action'
import { showTooltip, hideTooltip } from './tooltip.svelte.ts'

export interface TooltipOptions {
  text: string
  delay?: number
}

/**
 * Svelte action that shows a custom DOM tooltip on hover. Use as
 * `use:tooltip={'Hover text'}` for an immediate tooltip, or
 * `use:tooltip={{ text: 'Hover text', delay: 2500 }}` for one that
 * waits `delay` ms before appearing. Pairs with the global tooltip
 * element rendered in App.svelte.
 *
 * Why not the native `title` attribute? Because browser-native
 * tooltips don't scale with the app's `zoom` UI scale — they render
 * at the OS's tooltip size. This custom tooltip lives in the zoomed
 * tree, so it scales with the user's UI scale preference.
 */
export const tooltip: Action<HTMLElement, string | TooltipOptions | undefined> = (node, params) => {
  let timer: ReturnType<typeof setTimeout> | null = null

  function clearTimer(): void {
    if (timer) {
      clearTimeout(timer)
      timer = null
    }
  }

  function onEnter(): void {
    clearTimer()
    const { text, delay = 0 } = typeof params === 'string' ? { text: params } : (params ?? { text: '' })
    if (!text) return
    const show = () => {
      const rect = node.getBoundingClientRect()
      showTooltip(text, rect, node)
    }
    if (delay > 0) {
      timer = setTimeout(show, delay)
    } else {
      show()
    }
  }
  function onLeave(): void {
    clearTimer()
    hideTooltip()
  }
  node.addEventListener('mouseenter', onEnter)
  node.addEventListener('mouseleave', onLeave)
  return {
    destroy(): void {
      clearTimer()
      node.removeEventListener('mouseenter', onEnter)
      node.removeEventListener('mouseleave', onLeave)
      // A node unmounted while hovered (a button that hides its own
      // container, a chat row rolling off) never receives mouseleave —
      // there is no element left to deliver it — so without this the
      // tooltip would stay on screen until another host is hovered.
      // The host argument keeps this scoped to the node's OWN tooltip.
      hideTooltip(node)
    },
  }
}
