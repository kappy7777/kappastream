export const tooltipState = $state<{
  text: string
  rect: DOMRect | null
  visible: boolean
}>({
  text: '',
  rect: null,
  visible: false,
})

// The node whose tooltip is on screen right now. Tooltip hosts unmount
// all the time while a DIFFERENT host is the one being hovered (chat
// rows roll off, keyed lists re-render), so a destroying node may clear
// only its OWN tooltip — never someone else's.
let currentHost: HTMLElement | null = null

export function showTooltip(text: string, rect: DOMRect, host?: HTMLElement): void {
  currentHost = host ?? null
  tooltipState.text = text
  tooltipState.rect = rect
  tooltipState.visible = true
}

export function hideTooltip(host?: HTMLElement): void {
  if (host && currentHost !== host) return
  currentHost = null
  tooltipState.visible = false
}
