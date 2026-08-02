// UI-scale zoom compensation for viewport-unit (vh/vw/dvh) sizing on macOS.
//
// settings.applyUiScale() applies the UI scale via `documentElement.style.zoom`.
// On WKWebView (macOS) that zoom scales the documentElement subtree's paint
// without rescaling viewport units, so an element sized `100dvh` inside the
// zoomed tree renders at `zoom ×` the real window height — overflowing the
// viewport (the empty-band-above-the-video / chat-past-the-bottom bug). Linux
// (WebKitGTK) and Windows (WebView2) rescale viewport units with the zoom, so
// they are unaffected and need no compensation.
//
// Fix: sizes are written as `calc(<viewport unit> / var(--ui-zoom, 1))`. The
// custom property is written ONLY on macOS (see App.svelte), so on Linux/
// Windows it stays unset and the `1` fallback makes the calc identical to the
// bare unit — no behaviour change there. `zoomDivisor` is the pure factor the
// CSS divides by; extracting it keeps the compensation math unit-testable.

export const UI_ZOOM_VAR = '--ui-zoom'

/**
 * The divisor a viewport-unit length is divided by to cancel macOS's
 * documentElement zoom. Equals the UI scale: `100dvh / zoom`, painted at
 * `zoom ×`, nets the true viewport. Returns 1 (a no-op) for 1 and for any
 * invalid/non-positive input, so it can never divide by zero or blow up layout.
 */
export function zoomDivisor(uiZoom: number): number {
  if (!Number.isFinite(uiZoom) || uiZoom <= 0) return 1
  return uiZoom
}
