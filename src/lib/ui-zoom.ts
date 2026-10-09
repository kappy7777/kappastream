// UI-scale zoom compensation for viewport-unit (vh/vw/dvh) sizing.
//
// settings.applyUiScale() applies the UI scale via `documentElement.style.zoom`.
// Whether that zoom also rescales viewport units is a PER-ENGINE property:
// WKWebView (macOS) never rescales them, and WebKitGTK stops rescaling them
// once WebKit's EvaluationTimeZoomEnabled behaviour landed everywhere
// (webkitglib 2.54; on 2.52 and earlier it defaulted on only for
// PLATFORM(COCOA)), while WebView2 (Windows) still rescales them with the
// zoom. On a non-rescaling engine an element sized `100dvh` inside the
// zoomed tree renders at `zoom ×` the real window height — overflowing the
// viewport (the empty-band-above-the-video / chat-past-the-bottom bug); on a
// rescaling engine the same division would shrink the UI to `1/zoom ×` the
// window, so the platform must NOT decide this. App.svelte measures the
// behaviour at runtime instead: a 100vh-tall probe against an
// both-edges-anchored reference yields a height ratio of `zoom` exactly when
// the engine does not rescale viewport units, and ~1 when it does.
//
// Fix: sizes are written as `calc(<viewport unit> / var(--ui-zoom, 1))`. The
// custom property is written from that measurement (see App.svelte) — the
// zoom divisor on engines that need the compensation, an explicit 1
// elsewhere, so the calc is identical to the bare unit. `zoomDivisor` is the
// pure factor the CSS divides by; `shouldCompensateViewportUnits` is the pure
// measurement verdict. Extracting both keeps the math unit-testable.
//
// RULE (2026-09-18, the "Settings renders much smaller on macOS" bug): the
// divisor applies to VIEWPORT-UNIT TERMS ONLY, never to px constants. A px
// length inside the zoomed subtree already paints at zoom × its css size on
// every engine — dividing px too would shrink such a box to design size
// while its zoom-scaled content (fonts, rows) still paints zoom × — exactly
// the smaller-than-uncompensated-engines discrepancy. For a `min(520px,
// calc(100vw - 32px))` cap, write `min(520px, calc(100vw / var(--ui-zoom, 1)
// - 32px))` — divide the unit term, keep the min() structure, leave px arms
// alone.

export const UI_ZOOM_VAR = '--ui-zoom'

/**
 * The divisor a viewport-unit length is divided by to cancel
 * documentElement zoom on an engine that does not rescale viewport units.
 * Equals the UI scale: `100dvh / zoom`, painted at `zoom ×`, nets the true
 * viewport. Returns 1 (a no-op) for 1 and for any invalid/non-positive
 * input, so it can never divide by zero or blow up layout.
 */
export function zoomDivisor(uiZoom: number): number {
  if (!Number.isFinite(uiZoom) || uiZoom <= 0) return 1
  return uiZoom
}

/**
 * The runtime measurement verdict: `vhRatio` is the measured height of a
 * 100vh probe divided by the height of a both-edges-anchored reference,
 * under the live UI-scale zoom. On an engine that rescales viewport units
 * with the zoom the ratio is ~1 (no compensation — dividing there would
 * shrink the UI); on one that does not, the probe paints `zoom ×` the
 * reference (compensate). The decision is "closer to the zoom than to 1",
 * so a zoom of 1 (or anything invalid) never compensates and measurement
 * noise around the midpoint cannot half-flip a real zoom.
 */
export function shouldCompensateViewportUnits(vhRatio: number, uiZoom: number): boolean {
  if (!Number.isFinite(vhRatio) || vhRatio <= 0) return false
  const zoom = zoomDivisor(uiZoom)
  if (zoom === 1) return false
  return Math.abs(vhRatio - zoom) < Math.abs(vhRatio - 1)
}
