import { describe, expect, it } from 'vitest'
import { keepRect, overlayKey, rectsOverlap } from './page-overlay'

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
  it('encodes the window-space union box plus the surface size', () => {
    expect(overlayKey(10.4, 20.6, 110.49, 90, box(0, 0, 100, 80))).toBe('10,21,110,90,100x80')
  })
})
