import type { HlsConfig } from 'hls.js'

// hls.js's documented default for liveSyncDurationCount (start ~3 segments
// behind the live edge in normal live mode). Mirrored here as a named constant
// so the config and its tests reference the same value instead of a magic 3.
export const LIVE_SYNC_DURATION_COUNT_DEFAULT = 3
export const BACK_BUFFER_LENGTH = 30

/**
 * Time-to-first-byte budget for fragment loads that ride the ksvod proxy.
 * The proxy buffers each whole segment before answering (Tauri's custom
 * protocol has no streaming response), so hls.js measures TTFB as the FULL
 * download — on a slow link that legitimately exceeds hls.js's 10 s
 * default, every segment "times out", retries from byte zero (while the
 * abandoned download keeps running proxy-side), and playback fails after
 * the retry budget. The budget sits just above the proxy's 30 s overall
 * timeout (PROXY_TIMEOUT in vod_proxy.rs) so a fetch that can complete in
 * time always gets the chance. Manifest loads are unaffected — their
 * default TTFB is already Infinity.
 */
export const PROXIED_FRAG_TTFB_MS = 32_000

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
export function buildHlsConfig(lowLatency: boolean, opts?: { proxied?: boolean }): Partial<HlsConfig> {
  const config: Partial<HlsConfig> = {
    enableWorker: true,
    backBufferLength: BACK_BUFFER_LENGTH,
    lowLatencyMode: lowLatency,
    // 1 segment behind the edge when chasing latency; hls.js's own default (3)
    // in normal mode so the player has a comfortable buffer to smooth over
    // segment-load hiccups.
    liveSyncDurationCount: lowLatency ? 1 : LIVE_SYNC_DURATION_COUNT_DEFAULT,
  }
  if (opts?.proxied) {
    // The policy is written COMPLETE (hls.js merges user config over its
    // defaults with a shallow spread): every field below mirrors the
    // library default except the TTFB budget.
    config.fragLoadPolicy = {
      default: {
        maxTimeToFirstByteMs: PROXIED_FRAG_TTFB_MS,
        maxLoadTimeMs: 120_000,
        timeoutRetry: { maxNumRetry: 4, retryDelayMs: 0, maxRetryDelayMs: 0 },
        errorRetry: { maxNumRetry: 6, retryDelayMs: 1000, maxRetryDelayMs: 8000 },
      },
    }
  }
  return config
}
