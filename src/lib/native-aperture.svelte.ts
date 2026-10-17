// The native-video APERTURE: the set of window-space rects ("holes")
// through which the embedded-mpv surfaces show beneath the webview (see
// src-tauri/src/mpv/linux.rs for the widget layering). The page must stay
// fully OPAQUE everywhere except these rects, or the black floor under the
// video layer becomes visible — so this module is also the source of the
// BACKDROP geometry: the decomposition of the window into painted rects
// that leave exactly the holes unpainted.
//
// Ownership: ONE reactive hole registry for the whole app. App.svelte owns
// engine 0 (the single-view player), each MultiView tile owns its engine
// id (1..4) — the same ids mpv_set_rect targets. A hole is set only while
// its surface is both native-active AND revealed (first frame presented,
// mirroring the Rust-side reveal on PlaybackRestart), so loading and error
// overlays render over the normal themed page exactly like the hls path.
//
// Coordinates: window-space VISUAL px (zoom included) — the same space
// getBoundingClientRect reports under the zoomed subtree and the same
// numbers mpv_set_rect consumes (GDK logical px == webview visual px).
// Consumers that position fixed elements must divide by the zoom factor
// (the .zoom-probe measurement in App.svelte) when applying these values
// as CSS left/top, mirroring the tooltip positioning rules.

/** A hole rect in window-space visual px. */
export interface ApertureRect {
  x: number
  y: number
  w: number
  h: number
}

/** One backdrop rectangle: style-ready left/top/width/height in px. */
export interface BackdropRect {
  left: number
  top: number
  width: number
  height: number
}

// The registry. $state on a plain object record keyed by engine id —
// identity-stable writes per id keep derived consumers from re-running on
// unchanged pushes.
const holes: Record<number, ApertureRect | undefined> = $state({})

let nextRevision = 0
/** Bumped on every registry mutation so deriveds reading the revision
 * re-run even when a hole is REMOVED (the record write alone would leave
 * `holes[id] === undefined` reading the same value as before). */
let revision = $state(0)

/** Set (or replace) one engine's hole. Value-deduped per id. */
export function setApertureHole(id: number, rect: ApertureRect): void {
  const prev = holes[id]
  if (prev && prev.x === rect.x && prev.y === rect.y && prev.w === rect.w && prev.h === rect.h) {
    return
  }
  holes[id] = rect
  revision = ++nextRevision
}

/** Remove one engine's hole (surface hidden, engine stopped, tile gone). */
export function clearApertureHole(id: number): void {
  if (holes[id] === undefined) return
  delete holes[id]
  revision = ++nextRevision
}

/** All currently open holes, keyed by engine id. */
export function apertureHoles(): Readonly<Record<number, ApertureRect | undefined>> {
  void revision
  return holes
}

/**
 * Decompose `box` minus the union of `holes` into the minimal set of
 * non-overlapping axis-aligned rectangles (a y-sweep: the distinct hole
 * tops/bottoms slice the box into horizontal strips; within each strip the
 * holes occupy x-intervals, and the complement of those intervals is the
 * strip's painted part). Holes are clipped to the box first; degenerate
 * holes (or holes entirely outside it) drop out. Rects are rounded to
 * integers — the same snapping mpv_set_rect applies, so the painted chrome
 * and the transparent hole land on the same pixel grid with no fractional
 * seams.
 *
 * The result paints the backdrop: stacking the returned rects reproduces
 * the page's opaque chrome up to the video edge. With no holes, the whole
 * box is one rect.
 */
export function backdropRects(box: ApertureRect, openHoles: readonly ApertureRect[]): BackdropRect[] {
  const bx1 = Math.round(box.x + box.w)
  const by1 = Math.round(box.y + box.h)
  const bx0 = Math.round(box.x)
  const by0 = Math.round(box.y)
  const bw = bx1 - bx0
  const bh = by1 - by0
  if (bw < 1 || bh < 1) return []

  // Clip + snap holes; drop empties.
  const clipped: { x0: number; y0: number; x1: number; y1: number }[] = []
  for (const h of openHoles) {
    const x0 = Math.max(bx0, Math.round(h.x))
    const y0 = Math.max(by0, Math.round(h.y))
    const x1 = Math.min(bx1, Math.round(h.x + h.w))
    const y1 = Math.min(by1, Math.round(h.y + h.h))
    if (x1 - x0 >= 1 && y1 - y0 >= 1) clipped.push({ x0, y0, x1, y1 })
  }
  if (clipped.length === 0) {
    return [{ left: bx0, top: by0, width: bw, height: bh }]
  }

  // y-sweep over the distinct strip boundaries: consecutive bands between
  // a hole edge are either fully inside a hole's y-range or fully outside
  // it, so hole coverage per band is exact without slicing further.
  const ys = new Set<number>([by0, by1])
  for (const m of clipped) {
    ys.add(Math.max(by0, m.y0))
    ys.add(Math.min(by1, m.y1))
  }
  const bands = [...ys].sort((a, b) => a - b)
  const rects: BackdropRect[] = []
  for (let i = 0; i + 1 < bands.length; i++) {
    const y0 = bands[i]
    const y1 = bands[i + 1]
    if (y1 - y0 < 1) continue
    // x-intervals of holes covering this band.
    const covering = clipped.filter((m) => m.y0 <= y0 && m.y1 >= y1).sort((a, b) => a.x0 - b.x0)
    let x = bx0
    for (const m of covering) {
      if (m.x0 > x) rects.push({ left: x, top: y0, width: m.x0 - x, height: y1 - y0 })
      x = Math.max(x, m.x1)
    }
    if (bx1 > x) rects.push({ left: x, top: y0, width: bx1 - x, height: y1 - y0 })
  }
  return rects
}
