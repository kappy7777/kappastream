/*
 * Focus management for in-app modal dialogs (Browse, Settings, the custom
 * theme editor). `role="dialog" aria-modal="true"` promises the DOM nothing:
 * without this action the dialog never takes focus, Tab walks the app behind
 * the backdrop, and closing it strands focus on the page body.
 *
 * `use:dialogFocus` on the dialog element:
 *  - remembers the focused element and focuses the dialog itself on mount
 *    (give the element tabindex="-1" so it is focusable but not tabbable);
 *  - intercepts Tab / Shift+Tab while the dialog is open and cycles focus
 *    through the dialog's own focusable elements, so focus can never leave
 *    it — not even when a click on the backdrop moved focus to the page;
 *  - restores focus to the opener when the dialog is destroyed.
 *
 * The three dialogs never stack (opening the theme editor closes Settings),
 * so one trap is active at most.
 */

const FOCUSABLE_SELECTOR = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(', ')

function focusableIn(root: HTMLElement): HTMLElement[] {
  const out: HTMLElement[] = []
  for (const el of root.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)) {
    // offsetParent is null for display:none elements (nothing the dialogs
    // render is itself position:fixed, so the fixed-position false positive
    // does not apply here). Hidden controls must not join the cycle.
    if (el.offsetParent !== null) out.push(el)
  }
  return out
}

export function dialogFocus(node: HTMLElement): { destroy(): void } {
  const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null

  function onKeydown(e: KeyboardEvent): void {
    if (e.key !== 'Tab') return
    e.preventDefault()
    const items = focusableIn(node)
    if (items.length === 0) {
      node.focus()
      return
    }
    const idx = items.indexOf(document.activeElement as HTMLElement)
    if (e.shiftKey) {
      items[idx <= 0 ? items.length - 1 : idx - 1]!.focus()
    } else {
      items[idx === -1 || idx === items.length - 1 ? 0 : idx + 1]!.focus()
    }
  }

  node.focus()
  document.addEventListener('keydown', onKeydown, true)
  return {
    destroy() {
      document.removeEventListener('keydown', onKeydown, true)
      opener?.focus()
    },
  }
}
