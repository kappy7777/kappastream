export const tooltipState = $state<{
  text: string
  rect: DOMRect | null
  visible: boolean
}>({
  text: '',
  rect: null,
  visible: false,
})

export function showTooltip(text: string, rect: DOMRect): void {
  tooltipState.text = text
  tooltipState.rect = rect
  tooltipState.visible = true
}

export function hideTooltip(): void {
  tooltipState.visible = false
}