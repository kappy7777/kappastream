import { describe, expect, it } from 'vitest'
import { formatVodTime } from './vod-playback.svelte.ts'

describe('formatVodTime', () => {
  it('formats seconds-only positions as m:ss', () => {
    expect(formatVodTime(0)).toBe('0:00')
    expect(formatVodTime(9)).toBe('0:09')
    expect(formatVodTime(65)).toBe('1:05')
    expect(formatVodTime(599)).toBe('9:59')
  })

  it('pads minutes once an hour is present', () => {
    expect(formatVodTime(3600)).toBe('1:00:00')
    expect(formatVodTime(3661)).toBe('1:01:01')
    expect(formatVodTime(7325)).toBe('2:02:05')
  })

  it('clamps negative / non-finite input to 0:00', () => {
    expect(formatVodTime(-30)).toBe('0:00')
    expect(formatVodTime(Number.NaN)).toBe('0:00')
    expect(formatVodTime(Number.POSITIVE_INFINITY)).toBe('0:00')
  })
})
