import { describe, expect, it } from 'vitest'

import { effectiveQualities, mpvQualities, QUALITY_IDS } from './qualities'

describe('effectiveQualities', () => {
  it('returns the full vocabulary when availability is unknown', () => {
    expect(effectiveQualities(null)).toEqual([...QUALITY_IDS])
    expect(effectiveQualities(undefined)).toEqual([...QUALITY_IDS])
    expect(effectiveQualities([])).toEqual([...QUALITY_IDS])
  })

  it('orders rungs by encoded height with best first', () => {
    // A modern full ladder: 936p60 is a real Twitch rung between 1080p60
    // and 720p60 that the old hardcoded vocabulary never knew.
    expect(effectiveQualities(['audio_only', '160p', '360p', '480p', '720p60', '936p60', '1080p60'])).toEqual([
      'best',
      '1080p60',
      '936p60',
      '720p60',
      '480p',
      '360p',
      '160p',
      'audio_only',
    ])
  })

  it('offers exactly a sparse ladder, inventing nothing', () => {
    // The owner's case: this channel really only transcodes these — no
    // 480p/360p/160p exists, and the menu must not pretend otherwise.
    expect(effectiveQualities(['1080p60', '720p60', 'audio_only'])).toEqual(['best', '1080p60', '720p60', 'audio_only'])
  })

  it('breaks height ties vocabulary-first', () => {
    // 480p60 and 480p encode the same height; the vocabulary rung (480p)
    // sorts first.
    expect(effectiveQualities(['480p60', '480p'])).toEqual(['best', '480p', '480p60'])
  })

  it('drops aliases and duplicates, deferring best to its own row', () => {
    expect(effectiveQualities(['best', 'worst', 'worst_unfiltered', '720p60', '720p60'])).toEqual(['best', '720p60'])
  })

  it('keeps unknown-but-real rung names, ordered by height', () => {
    // Any structurally-valid rung streamlink reports is real and
    // resolvable — e.g. 540p (a rung some ladders carry) slots in by its
    // encoded height between the vocabulary rungs.
    expect(effectiveQualities(['720p60', '540p', '360p', 'audio_only'])).toEqual([
      'best',
      '720p60',
      '540p',
      '360p',
      'audio_only',
    ])
  })

  it('degrades to best-only when the stream offers nothing else', () => {
    expect(effectiveQualities(['best'])).toEqual(['best'])
  })
})

describe('mpvQualities', () => {
  it('drops audio_only from the full vocabulary — mpv has no OSD canvas in audio-only', () => {
    expect(mpvQualities(null)).toEqual([...QUALITY_IDS].filter((q) => q !== 'audio_only'))
    expect(mpvQualities(undefined)).toEqual(mpvQualities(null))
  })

  it('drops audio_only from a real ladder while keeping order', () => {
    expect(mpvQualities(['1080p60', '720p60', 'audio_only'])).toEqual(['best', '1080p60', '720p60'])
    expect(mpvQualities(['audio_only'])).toEqual(['best'])
  })
})
