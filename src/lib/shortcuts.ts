/*
 * Player keyboard shortcuts — pure, side-effect-free resolution so the
 * suppression rules and the key map are unit-testable without a DOM player.
 *
 * The single most common way this kind of feature ships broken is firing while
 * the user is typing in a text field (the chat box, the channel/search input,
 * the mute-list input). `isEditableTarget` is the guard for that and it checks
 * the event TARGET properly (input/textarea/select/contentEditable), not a
 * hardcoded selector.
 *
 * Space additionally must not double-fire when a button/switch is focused
 * (those activate natively on Space) — `isActivatableTarget` covers that.
 */

export type ShortcutAction =
  | { type: 'close-about' }
  | { type: 'close-help' }
  | { type: 'close-welcome' }
  | { type: 'play-pause' }
  | { type: 'toggle-mute' }
  | { type: 'toggle-fullscreen' }
  | { type: 'toggle-theater' }
  | { type: 'seek'; delta: number }
  | { type: 'volume'; delta: number }
  | { type: 'toggle-help' }

export interface ShortcutCtx {
  aboutOpen: boolean
  browseOpen: boolean
  helpOpen: boolean
  welcomeOpen: boolean
  isLive: boolean
}

// True when the focused element is a text-entry control — shortcuts must NEVER
// fire here (typing "m" in the chat/search/mute box is not "mute").
export function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  const el = target
  if (el.isContentEditable) return true
  const tag = el.tagName
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT'
}

// True when Space/Enter would natively activate the focused element (button,
// link, or an ARIA widget role). Lets the native activation win instead of also
// toggling play/pause (a double-trigger).
export function isActivatableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  const el = target
  const tag = el.tagName
  if (tag === 'BUTTON' || tag === 'A' || tag === 'SUMMARY') return true
  const role = el.getAttribute('role')
  if (role === null) return false
  return (
    role === 'button' ||
    role === 'switch' ||
    role === 'checkbox' ||
    role === 'radio' ||
    role === 'tab' ||
    role === 'menuitem' ||
    role === 'menuitemcheckbox' ||
    role === 'menuitemradio' ||
    role === 'option' ||
    role === 'link'
  )
}

const VOLUME_STEP = 0.05
const SEEK_STEP = 10

// Resolve a keydown into a shortcut action, or null if the key is not a
// shortcut / is suppressed. Escape closes the topmost overlay (help, then
// about) and works even inside an editable field; everything else is blocked
// while typing or behind an open modal/overlay.
export function resolveShortcut(e: KeyboardEvent, ctx: ShortcutCtx): ShortcutAction | null {
  if (e.key === 'Escape') {
    if (ctx.welcomeOpen) return { type: 'close-welcome' }
    if (ctx.helpOpen) return { type: 'close-help' }
    if (ctx.aboutOpen) return { type: 'close-about' }
    return null
  }

  // Don't hijack browser/system chords (Ctrl+F, Alt+letters, Cmd+anything).
  // Shift is allowed (only '?' needs it).
  if (e.ctrlKey || e.altKey || e.metaKey) return null

  // No player shortcuts while typing in any editable field.
  if (isEditableTarget(e.target)) return null

  // No player shortcuts behind an open modal/overlay (about, browse, help, the
  // first-launch welcome / what's-new overlay).
  if (ctx.aboutOpen || ctx.browseOpen || ctx.helpOpen || ctx.welcomeOpen) return null

  const key = e.key

  // Space on a focused button/switch must activate that control, not play/pause.
  if ((key === ' ' || key === 'Spacebar') && isActivatableTarget(e.target)) return null

  switch (key) {
    case ' ':
    case 'Spacebar':
    case 'k':
    case 'K':
      return { type: 'play-pause' }
    case 'm':
    case 'M':
      return { type: 'toggle-mute' }
    case 'f':
    case 'F':
      return { type: 'toggle-fullscreen' }
    case 't':
    case 'T':
      return { type: 'toggle-theater' }
    case '?':
      return { type: 'toggle-help' }
    case 'ArrowLeft':
      // Seeking is meaningless on a live stream — bind arrows to volume there.
      return ctx.isLive ? { type: 'volume', delta: -VOLUME_STEP } : { type: 'seek', delta: -SEEK_STEP }
    case 'ArrowRight':
      return ctx.isLive ? { type: 'volume', delta: VOLUME_STEP } : { type: 'seek', delta: SEEK_STEP }
    case 'ArrowUp':
      return { type: 'volume', delta: VOLUME_STEP }
    case 'ArrowDown':
      return { type: 'volume', delta: -VOLUME_STEP }
    default:
      return null
  }
}
