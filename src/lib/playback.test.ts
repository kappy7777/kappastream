import { describe, it, expect } from 'vitest'
import {
  toKsvodProxyUrl,
  isFatalNetworkishError,
  liveEdgeSeekTarget,
  shouldRecoverStallAfterPause,
  STALL_RECOVER_GRACE_MS,
} from './playback'

/*
 * Tests for the shared pure playback helpers (src/lib/playback.ts) — the
 * layer extracted from the three duplicated HLS engines (App.svelte,
 * Tile.svelte, PipWindow.svelte). Phase 1 is behaviour-preserving: every
 * case here pins the EXISTING semantics, including the known quirks
 * (first-occurrence-only https:// rewrite) rather than "fixing" them.
 */

const NETWORKISH_MEMBERS = [
  'manifestLoadError',
  'manifestLoadTimeOut',
  'manifestParsingError',
  'levelLoadError',
  'levelLoadTimeOut',
  'audioTrackLoadError',
  'audioPlaylistLoadError',
  'fragmentLoadError',
  'fragLoadError',
  'fragLoadTimeOut',
] as const

describe('toKsvodProxyUrl', () => {
  it('rewrites to the ksvod:// custom scheme on non-Windows (WebKit)', () => {
    expect(toKsvodProxyUrl('https://host.example/path.m3u8', false)).toBe('ksvod://localhost/host.example/path.m3u8')
  })

  it('rewrites to the http://ksvod.localhost origin on Windows (WebView2)', () => {
    expect(toKsvodProxyUrl('https://host.example/path.m3u8', true)).toBe(
      'http://ksvod.localhost/host.example/path.m3u8',
    )
  })

  it(
    'leaves a non-https URL unchanged (documented as-is: the leading-' +
      'https:// String.replace simply finds no match)',
    () => {
      expect(toKsvodProxyUrl('http://host.example/path.m3u8', false)).toBe('http://host.example/path.m3u8')
      expect(toKsvodProxyUrl('ksvod://localhost/already', true)).toBe('ksvod://localhost/already')
    },
  )

  it(
    'replaces only the FIRST https:// (String.replace with a string pattern ' +
      'replaces one occurrence — existing semantics, kept as-is)',
    () => {
      expect(toKsvodProxyUrl('https://a/redirect?to=https://b', false)).toBe(
        'ksvod://localhost/a/redirect?to=https://b',
      )
    },
  )
})

describe('isFatalNetworkishError', () => {
  it('matches every NETWORKISH member reported via type', () => {
    for (const member of NETWORKISH_MEMBERS) {
      expect(isFatalNetworkishError({ fatal: true, type: member }), `type=${member}`).toBe(true)
    }
  })

  it('matches every NETWORKISH member reported via details', () => {
    for (const member of NETWORKISH_MEMBERS) {
      expect(isFatalNetworkishError({ fatal: true, type: 'otherError', details: member }), `details=${member}`).toBe(
        true,
      )
    }
  })

  it('short-circuits on fatal: false, whatever type/details say', () => {
    expect(isFatalNetworkishError({ fatal: false, type: 'manifestLoadError' })).toBe(false)
    expect(isFatalNetworkishError({ fatal: false, type: 'networkError', details: 'fragLoadTimeOut' })).toBe(false)
  })

  it('returns false for a fatal error outside the set', () => {
    expect(isFatalNetworkishError({ fatal: true, type: 'mediaError', details: 'bufferStalledError' })).toBe(false)
    expect(isFatalNetworkishError({ fatal: true, type: 'otherError' })).toBe(false)
  })

  it('treats absent details as an empty string (never matches)', () => {
    expect(isFatalNetworkishError({ fatal: true, type: 'networkError' })).toBe(false)
  })
})

describe('liveEdgeSeekTarget', () => {
  it('prefers liveSyncPosition when present', () => {
    expect(liveEdgeSeekTarget(100, 200)).toBe(98.5)
  })

  it('falls back to seekableEnd when liveSyncPosition is absent', () => {
    expect(liveEdgeSeekTarget(undefined, 200)).toBe(198.5)
  })

  it('returns null when both are absent', () => {
    expect(liveEdgeSeekTarget(undefined, undefined)).toBeNull()
  })

  it(
    'returns null for a NaN liveSyncPosition — ?? does not fall through to ' +
      'seekableEnd (matches the original inline arithmetic)',
    () => {
      expect(liveEdgeSeekTarget(NaN, 500)).toBeNull()
      expect(liveEdgeSeekTarget(undefined, NaN)).toBeNull()
    },
  )

  it('clamps to 0 instead of going negative below the 1.5s back-off', () => {
    expect(liveEdgeSeekTarget(1.0, undefined)).toBe(0)
    expect(liveEdgeSeekTarget(undefined, 0.5)).toBe(0)
  })
})

describe('STALL_RECOVER_GRACE_MS', () => {
  it('is the 1s grace both duplicated engines used', () => {
    expect(STALL_RECOVER_GRACE_MS).toBe(1_000)
  })
})

describe('shouldRecoverStallAfterPause', () => {
  it('recovers a live, non-user pause', () => {
    expect(shouldRecoverStallAfterPause(true, false)).toBe(true)
  })

  it('never recovers a user pause (the flag is set before the pause)', () => {
    expect(shouldRecoverStallAfterPause(true, true)).toBe(false)
  })

  it('never recovers a VOD/clip pause', () => {
    expect(shouldRecoverStallAfterPause(false, false)).toBe(false)
  })

  it('treats an absent isLive as not live (payload default-to-false)', () => {
    expect(shouldRecoverStallAfterPause(undefined, false)).toBe(false)
    expect(shouldRecoverStallAfterPause(undefined, true)).toBe(false)
  })
})
