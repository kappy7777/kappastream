import { describe, expect, it } from 'vitest'
import { keepRect, osdFractions, overlayKey, rectsOverlap } from './page-overlay'

const box = (l: number, t: number, w: number, h: number) => ({
  left: l,
  top: t,
  right: l + w,
  bottom: t + h,
  width: w,
  height: h,
})

describe('rectsOverlap', () => {
  it('overlaps when both axes share at least a full pixel', () => {
    expect(rectsOverlap(box(0, 0, 100, 100), box(50, 50, 100, 100))).toBe(true)
    expect(rectsOverlap(box(0, 0, 100, 100), box(99, 0, 100, 100))).toBe(true)
  })

  it('rejects edge-touching and sub-pixel overlaps', () => {
    expect(rectsOverlap(box(0, 0, 100, 100), box(100, 0, 100, 100))).toBe(false)
    expect(rectsOverlap(box(0, 0, 100, 100), box(99.5, 0, 100, 100))).toBe(false)
    expect(rectsOverlap(box(0, 0, 100, 100), box(0, 99.5, 100, 100))).toBe(false)
  })

  it('ignores elements smaller than 2px', () => {
    expect(rectsOverlap(box(0, 0, 1.5, 100), box(0, 0, 100, 100))).toBe(false)
    expect(rectsOverlap(box(0, 0, 100, 1.5), box(0, 0, 100, 100))).toBe(false)
  })
})

describe('keepRect', () => {
  it('clamps the element to the surface rect', () => {
    // Element hanging over the surface's top-left corner.
    expect(keepRect(box(-10, -10, 50, 50), box(0, 0, 100, 100))).toEqual([0, 0, 40, 40])
    // Element hanging over the bottom-right corner.
    expect(keepRect(box(80, 80, 50, 50), box(0, 0, 100, 100))).toEqual([80, 80, 20, 20])
  })

  it('keeps an inside element as-is, rounded', () => {
    expect(keepRect(box(10.4, 20.6, 30, 40), box(0, 0, 100, 100))).toEqual([10, 21, 30, 40])
  })
})

describe('overlayKey', () => {
  it('encodes the window-space union box, the surface size, and the fold', () => {
    expect(overlayKey(10.4, 20.6, 110.49, 90, box(0, 0, 100, 80))).toBe('10,21,110,90,100x80,0')
    expect(overlayKey(10, 20, 110, 90, box(0, 0, 100, 80), 0.25)).toBe('10,20,110,90,100x80,2500')
  })

  it('distinguishes fold fractions on an otherwise identical layout', () => {
    const b = box(0, 0, 100, 80)
    expect(overlayKey(10, 20, 110, 90, b, 0.1)).not.toBe(overlayKey(10, 20, 110, 90, b, 0.2))
  })
})

describe('osdFractions', () => {
  it('is the identity without a fold', () => {
    // Unfolded surfaces (tiles, an unscrolled player) keep their historical
    // plain-visible-rect fractions.
    expect(osdFractions(box(0, 0, 200, 100), 0, 40, 30, 20, 10)).toEqual(['0.2000', '0.3000', '0.1000', '0.1000'])
  })

  it('maps the visible band into the bottom slice of the full composition', () => {
    // A quarter of the composition folded away: the visible band is the
    // bottom 75%. The visible top maps to 0.25, the visible bottom stays 1,
    // and heights shrink by 0.75.
    const b = box(0, 200, 200, 300) // visible band of a 400-tall composition
    expect(osdFractions(b, 0.25, 0, 200, 200, 300)).toEqual(['0.0000', '0.2500', '1.0000', '0.7500'])
    expect(osdFractions(b, 0.25, 0, 500, 200, 0)).toEqual(['0.0000', '1.0000', '1.0000', '0.0000'])
  })

  it('leaves the never-folded x axis untouched', () => {
    const b = box(10, 0, 200, 100)
    expect(osdFractions(b, 0.5, 60, 0, 40, 50)).toEqual(['0.2500', '0.5000', '0.2000', '0.2500'])
  })
})
