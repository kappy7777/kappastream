import { describe, expect, it } from 'vitest'

import { DEFAULT_VIDEO_ASPECT, clipRectTop, fitContentRect } from './video-fit'

describe('fitContentRect', () => {
  it('height-bound box: full height, centered side bars', () => {
    // 1000x400 box, 16:9 video -> content 711.1x400, x inset (1000-711.1)/2
    const c = fitContentRect(1000, 400, 16 / 9)
    expect(c.h).toBe(400)
    expect(c.y).toBe(0)
    expect(c.w).toBeCloseTo(400 * (16 / 9), 9)
    expect(c.x).toBeCloseTo((1000 - 400 * (16 / 9)) / 2, 9)
  })

  it('width-bound box: full width, centered cinema bars', () => {
    // 400x1000 box, 16:9 video -> content 400x225, y inset (1000-225)/2
    const c = fitContentRect(400, 1000, 16 / 9)
    expect(c.w).toBe(400)
    expect(c.x).toBe(0)
    expect(c.h).toBeCloseTo(400 / (16 / 9), 9)
    expect(c.y).toBeCloseTo((1000 - 400 / (16 / 9)) / 2, 9)
  })

  it('matching aspect fills the box exactly', () => {
    const c = fitContentRect(640, 360, 16 / 9)
    expect(c).toEqual({ x: 0, y: 0, w: 640, h: 360 })
  })

  it('vertical VOD (9:16) in a wide box gets narrow centered content', () => {
    const c = fitContentRect(1280, 720, 9 / 16)
    expect(c.h).toBe(720)
    expect(c.y).toBe(0)
    expect(c.w).toBeCloseTo(720 * (9 / 16), 9)
    expect(c.x).toBeCloseTo((1280 - 720 * (9 / 16)) / 2, 9)
  })

  it('non-finite, zero and negative aspects fall back to 16/9', () => {
    for (const bad of [Number.NaN, 0, -1.5, Number.POSITIVE_INFINITY]) {
      const c = fitContentRect(1000, 400, bad)
      expect(c.w).toBeCloseTo(400 * DEFAULT_VIDEO_ASPECT, 9)
      expect(c.h).toBe(400)
    }
  })

  it('degenerate boxes yield a zero rect', () => {
    expect(fitContentRect(0, 400, 16 / 9)).toEqual({ x: 0, y: 0, w: 0, h: 0 })
    expect(fitContentRect(640, 0, 16 / 9)).toEqual({ x: 0, y: 0, w: 0, h: 0 })
    expect(fitContentRect(-5, 400, 16 / 9)).toEqual({ x: 0, y: 0, w: 0, h: 0 })
  })

  it('content always fits inside the box', () => {
    for (const aspect of [16 / 9, 9 / 16, 4 / 3, 1, 2.39]) {
      for (const [w, h] of [
        [1280, 720],
        [613, 829],
        [300, 300],
      ]) {
        const c = fitContentRect(w, h, aspect)
        expect(c.x).toBeGreaterThanOrEqual(0)
        expect(c.y).toBeGreaterThanOrEqual(0)
        expect(c.x + c.w).toBeLessThanOrEqual(w + 1e-9)
        expect(c.y + c.h).toBeLessThanOrEqual(h + 1e-9)
      }
    }
  })
})

describe('clipRectTop', () => {
  it('leaves a rect at or below the line untouched', () => {
    expect(clipRectTop(10, 50, 400, 300, 50)).toEqual({ x: 10, y: 50, w: 400, h: 300, hidden: 0 })
    expect(clipRectTop(10, 120, 400, 300, 50)).toEqual({ x: 10, y: 120, w: 400, h: 300, hidden: 0 })
  })

  it('clips a partially hidden rect at the line and reports the fraction', () => {
    // Top 100 of a 400-tall rect sit above the line at y=50.
    const c = clipRectTop(10, -50, 640, 400, 50)
    expect(c.x).toBe(10)
    expect(c.y).toBe(50)
    expect(c.w).toBe(640)
    expect(c.h).toBe(300)
    expect(c.hidden).toBeCloseTo(0.25, 9)
  })

  it('keeps a 1px sliver for a fully hidden rect, just under the fraction 1', () => {
    const c = clipRectTop(10, -500, 640, 400, 50)
    expect(c.h).toBe(1)
    // The sliver sits at the rect's bottom edge, still above the line.
    expect(c.y).toBe(-101)
    expect(c.hidden).toBeLessThan(1)
    expect(c.hidden).toBeCloseTo(399 / 400, 9)
  })

  it('zero/degenerate height reports nothing hidden', () => {
    expect(clipRectTop(0, 0, 0, 0, 50).hidden).toBe(0)
    expect(clipRectTop(0, -100, 0, -5, 50).hidden).toBe(0)
  })
})
