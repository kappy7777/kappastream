import { describe, it, expect } from 'vitest'
import { nextVolume, VOLUME_STEP } from './volume'

/*
 * Shared scroll-to-volume math used by both the single-stream PlayerControls and
 * the multi-view tiles. Asserting it here locks the single behaviour both rely
 * on (single-stream playback stays byte-identical; multi-view reuses the exact
 * same step/clamp).
 */

describe('nextVolume (shared scroll-volume step)', () => {
  it('clamps within [0, 1]', () => {
    expect(nextVolume(1, 1)).toBe(1)
    expect(nextVolume(0, -1)).toBe(0)
    expect(nextVolume(0.98, 1)).toBe(1)
    expect(nextVolume(0.02, -1)).toBe(0)
  })

  it('moves by exactly VOLUME_STEP in the given direction', () => {
    expect(nextVolume(0.5, 1)).toBe(0.5 + VOLUME_STEP)
    expect(nextVolume(0.5, -1)).toBe(0.5 - VOLUME_STEP)
  })

  it('treats scroll-up as + and scroll-down as - (dir passed by callers)', () => {
    // Callers derive dir = e.deltaY < 0 ? 1 : -1 (wheel up = louder).
    expect(nextVolume(0.4, 1)).toBeGreaterThan(0.4)
    expect(nextVolume(0.4, -1)).toBeLessThan(0.4)
  })
})
