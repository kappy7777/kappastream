// Focus-modality discriminator for the player control bar's idle hold.
// WebKitGTK moves DOM focus to a control on mousedown (the Linux browser
// convention), so a bare focusin listener cannot tell a click-focused
// button from a Tab-focused one. The click-focused case must not suspend
// the idle hide: a focused-but-idle button would pin the bar open until
// something else takes focus, and no pointer event can clear a focus
// flag. :focus-visible encodes exactly this distinction (keyboard focus
// matches; mouse/script focus on a button does not). The try/catch falls
// back to treating focus as keyboard if an engine ever rejects the
// selector: wrongly holding the bar open degrades to the old behavior,
// wrongly hiding it would break keyboard use.
export function isKeyboardFocus(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false
  try {
    return target.matches(':focus-visible')
  } catch {
    return true
  }
}
