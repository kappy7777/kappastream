import { describe, it, expect } from 'vitest'
import { compareVersion, belowStreamlinkFloor, streamlinkFloorHint, MIN_STREAMLINK_VERSION } from './streamlink-floor'

describe('streamlink floor: version compare', () => {
  it('orders plain dotted versions', () => {
    expect(compareVersion('5.0.0', '6.0.0')).toBeLessThan(0)
    expect(compareVersion('6.0.0', '6.0.0')).toBe(0)
    expect(compareVersion('7.3.0', '6.0.0')).toBeGreaterThan(0)
    expect(compareVersion('6.10.0', '6.9.0')).toBeGreaterThan(0)
  })

  it('treats missing parts as zero', () => {
    expect(compareVersion('6', '6.0.0')).toBe(0)
    expect(compareVersion('5.9', '6.0.0')).toBeLessThan(0)
  })
})

describe('streamlink floor: hint condition', () => {
  it('flags only versions below the floor', () => {
    expect(belowStreamlinkFloor('5.9.2')).toBe(true)
    expect(belowStreamlinkFloor('6.0.0')).toBe(false)
    expect(belowStreamlinkFloor('10.0.0')).toBe(false)
    // Unknown version never hints.
    expect(belowStreamlinkFloor(null)).toBe(false)
    expect(belowStreamlinkFloor(undefined)).toBe(false)
  })

  it('composes the hint only for below-floor versions', () => {
    const hint = streamlinkFloorHint('5.9.2')
    expect(hint).toContain('5.9.2')
    expect(hint).toContain(MIN_STREAMLINK_VERSION)
    // At or above the floor (or unknown) the error text stays untouched.
    expect(streamlinkFloorHint('6.0.0')).toBeNull()
    expect(streamlinkFloorHint('7.3.0')).toBeNull()
    expect(streamlinkFloorHint(null)).toBeNull()
  })
})
