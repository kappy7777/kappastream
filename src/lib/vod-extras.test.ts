import { describe, it, expect } from 'vitest'

/*
 * Unit tests for src/lib/vod-extras — the seek-hover storyboard math and the
 * chapter-at-time lookup. Pure functions; no transport involved. The strip
 * fixtures mirror the REAL document shape served by the VOD CDN (verified
 * against the live endpoint 2026-08-20): a top-level ARRAY of quality
 * variants, each a rows×cols grid of interval-spaced thumbnails with
 * RELATIVE image filenames.
 */

import { parseStoryboard, storyboardThumbAt, chapterAt } from './vod-extras'

const BASE = 'https://d2vi6trrdongqn.cloudfront.net/abc/vod/storyboards/2849957264-info.json'

const LOW = {
  count: 200,
  width: 160,
  height: 90,
  rows: 40,
  cols: 5,
  images: ['2849957264-low-0.jpg'],
  interval: 118,
  quality: 'low',
}

const HIGH = {
  count: 200,
  width: 220,
  height: 124,
  rows: 10,
  cols: 5,
  images: ['2849957264-high-0.jpg', '2849957264-high-1.jpg', '2849957264-high-2.jpg', '2849957264-high-3.jpg'],
  interval: 118,
  quality: 'high',
}

describe('parseStoryboard', () => {
  it('prefers the widest variant and joins relative image filenames', () => {
    const sb = parseStoryboard([LOW, HIGH], BASE)
    expect(sb).not.toBeNull()
    expect(sb!.width).toBe(220)
    expect(sb!.height).toBe(124)
    expect(sb!.cols).toBe(5)
    expect(sb!.rows).toBe(10)
    expect(sb!.intervalSec).toBe(118)
    expect(sb!.count).toBe(200)
    expect(sb!.imageUrls[0]).toBe('https://d2vi6trrdongqn.cloudfront.net/abc/vod/storyboards/2849957264-high-0.jpg')
    expect(sb!.imageUrls).toHaveLength(4)
  })

  it('falls back to the only variant present', () => {
    const sb = parseStoryboard([LOW], BASE)
    expect(sb!.width).toBe(160)
    expect(sb!.imageUrls).toEqual(['https://d2vi6trrdongqn.cloudfront.net/abc/vod/storyboards/2849957264-low-0.jpg'])
  })

  it('rejects malformed documents (null, empty, non-array, junk variants)', () => {
    expect(parseStoryboard(null, BASE)).toBeNull()
    expect(parseStoryboard([], BASE)).toBeNull()
    expect(parseStoryboard({ count: 1 }, BASE)).toBeNull()
    expect(parseStoryboard([42, null, { width: 100 }], BASE)).toBeNull()
    // A variant missing required numeric fields or images is skipped.
    expect(parseStoryboard([{ width: 100, height: 50, rows: 2, cols: 2, interval: 10 }], BASE)).toBeNull()
    expect(parseStoryboard([{ ...LOW, count: 0 }], BASE)).toBeNull()
    expect(parseStoryboard([{ ...LOW, images: [] }], BASE)).toBeNull()
    // ...but a valid variant next to junk still wins.
    expect(parseStoryboard([{}, LOW], BASE)!.width).toBe(160)
  })

  it('floors fractional grid values and keeps one valid variant among duplicates', () => {
    const sb = parseStoryboard([{ ...LOW, width: 160.7, height: 90.2, rows: 40.9 }], BASE)
    expect(sb!.width).toBe(160)
    expect(sb!.height).toBe(90)
    expect(sb!.rows).toBe(40)
  })
})

describe('storyboardThumbAt', () => {
  const sb = parseStoryboard([HIGH], BASE)!

  it('maps time to the covering cell (first cell at t=0)', () => {
    const t0 = storyboardThumbAt(sb, 0)
    expect(t0).toEqual({ url: sb.imageUrls[0], x: 0, y: 0 })
    // Cell 1 (col 1, row 0) covers [118, 236).
    expect(storyboardThumbAt(sb, 118)).toEqual({ url: sb.imageUrls[0], x: -220, y: 0 })
    // Cell 5 starts row 1.
    expect(storyboardThumbAt(sb, 5 * 118)).toEqual({ url: sb.imageUrls[0], x: 0, y: -124 })
  })

  it('rolls over to the next strip image after cols*rows cells', () => {
    const perImage = 5 * 10
    const t = perImage * 118 // first cell of image 1
    expect(storyboardThumbAt(sb, t)).toEqual({ url: sb.imageUrls[1], x: 0, y: 0 })
  })

  it('clamps past-the-end times to the LAST thumbnail', () => {
    const last = storyboardThumbAt(sb, 1e9)
    const lastIdx = sb.count - 1 // 199 -> image 3, within 49 -> col 4 row 9
    expect(last).toEqual({ url: sb.imageUrls[3], x: -4 * 220, y: -9 * 124 })
    expect(lastIdx).toBe(199)
  })

  it('returns null for negative/NaN times', () => {
    expect(storyboardThumbAt(sb, -1)).toBeNull()
    expect(storyboardThumbAt(sb, NaN)).toBeNull()
  })

  it('returns null when the index needs an image the document lacks', () => {
    const truncated = { ...sb, imageUrls: sb.imageUrls.slice(0, 1) }
    expect(storyboardThumbAt(truncated, 50 * 118)).toBeNull()
  })
})

describe('chapterAt', () => {
  const chapters = [
    { startSec: 0, label: 'Intro' },
    { startSec: 83, label: 'Just Chatting' },
    { startSec: 10973, label: 'GTA V' },
  ]

  it('returns the latest chapter that has started', () => {
    expect(chapterAt(chapters, 0)?.label).toBe('Intro')
    expect(chapterAt(chapters, 82)?.label).toBe('Intro')
    expect(chapterAt(chapters, 83)?.label).toBe('Just Chatting')
    expect(chapterAt(chapters, 10972)?.label).toBe('Just Chatting')
    expect(chapterAt(chapters, 10973)?.label).toBe('GTA V')
    expect(chapterAt(chapters, 1e6)?.label).toBe('GTA V')
  })

  it('returns null before the first chapter and for empty lists', () => {
    expect(chapterAt(chapters, -1)).toBeNull()
    expect(chapterAt([], 100)).toBeNull()
    expect(chapterAt([{ startSec: 30, label: 'Only' }], 10)).toBeNull()
  })
})
