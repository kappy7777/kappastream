import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { backdropRects, surfaceApertureHole } from './native-aperture.svelte'

const BOX = { x: 0, y: 0, w: 1000, h: 600 }

function area(rects: { left: number; top: number; width: number; height: number }[]): number {
  return rects.reduce((sum, r) => sum + r.width * r.height, 0)
}

/** Total hole area, counting overlaps once (for the identity check). */
function unionArea(
  box: { x: number; y: number; w: number; h: number },
  holes: { x: number; y: number; w: number; h: number }[],
): number {
  // Small-scale rasterization: 1px cells, boxes are <= a few thousand px.
  const cells = new Set<string>()
  for (const h of holes) {
    for (let y = Math.round(h.y); y < Math.round(h.y + h.h); y++) {
      for (let x = Math.round(h.x); x < Math.round(h.x + h.w); x++) {
        if (x >= box.x && y >= box.y && x < box.x + box.w && y < box.y + box.h) {
          cells.add(`${x},${y}`)
        }
      }
    }
  }
  return cells.size
}

describe('backdropRects', () => {
  it('paints the whole box when there are no holes', () => {
    expect(backdropRects(BOX, [])).toEqual([{ left: 0, top: 0, width: 1000, height: 600 }])
  })

  it('wraps a centered hole with four rects (single-view letterbox shape)', () => {
    const rects = backdropRects(BOX, [{ x: 100, y: 50, w: 800, h: 450 }])
    expect(rects).toEqual([
      { left: 0, top: 0, width: 1000, height: 50 }, // above
      { left: 0, top: 50, width: 100, height: 450 }, // left
      { left: 900, top: 50, width: 100, height: 450 }, // right
      { left: 0, top: 500, width: 1000, height: 100 }, // below
    ])
    expect(area(rects)).toBe(1000 * 600 - 800 * 450)
  })

  it('decomposes a 2x2 tile grid into bands + side rects', () => {
    const holes = [
      { x: 0, y: 0, w: 499, h: 299 },
      { x: 501, y: 0, w: 499, h: 299 },
      { x: 0, y: 301, w: 499, h: 299 },
      { x: 501, y: 301, w: 499, h: 299 },
    ]
    const rects = backdropRects(BOX, holes)
    // Everything outside the four tiles: full-width seam bands + the two
    // vertical seam strips, each in its row band.
    expect(area(rects)).toBe(1000 * 600 - unionArea(BOX, holes))
    // All rects inside the box, none degenerate.
    for (const r of rects) {
      expect(r.width).toBeGreaterThan(0)
      expect(r.height).toBeGreaterThan(0)
      expect(r.left).toBeGreaterThanOrEqual(0)
      expect(r.top).toBeGreaterThanOrEqual(0)
      expect(r.left + r.width).toBeLessThanOrEqual(1000)
      expect(r.top + r.height).toBeLessThanOrEqual(600)
    }
  })

  it('keeps the identity: painted area == box area - union of holes', () => {
    const holes = [
      { x: -20, y: 10, w: 300, h: 200 }, // clipped at the left edge
      { x: 400, y: 100, w: 200, h: 150 },
      { x: 450, y: 180, w: 500, h: 120 }, // overlaps the previous hole
      { x: 990, y: 500, w: 500, h: 500 }, // clipped at bottom-right
    ]
    const rects = backdropRects(BOX, holes)
    expect(area(rects)).toBe(1000 * 600 - unionArea(BOX, holes))
  })

  it('drops holes entirely outside the box', () => {
    const rects = backdropRects(BOX, [
      { x: -50, y: -50, w: 10, h: 10 },
      { x: 2000, y: 2000, w: 10, h: 10 },
    ])
    expect(rects).toEqual([{ left: 0, top: 0, width: 1000, height: 600 }])
  })

  it('returns nothing for a degenerate box', () => {
    expect(backdropRects({ x: 0, y: 0, w: 0, h: 10 }, [])).toEqual([])
  })

  it('paints nothing when one hole covers the whole box (fullscreen video)', () => {
    expect(backdropRects(BOX, [{ x: 0, y: 0, w: 1000, h: 600 }])).toEqual([])
  })

  it('handles holes whose y-ranges interleave (staggered layout)', () => {
    const holes = [
      { x: 0, y: 0, w: 400, h: 300 },
      { x: 500, y: 150, w: 500, h: 300 },
    ]
    const rects = backdropRects(BOX, holes)
    expect(area(rects)).toBe(1000 * 600 - unionArea(BOX, holes))
  })

  it('snaps fractional coordinates to integers on both sides of the seam', () => {
    const rects = backdropRects(BOX, [{ x: 100.4, y: 0, w: 799.2, h: 600 }])
    expect(rects).toEqual([
      { left: 0, top: 0, width: 100, height: 600 },
      { left: 900, top: 0, width: 100, height: 600 },
    ])
  })

  it('merges same-x-extent holes into one y-span (stacked same-width tiles)', () => {
    const rects = backdropRects(BOX, [
      { x: 0, y: 0, w: 1000, h: 290 },
      { x: 0, y: 310, w: 1000, h: 290 },
    ])
    expect(rects).toEqual([{ left: 0, top: 290, width: 1000, height: 20 }])
  })
})

