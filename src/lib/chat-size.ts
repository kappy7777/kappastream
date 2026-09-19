// Chat panel size bounds + the keyboard stepper for App.svelte's drag
// resizer. The resizer exposes role="slider" + tabindex, so it must react
// to keys: Arrow Up/Right grow the panel, Down/Left shrink it (matching
// the drag semantics in both layouts), Page steps by 100, Home/End jump
// to the bounds — the same shape as the UI-scale slider's keys in
// Settings.svelte. Returns null for unhandled keys so the caller can skip
// preventDefault.
export const CHAT_SIZE_MIN = 200
export const CHAT_SIZE_MAX = 1500
export const CHAT_SIZE_STEP = 20
export const CHAT_SIZE_PAGE_STEP = 100

export function nextChatSize(key: string, current: number): number | null {
  let delta: number
  switch (key) {
    case 'ArrowUp':
    case 'ArrowRight':
      delta = CHAT_SIZE_STEP
      break
    case 'ArrowDown':
    case 'ArrowLeft':
      delta = -CHAT_SIZE_STEP
      break
    case 'PageUp':
      delta = CHAT_SIZE_PAGE_STEP
      break
    case 'PageDown':
      delta = -CHAT_SIZE_PAGE_STEP
      break
    case 'Home':
      return CHAT_SIZE_MIN
    case 'End':
      return CHAT_SIZE_MAX
    default:
      return null
  }
  return Math.max(CHAT_SIZE_MIN, Math.min(CHAT_SIZE_MAX, current + delta))
}
