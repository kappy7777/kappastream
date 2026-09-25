/**
 * The fitted video CONTENT rect: the letterboxed `object-fit: contain`
 * equivalent inside a box, centered. ONE shared computation feeds every
 * consumer that must align to the video picture instead of the player box —
 * the mpv surface rect, the OSD overlay fractions, the pointer
 * normalization, and the `--video-*` CSS custom properties on .player.
 * Single source of truth on purpose: computing the fit twice with different
 * rounding could desync the OSD bar from the HTML controls by a pixel.
 */

/**
 * Fallback aspect until the engine reports the real one (16:9 — the
 * overwhelming default for live streams; a VOD/clip updates it as soon as
 * its metadata or video params arrive).
 */
export const DEFAULT_VIDEO_ASPECT = 16 / 9

export interface ContentRect {
  /** Offset of the content rect within the box (0 = flush left/top). */
  x: number
  y: number
  /** Content size in the same px space as the box inputs. */
  w: number
  h: number
}

/**
 * Pure fit — no DOM. A non-finite/non-positive aspect falls back to 16/9; a
 * degenerate box (either axis <= 0) yields a zero rect so callers can skip.
 */
export function fitContentRect(boxW: number, boxH: number, aspect: number): ContentRect {
  if (!(boxW > 0) || !(boxH > 0)) return { x: 0, y: 0, w: 0, h: 0 }
  const a = Number.isFinite(aspect) && aspect > 0 ? aspect : DEFAULT_VIDEO_ASPECT
  // Box wider than the picture (height is binding): full height, side bars.
  if (boxW / boxH > a) {
    const w = boxH * a
    return { x: (boxW - w) / 2, y: 0, w, h: boxH }
  }
  // Box taller than the picture (width is binding): full width, cinema bars.
  const h = boxW / a
  return { x: 0, y: (boxH - h) / 2, w: boxW, h }
}

export interface ClippedRect {
  x: number
  y: number
  w: number
  h: number
  /** The hidden-top fraction of the ORIGINAL height (0 = nothing hidden). */
  hidden: number
}

/**
 * Clip a rect's TOP at `clipTop` (same px space as the rect): what the page's
 * own overflow hiding would conceal. Feeds the native surface, whose window
 * sits ABOVE the page and therefore must pre-clip itself where the page
 * would — the engine folds the hidden rows away at presentation time so the
 * visible picture fills the clipped surface edge to edge. A rect fully above
 * the line keeps a 1px sliver at its bottom edge (a zero-height surface is
 * never pushed) with `hidden` just under 1.
 */
export function clipRectTop(x: number, y: number, w: number, h: number, clipTop: number): ClippedRect {
  if (!(h > 0) || y >= clipTop) return { x, y, w, h, hidden: 0 }
  const hid = Math.max(0, Math.min(h - 1, clipTop - y))
  return { x, y: y + hid, w, h: h - hid, hidden: hid / h }
}

export interface PointerFractions {
  /** Position as a fraction of the FULL content rect (the unrolled picture). */
  x: number
  y: number
  /** True within the VISIBLE band only — rows hidden above the fold line sit
   * under the page's top bar and can never receive events. */
  inside: boolean
  clampX: number
  /** Drag clamp folds into the visible band, never the hidden rows. */
  clampY: number
}

/**
 * Normalize a pointer position (client space) against the fitted content
 * rect, for forwarding into mpv's OSD. `y` is a fraction of the FULL content
 * height on purpose: the engine composes its OSD over the unrolled picture
 * (osd-height includes the fold; hidden rows are folded away at presentation
 * time), and the Rust side rescales by exactly that osd-height — so sending
 * a fraction of the VISIBLE slice would land every hit above where the
 * pointer visibly is once the player is partially scrolled under the top
 * bar. `clipTop` is the fold line in the same px space as `boxTop`.
 */
export function pointerFractions(
  pointX: number,
  pointY: number,
  boxLeft: number,
  boxTop: number,
  boxW: number,
  boxH: number,
  aspect: number,
  clipTop: number,
): PointerFractions {
  const c = fitContentRect(boxW, boxH, aspect)
  const w = Math.max(1, c.w)
  const h = Math.max(1, c.h)
  const x = (pointX - boxLeft - c.x) / w
  const y = (pointY - boxTop - c.y) / h
  const f = clipRectTop(0, c.y, c.w, c.h, clipTop).hidden
  return {
    x,
    y,
    inside: x >= 0 && x <= 1 && y >= f && y <= 1,
    clampX: Math.min(1, Math.max(0, x)),
    clampY: Math.min(1, Math.max(f, y)),
  }
}