// The hole vs. the surface: the surface rect itself slides under the top
// bar unclipped, while the hole carved into the page stops at the scroll
// viewport's clip line — the backdrop (not the bar's own paint) covers the
// folded rows, and the hole never escapes the surface (no black-floor
// seam).
describe('surfaceApertureHole', () => {
  it('not scrolled: the hole is the whole surface', () => {
    expect(surfaceApertureHole({ x: 100, y: 60, w: 800, h: 450 }, 60)).toEqual({
      x: 100,
      y: 60,
      w: 800,
      h: 450,
    })
  })

  it('partly scrolled: the top is raised to the clip line, bottom shared', () => {
    expect(surfaceApertureHole({ x: 100, y: -40, w: 800, h: 450 }, 60)).toEqual({
      x: 100,
      y: 60,
      w: 800,
      h: 350,
    })
  })

  it('fully scrolled out: no hole', () => {
    expect(surfaceApertureHole({ x: 100, y: -450, w: 800, h: 450 }, 60)).toBeNull()
    // The bottom edge exactly AT the clip line is already gone (h < 1).
    expect(surfaceApertureHole({ x: 100, y: -390, w: 800, h: 450 }, 60)).toBeNull()
  })

  it('clipTop 0 means no clip beyond the window top GDK enforces anyway', () => {
    expect(surfaceApertureHole({ x: 10, y: -120, w: 640, h: 360 }, 0)).toEqual({
      x: 10,
      y: 0,
      w: 640,
      h: 240,
    })
  })

  it('a fractional clipTop snaps to whole px (same grid as the surface)', () => {
    expect(surfaceApertureHole({ x: 0, y: 0, w: 640, h: 360 }, 60.4)).toEqual({
      x: 0,
      y: 60,
      w: 640,
      h: 300,
    })
    expect(surfaceApertureHole({ x: 0, y: 0, w: 640, h: 360 }, 60.6)).toEqual({
      x: 0,
      y: 61,
      w: 640,
      h: 299,
    })
  })

  it('the hole always lies inside the surface', () => {
    for (const [sy, sh, clipTop] of [
      [60, 450, 0],
      [-40, 450, 60],
      [-400, 450, 60.5],
      [120, 300, 60],
      [-450, 450, 60],
    ] as const) {
      const surface = { x: 25, y: sy, w: 800, h: sh }
      const hole = surfaceApertureHole(surface, clipTop)
      if (hole === null) continue
      expect(hole.x).toBe(surface.x)
      expect(hole.w).toBe(surface.w)
      expect(hole.y).toBeGreaterThanOrEqual(surface.y)
      expect(hole.y + hole.h).toBe(surface.y + surface.h)
    }
  })
})

// The canvas (html/body background) is the deepest opaque page paint over
// the aperture: every hole lands on it no matter how transparent the
// subtree is. This pins the native-mode override + its toggle so a cleanup
// pass cannot silently reintroduce the opaque canvas.
describe('native canvas transparency (App.svelte source contract)', () => {
  const source = readFileSync(join(process.cwd(), 'src/App.svelte'), 'utf8')

  it('overrides the html/body canvas paint in native mode', () => {
    expect(source).toMatch(
      /:global\(html\.ks-native-video\),\s*:global\(html\.ks-native-video body\)\s*{\s*background: transparent;/,
    )
  })

  it('toggles the canvas class from the same signal as the root class', () => {
    expect(source).toMatch(/const on = anyNativeSurface/)
    expect(source).toMatch(/classList\.toggle\('ks-native-video', on\)/)
  })
})

// Native fullscreen: the opaque chrome (title bar, sidebar, chat, status
// bar) is not covered by the transparent native player the way hls
// fullscreen covers it at z-index 9000, and the backdrop paints at the
// BOTTOM of the stack — so the chrome must be hidden, with only the
// player subtree and the backdrop re-visible. visibility (not display)
// keeps layout and every getBoundingClientRect measurement identical.
describe('native fullscreen chrome hiding (App.svelte source contract)', () => {
  const source = readFileSync(join(process.cwd(), 'src/App.svelte'), 'utf8')

  it('hides the app chrome in native fullscreen', () => {
    expect(source).toMatch(/\.app--fullscreen\.app--native-video\s*{\s*visibility: hidden;/)
  })

  it('re-shows only the player subtree and the backdrop', () => {
    expect(source).toMatch(
      /\.app--fullscreen\.app--native-video \.player,\s*\.app--fullscreen\.app--native-video \.native-backdrop\s*{\s*visibility: visible;/,
    )
  })
})
