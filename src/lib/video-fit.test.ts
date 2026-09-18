import { describe, expect, it } from 'vitest'

import { DEFAULT_VIDEO_ASPECT, fitContentRect } from './video-fit'

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
