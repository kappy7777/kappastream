/*
 * VOD storyboard math — the seek-hover preview grid Twitch serves per VOD.
 *
 * `video.seekPreviewsURL` (fetched via fetchVideoExtras in gql.ts) points at a
 * JSON document on the VOD CloudFront CDN describing 1–2 quality variants.
 * Each variant is a set of "strip" images: a `rows × cols` grid of thumbnails
 * at `interval`-second spacing, covering the whole video (`count` cells). The
 * document looks like:
 *
 *   [ { "count": 200, "width": 160, "height": 90, "rows": 40, "cols": 5,
 *       "images": ["<vod>-low-0.jpg"], "interval": 118, "quality": "low" },
 *     { "count": 200, "width": 220, "height": 124, "rows": 10, "cols": 5,
 *       "images": ["<vod>-high-0.jpg", … "-3.jpg"], "interval": 118,
 *       "quality": "high" } ]
 *
 * Image filenames are RELATIVE to the storyboard URL's directory. The CDN
 * sends no CORS headers, so the JSON itself is fetched through the ksvod
 * proxy (its host is already allowlisted — *.cloudfront.net); the strip
 * IMAGES are rendered as CSS background-images (CORS-exempt) straight from
 * the CDN (img-src allows the same hosts media-src already did).
 *
 * Shapes verified against the live endpoint 2026-08-20. Pure logic only —
 * unit-tested in vod-extras.test.ts.
 */

export interface Storyboard {
  /** Per-thumbnail cell size in strip pixels. */
  width: number
  height: number
  /** Strip grid layout: `cols` cells per row, `rows` rows per image. */
  cols: number
  rows: number
  /** Seconds of video covered by each thumbnail. */
  intervalSec: number
  /** Total thumbnails across all images. */
  count: number
  /** Absolute strip image URLs, in order. */
  imageUrls: string[]
}

export interface StoryboardThumb {
  url: string
  /** CSS background-position offsets (raw strip pixels, already negated). */
  x: number
  y: number
}

interface RawVariant {
  count?: unknown
  width?: unknown
  height?: unknown
  rows?: unknown
  cols?: unknown
  images?: unknown
  interval?: unknown
}

function positiveInt(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) && v >= 1 ? Math.floor(v) : null
}

function positiveNumber(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : null
}

/**
 * Parse the storyboard JSON into the widest usable variant (crisper hover
 * previews; the low variant is the fallback). Returns null for any malformed
 * shape — the caller treats seek previews as strictly optional.
 */
export function parseStoryboard(raw: unknown, baseUrl: string): Storyboard | null {
  if (!Array.isArray(raw) || raw.length === 0) return null
  // Filenames resolve against the storyboard URL's directory
  // (.../storyboards/<vod>-info.json -> .../storyboards/<vod>-high-0.jpg).
  const slash = baseUrl.lastIndexOf('/')
  const dir = slash >= 0 ? baseUrl.slice(0, slash + 1) : ''
  let best: Storyboard | null = null
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue
    const v = entry as RawVariant
    const width = positiveInt(v.width)
    const height = positiveInt(v.height)
    const cols = positiveInt(v.cols)
    const rows = positiveInt(v.rows)
    const count = positiveInt(v.count)
    const intervalSec = positiveNumber(v.interval)
    if (!width || !height || !cols || !rows || !count || !intervalSec) continue
    const files = Array.isArray(v.images)
      ? v.images.filter((f): f is string => typeof f === 'string' && f.length > 0)
      : []
    if (files.length === 0) continue
    const sb: Storyboard = {
      width,
      height,
      cols,
      rows,
      intervalSec,
      count,
      imageUrls: files.map((f) => dir + f),
    }
    if (!best || sb.width > best.width) best = sb
  }
  return best
}

/**
 * Resolve the thumbnail covering `timeSec`. Returns the strip URL plus the
 * negated cell offset for CSS `background-position`, or null when the time is
 * out of range or the storyboard has fewer images than the index requires.
 */
export function storyboardThumbAt(sb: Storyboard, timeSec: number): StoryboardThumb | null {
  if (!Number.isFinite(timeSec) || timeSec < 0) return null
  const idx = Math.min(Math.floor(timeSec / sb.intervalSec), sb.count - 1)
  if (idx < 0) return null
  const perImage = sb.cols * sb.rows
  const imageIdx = Math.floor(idx / perImage)
  if (imageIdx >= sb.imageUrls.length) return null
  const within = idx % perImage
  const col = within % sb.cols
  const row = Math.floor(within / sb.cols)
  return {
    url: sb.imageUrls[imageIdx],
    // `|| 0` normalizes -0 (cell 0 of a row) to +0 for inline styles.
    x: -(col * sb.width) || 0,
    y: -(row * sb.height) || 0,
  }
}

/** Minimal chapter shape shared with gql.ts's VodChapter (structural). */
interface ChapterLike {
  startSec: number
  label: string
}

/**
 * The chapter in effect at `timeSec` (the latest chapter that has started),
 * or null before the first chapter / for an empty list.
 */
export function chapterAt(chapters: ChapterLike[], timeSec: number): ChapterLike | null {
  if (!Number.isFinite(timeSec) || chapters.length === 0) return null
  let found: ChapterLike | null = null
  for (const c of chapters) {
    if (c.startSec <= timeSec) found = c
    else break
  }
  return found
}
