import { describe, it, expect, beforeEach } from 'vitest'
import { clampRectToMonitor, readSavedPipRect, rectCentreOnAnyMonitor, writeSavedPipRect } from './pip-rect'

/*
 * Unit tests for src/lib/pip-rect.ts — the restore-time clamp that heals
 * rects saved before the current persistence model, plus the localStorage
 * read/write round-trip both PiP webviews share. The window-rect store is
 * written on every settled resize/move while the floating window is alive
 * (never at close time) and read back at the next open; the clamp bounds
 * what can come back.
 */

const KEY = 'pip-rect-test-key'

describe('readSavedPipRect / writeSavedPipRect', () => {
  beforeEach(() => {
    localStorage.removeItem(KEY)
  })

  it('round-trips a rect through localStorage', () => {
    writeSavedPipRect(KEY, { x: 12, y: 34, width: 480, height: 270 })
    expect(readSavedPipRect(KEY)).toEqual({ x: 12, y: 34, width: 480, height: 270 })
  })

  it('returns null for a missing key, malformed JSON, and wrong-shape values', () => {
    expect(readSavedPipRect(KEY)).toBeNull()
    localStorage.setItem(KEY, 'not json')
    expect(readSavedPipRect(KEY)).toBeNull()
    localStorage.setItem(KEY, JSON.stringify({ x: 1, width: 480 }))
    expect(readSavedPipRect(KEY)).toBeNull()
  })

  it('rejects a rect below the 160x90 restore floor', () => {
    writeSavedPipRect(KEY, { x: 0, y: 0, width: 100, height: 60 })
    expect(readSavedPipRect(KEY)).toBeNull()
  })
})

describe('clampRectToMonitor', () => {
  it('caps a grown rect at 60% of the monitor (logical)', () => {
    // 2560×1440 logical monitor → caps 1536×864.
    expect(clampRectToMonitor({ x: 3, y: 4, width: 2400, height: 1350 }, 2560, 1440)).toEqual({
      x: 3,
      y: 4,
      width: 1536,
      height: 864,
    })
  })

  it('treats the monitor size as the same physical units as the rect', () => {
    // A 3840×2160 physical monitor caps at 2304×1296 physical.
    expect(clampRectToMonitor({ x: 0, y: 0, width: 3600, height: 2025 }, 3840, 2160)).toEqual({
      x: 0,
      y: 0,
      width: 2304,
      height: 1296,
    })
  })

  it('leaves an in-range rect untouched, position included', () => {
    expect(clampRectToMonitor({ x: -40, y: 120, width: 480, height: 270 }, 2560, 1440)).toEqual({
      x: -40,
      y: 120,
      width: 480,
      height: 270,
    })
  })

  it('lifts a too-small rect to the restore floor (160×90)', () => {
    expect(clampRectToMonitor({ x: 0, y: 0, width: 100, height: 60 }, 2560, 1440)).toEqual({
      x: 0,
      y: 0,
      width: 160,
      height: 90,
    })
  })

  it('never lets the floor exceed the cap on a tiny monitor', () => {
    // A 240×135 logical monitor would cap below the floor; the floor wins so
    // the window stays usable rather than vanishing.
    expect(clampRectToMonitor({ x: 0, y: 0, width: 300, height: 200 }, 240, 135)).toEqual({
      x: 0,
      y: 0,
      width: 160,
      height: 90,
    })
  })

  it('honours a custom fraction', () => {
    expect(clampRectToMonitor({ x: 0, y: 0, width: 2400, height: 1350 }, 2560, 1440, 0.5)).toEqual({
      x: 0,
      y: 0,
      width: 1280,
      height: 720,
    })
  })
})

describe('rectCentreOnAnyMonitor', () => {
  // Physical monitor rects, the same units the saved rect carries.
  const PRIMARY = { x: 0, y: 0, width: 2560, height: 1440 }
  const SECOND = { x: 2560, y: 0, width: 1920, height: 1080 }

  it('keeps a rect whose centre lands on the primary monitor', () => {
    expect(rectCentreOnAnyMonitor({ x: 40, y: 50, width: 480, height: 270 }, [PRIMARY])).toBe(true)
  })

  it('keeps a rect whose centre lands on ANOTHER connected monitor', () => {
    // Saved at x=3000 on a two-monitor desk; the primary ends at 2560.
    expect(rectCentreOnAnyMonitor({ x: 3000, y: 100, width: 480, height: 270 }, [PRIMARY, SECOND])).toBe(true)
  })

  it('drops a rect saved on a since-unplugged monitor', () => {
    // Centre x = 5000+240 = 5240: past the primary, past the second.
    expect(rectCentreOnAnyMonitor({ x: 5000, y: 200, width: 480, height: 270 }, [PRIMARY])).toBe(false)
    expect(rectCentreOnAnyMonitor({ x: 5000, y: 200, width: 480, height: 270 }, [PRIMARY, SECOND])).toBe(false)
  })

  it('counts a centre exactly on a monitor edge as on-screen', () => {
    // Centre (2560, 720): the right edge of the primary AND the left edge
    // of the second — either way it is reachable, so it stays.
    expect(rectCentreOnAnyMonitor({ x: 2320, y: 585, width: 480, height: 270 }, [PRIMARY])).toBe(true)
    expect(rectCentreOnAnyMonitor({ x: 2320, y: 585, width: 480, height: 270 }, [SECOND])).toBe(true)
  })

  it('no monitors answering means no position to keep', () => {
    expect(rectCentreOnAnyMonitor({ x: 100, y: 100, width: 480, height: 270 }, [])).toBe(false)
  })
})
