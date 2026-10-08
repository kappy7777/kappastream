import { describe, expect, it, beforeAll, afterAll, vi } from 'vitest'
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
  // keepRect reads the element's own rect (getBoundingClientRect) plus its
  // computed border radius; happy-dom's getComputedStyle does not resolve
  // border-radius at all, so it is stubbed per element via a WeakMap.
  const radii = new WeakMap<HTMLElement, string>()
  beforeAll(() => {
    vi.stubGlobal('getComputedStyle', (node: Element): { borderTopLeftRadius: string } => ({
      borderTopLeftRadius: node instanceof HTMLElement ? (radii.get(node) ?? '0px') : '0px',
    }))
  })
  afterAll(() => vi.unstubAllGlobals())

  const el = (l: number, t: number, w: number, h: number, radius = '0px'): HTMLElement => {
    const node = document.createElement('div')
    node.getBoundingClientRect = () =>
      ({ left: l, top: t, right: l + w, bottom: t + h, width: w, height: h }) as DOMRect
    radii.set(node, radius)
    return node
  }

  it('clamps the element to the surface rect', () => {
    // Element hanging over the surface's top-left corner: the keep is the
    // clamped rect; the only surviving corner flag is the element's own
    // bottom-right (the one corner the clip did not touch, BR=8).
    expect(keepRect(el(-10, -10, 50, 50), box(0, 0, 100, 100))).toEqual([0, 0, 40, 40, 0, 8])
    // Element hanging over the bottom-right corner: only top-left is the
    // element's own corner (flags TL=1).
    expect(keepRect(el(80, 80, 50, 50), box(0, 0, 100, 100))).toEqual([80, 80, 20, 20, 0, 1])
  })

  it('keeps an inside element as-is, rounded', () => {
    expect(keepRect(el(10.4, 20.6, 30, 40), box(0, 0, 100, 100))).toEqual([10, 21, 30, 40, 0, 15])
  })

  it('reports the border radius and flags only unclipped corners', () => {
    // Fully inside: all four corners flagged (TL|TR|BL|BR = 15).
    expect(keepRect(el(10, 20, 30, 40, '6px'), box(0, 0, 100, 100))).toEqual([10, 20, 30, 40, 6, 15])
    // Flush edges count as unclipped; only the top row was clipped here
    // → BL|BR = 12.
    expect(keepRect(el(10, -5, 90, 40, '4px'), box(0, 0, 100, 100))).toEqual([10, 0, 90, 35, 4, 12])
    // Non-px radii (percentages, compound values) report 0 — square mask.
    expect(keepRect(el(10, 20, 30, 40, '50%'), box(0, 0, 100, 100))).toEqual([10, 20, 30, 40, 0, 15])
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
