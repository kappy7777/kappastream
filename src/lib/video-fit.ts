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
