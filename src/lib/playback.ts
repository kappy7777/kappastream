// Pure playback helpers shared by every HLS surface (App.svelte's
// single-stream player, Tile.svelte's multi-view tiles, PipWindow). No
// Svelte state, no Tauri invoke — callers own the policy (Windows proxy
// routing, status transitions, resolve fallbacks) and compose these.

/** Grace period before a live stall is force-recovered (snap to live edge). */
export const STALL_RECOVER_GRACE_MS = 1_000

/**
 * Whether a `pause` event should arm live stall recovery: never for a VOD or
 * clip (a deliberate pause must hold — and force-seeking a paused VOD to its
 * seekable end would jump to the video's end), never when the pause was
 * user-initiated (the flag is set BEFORE the pause by the caller, so the
 * handler can tell the two apart), and an absent isLive means not live
 * (payloads default the flag to false).
 */
export function shouldRecoverStallAfterPause(isLive: boolean | undefined, userPaused: boolean): boolean {
  return isLive === true && !userPaused
}

// Rewrite an https URL to its ksvod-proxy form. Tauri v2 fronts a custom
// URI scheme differently per webview engine:
//   Linux/macOS (WebKit)  -> ksvod://localhost/host/path
//   Windows   (WebView2)  -> http://ksvod.localhost/host/path
// The Rust proxy (vod_proxy.rs) accepts BOTH forms; the frontend must emit
// the one its engine actually routes, or the request never reaches the
// handler. Used for VOD playback (always) and live playback (Windows only —
// see isWindows).
export function toKsvodProxyUrl(httpsUrl: string, isWindows: boolean): string {
  const prefix = isWindows ? 'http://ksvod.localhost/' : 'ksvod://localhost/'
  return httpsUrl.replace('https://', prefix)
}

// hls.js fatal-error details that indicate a transport/manifest problem
// (worth surfacing as "network" rather than a generic player error). The
// check runs against BOTH `type` and `details` because hls.js is not
// consistent about where it reports each kind.
const NETWORKISH = new Set([
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
])

export function isFatalNetworkishError(data: { fatal: boolean; type: string; details?: string }): boolean {
  if (!data.fatal) return false
  return NETWORKISH.has(data.type) || NETWORKISH.has(data.details ?? '')
}

/**
 * Where a stall-recovery seek should land: hls.js's computed live sync
 * position when present, else the end of the seekable window, else null
 * (neither is finite — caller skips the seek). A NaN liveSyncPosition does
 * NOT fall back to seekableEnd (mirrors the `??` semantics of the original
 * inline copies). The result is clamped at 0 so a near-start edge can never
 * produce a negative currentTime.
 */
export function liveEdgeSeekTarget(
  liveSyncPosition: number | undefined,
  seekableEnd: number | undefined,
): number | null {
  // The trailing ?? NaN mirrors the original inline arithmetic (`: NaN`
  // fallback): absent inputs become NaN, which the finite check rejects.
  const liveEdge = liveSyncPosition ?? seekableEnd ?? NaN
  if (!Number.isFinite(liveEdge)) return null
  return Math.max(liveEdge - 1.5, 0)
}
