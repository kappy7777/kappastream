import { describe, it, expect } from 'vitest'
import { UI_ZOOM_VAR, zoomDivisor } from './ui-zoom'

describe('zoomDivisor', () => {
  it('returns the scale for valid positive values', () => {
    expect(zoomDivisor(1)).toBe(1)
    expect(zoomDivisor(0.5)).toBe(0.5)
    expect(zoomDivisor(1.5)).toBe(1.5)
    expect(zoomDivisor(2)).toBe(2)
    expect(zoomDivisor(4)).toBe(4)
  })

  it('clamps invalid values to a no-op 1 (never divides by zero/negative/NaN)', () => {
    expect(zoomDivisor(0)).toBe(1)
    expect(zoomDivisor(-1)).toBe(1)
    expect(zoomDivisor(NaN)).toBe(1)
    expect(zoomDivisor(Infinity)).toBe(1)
  })

  it('cancels the zoom: (1 / divisor) * scale === 1 for every supported scale', () => {
    // The compensation contract: a viewport length L divided by the divisor,
    // then painted at `scale ×`, must net the true viewport. i.e. for scale s,
    // (L / zoomDivisor(s)) * s === L  ==>
    // (1 / zoomDivisor(s)) * s === 1.
    // A regression here would re-introduce the macOS band/overflow bug.
    for (const s of [0.5, 0.75, 1, 1.25, 1.5, 2, 4]) {
      expect((1 / zoomDivisor(s)) * s).toBeCloseTo(1, 10)
    }
  })

  it('exposes the CSS custom-property name the stylesheets divide by', () => {
    expect(UI_ZOOM_VAR).toBe('--ui-zoom')
  })
})
