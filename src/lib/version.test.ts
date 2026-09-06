import { describe, it, expect } from 'vitest'
import { isVersionNewer, compareSemverCore } from './version'

describe('isVersionNewer (downgrade guard)', () => {
  it('a higher patch is newer', () => {
    expect(isVersionNewer('0.2.7', '0.2.6')).toBe(true)
  })

  it('compares numerically, not lexically (0.2.10 > 0.2.6)', () => {
    // A lexical compare would wrongly rank '0.2.10' below '0.2.6'.
    expect(isVersionNewer('0.2.10', '0.2.6')).toBe(true)
    expect(isVersionNewer('0.2.6', '0.2.10')).toBe(false)
  })

  it('a higher minor is newer', () => {
    expect(isVersionNewer('0.3.0', '0.2.9')).toBe(true)
    expect(isVersionNewer('0.2.9', '0.3.0')).toBe(false)
  })

  it('a higher major is newer', () => {
    expect(isVersionNewer('1.0.0', '0.9.9')).toBe(true)
    expect(isVersionNewer('0.9.9', '1.0.0')).toBe(false)
  })

  it('an equal version is NOT newer (no spurious re-offer)', () => {
    expect(isVersionNewer('0.2.6', '0.2.6')).toBe(false)
  })

  it('an older version is NOT newer (refuses the downgrade)', () => {
    expect(isVersionNewer('0.2.5', '0.2.6')).toBe(false)
    expect(isVersionNewer('0.1.9', '0.2.0')).toBe(false)
  })

  it('ignores pre-release tails (core-only; rc installs are throwaway)', () => {
    // Same core → not "newer" by core compare, regardless of pre-release tail.
    expect(isVersionNewer('0.2.6', '0.2.6-rc1')).toBe(false)
    expect(isVersionNewer('0.2.7-rc1', '0.2.6')).toBe(true)
  })

  it('fails closed on unparseable input (never offers a downgrade)', () => {
    expect(isVersionNewer('garbage', '0.2.6')).toBe(false)
    expect(isVersionNewer('0.2.7', 'garbage')).toBe(false)
    expect(isVersionNewer('', '0.2.6')).toBe(false)
  })
})

describe('compareSemverCore (three-way sort key)', () => {
  it('negative / zero / positive by core, numeric not lexical', () => {
    expect(compareSemverCore('0.2.6', '0.2.7')).toBeLessThan(0)
    expect(compareSemverCore('0.2.7', '0.2.6')).toBeGreaterThan(0)
    expect(compareSemverCore('0.2.6', '0.2.6')).toBe(0)
    // 0.2.10 > 0.2.9 numerically (a lexical sort would flip these).
    expect(compareSemverCore('0.2.10', '0.2.9')).toBeGreaterThan(0)
    expect(compareSemverCore('1.0.0', '0.9.9')).toBeGreaterThan(0)
    expect(compareSemverCore('0.3.0', '0.2.99')).toBeGreaterThan(0)
  })

  it('ignores pre-release tails (an rc compares as its core)', () => {
    expect(compareSemverCore('0.2.6-rc1', '0.2.6')).toBe(0)
    expect(compareSemverCore('0.2.7-rc1', '0.2.6')).toBeGreaterThan(0)
  })

  it('sorts an unparseable string LOWEST (never wins a newest-first sort)', () => {
    expect(compareSemverCore('garbage', '0.0.1')).toBeLessThan(0)
    expect(compareSemverCore('', '0.0.1')).toBeLessThan(0)
    expect(compareSemverCore('garbage', 'garbage')).toBe(0)
  })

  it('drives a newest-first sort', () => {
    const versions = ['0.2.9', '1.0.0', '0.3.1', '1.0.3', '1.0.1']
    expect([...versions].sort((a, b) => compareSemverCore(b, a))).toEqual([
      '1.0.3',
      '1.0.1',
      '1.0.0',
      '0.3.1',
      '0.2.9',
    ])
  })
})
