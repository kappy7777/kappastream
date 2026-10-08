// The app-global toast. App.svelte renders it at the root (outside the
// single-view/multi-view swap), but any component can raise it — the
// multi-view chat pane needs the same surface for link-open failures as
// the single-stream view without threading a callback up to App.

const TOAST_MS = 3500

let message = $state<string | null>(null)
let timer: ReturnType<typeof setTimeout> | null = null

/** Show a toast, replacing any current one; it self-clears after 3.5 s. */
export function toast(msg: string): void {
  message = msg
  if (timer) clearTimeout(timer)
  timer = setTimeout(() => {
    message = null
    timer = null
  }, TOAST_MS)
}

/** Current toast text, or null when hidden. Reactive ($state read). */
export function currentToast(): string | null {
  return message
}
