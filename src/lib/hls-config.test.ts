import { describe, it, expect, beforeEach } from 'vitest'
import { buildHlsConfig, LIVE_SYNC_DURATION_COUNT_DEFAULT, BACK_BUFFER_LENGTH } from './hls-config'

/*
 * Tests for the shared hls.js config builder (src/lib/hls-config.ts). These
 * lock in the three correctness rules the live player depends on:
 *  1. Low Latency enabled vs disabled produce *intentional*, distinct configs.
 *  2. The disabled mode never passes low-latency-only options (lowLatencyMode
 *     must be false, not the old hardcoded `true`).
 *  3. No optional key is passed as `undefined` — hls.js's spread merge would
 *     let it overwrite the default instead of inheriting it.
 */

describe('buildHlsConfig', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it('produces intentional, distinct configs for low-latency on vs off (#1)', () => {
    const on = buildHlsConfig(true)
    const off = buildHlsConfig(false)
    expect(on.lowLatencyMode).toBe(true)
    expect(off.lowLatencyMode).toBe(false)
    // Distinct live-sync targets: LL chases the edge (1), normal mode is 3.
    expect(on.liveSyncDurationCount).not.toBe(off.liveSyncDurationCount)
    expect(on.liveSyncDurationCount).toBe(1)
    expect(off.liveSyncDurationCount).toBe(LIVE_SYNC_DURATION_COUNT_DEFAULT)
  })

  it('disabled mode does not pass low-latency-only options (#2)', () => {
    const off = buildHlsConfig(false)
    expect(off.lowLatencyMode).toBe(false)
    // Normal mode keeps a comfortable sync window — never the LL value of 1.
    expect(off.liveSyncDurationCount).not.toBe(1)
    expect(off.liveSyncDurationCount).toBe(3)
  })

  it('never passes an optional key as undefined (#3)', () => {
    for (const low of [true, false]) {
      const cfg = buildHlsConfig(low)
      for (const [k, v] of Object.entries(cfg)) {
        expect(v, `key "${k}" must not be undefined`).not.toBeUndefined()
      }
    }
  })

  it('keeps the worker + back-buffer settings stable across both modes', () => {
    expect(buildHlsConfig(true).enableWorker).toBe(true)
    expect(buildHlsConfig(false).enableWorker).toBe(true)
    expect(buildHlsConfig(true).backBufferLength).toBe(BACK_BUFFER_LENGTH)
    expect(buildHlsConfig(false).backBufferLength).toBe(BACK_BUFFER_LENGTH)
  })

  it('lowLatencyMode always tracks the argument exactly', () => {
    expect(buildHlsConfig(true).lowLatencyMode).toBe(true)
    expect(buildHlsConfig(false).lowLatencyMode).toBe(false)
  })

  it('only emits known keys (no accidental/typo config keys)', () => {
    const keys = Object.keys(buildHlsConfig(true)).sort()
    expect(keys).toEqual(['backBufferLength', 'enableWorker', 'liveSyncDurationCount', 'lowLatencyMode'])
  })
})
