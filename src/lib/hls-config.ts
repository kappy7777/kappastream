import type { HlsConfig } from 'hls.js'

// hls.js's documented default for liveSyncDurationCount (start ~3 segments
// behind the live edge in normal live mode). Mirrored here as a named constant
// so the config and its tests reference the same value instead of a magic 3.
export const LIVE_SYNC_DURATION_COUNT_DEFAULT = 3
export const BACK_BUFFER_LENGTH = 30

/**
 * Build the hls.js constructor config for a live Twitch stream.
 *
 * `lowLatency` is the user's Low Latency setting. It MUST drive BOTH the
 * streamlink side (resolve.rs passes `--twitch-low-latency` to fetch the LL-HLS
 * playlist) AND `lowLatencyMode` here. The two have to agree: `lowLatencyMode`
 * tells hls.js to parse LL-HLS partial segments and chase the live edge, which
 * only an actual low-latency playlist provides. Pointing `lowLatencyMode` at a
 * regular playlist makes hls.js run in tiny-buffer latency-chasing mode with no
 * partial segments to load — constant micro-underruns (micro-stutter) and, in
 * webkit2gtk, decoder stalls that freeze the picture while audio keeps going.
 *
 * Two correctness rules baked in (see hls-config.test.ts):
 *  1. `lowLatencyMode` is never hardcoded — it tracks `lowLatency` exactly.
 *  2. `liveSyncDurationCount` is always a real number, never `undefined`.
 *     hls.js merges user config over its defaults with a shallow object spread
 *     (`{...defaults, ...userConfig}`) which does NOT skip `undefined` — an
 *     explicit `undefined` overwrites the default instead of inheriting it.
 */
export function buildHlsConfig(lowLatency: boolean): Partial<HlsConfig> {
  return {
    enableWorker: true,
    backBufferLength: BACK_BUFFER_LENGTH,
    lowLatencyMode: lowLatency,
    // 1 segment behind the edge when chasing latency; hls.js's own default (3)
    // in normal mode so the player has a comfortable buffer to smooth over
    // segment-load hiccups.
    liveSyncDurationCount: lowLatency ? 1 : LIVE_SYNC_DURATION_COUNT_DEFAULT,
  }
}
