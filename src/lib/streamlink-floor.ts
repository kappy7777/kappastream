// Streamlink version floor: when a live/VOD/clip resolve FAILS (not an
// offline channel, not an unavailable stream) and the installed streamlink
// is older than the floor, an update hint is appended to the surfaced
// error text. The hint never appears on a success and there is no startup
// nag — the version is only consulted at failure time.
//
// The floor is a support statement, not a hard gate: resolve itself is not
// blocked. Twitch-side plugin churn is what actually breaks old installs;
// the floor marks the oldest line the resolver is still expected to work
// against.

import { invoke, isTauri } from '@tauri-apps/api/core'
import { t } from './i18n/index.svelte'

export const MIN_STREAMLINK_VERSION = '6.0.0'

let installed: string | null = null

/** Dotted-numeric compare; missing parts count as 0 ("7" < "7.1"). */
export function compareVersion(a: string, b: string): number {
  const pa = a.split('.').map((p) => Number.parseInt(p, 10))
  const pb = b.split('.').map((p) => Number.parseInt(p, 10))
  const len = Math.max(pa.length, pb.length)
  for (let i = 0; i < len; i++) {
    const d = (Number.isFinite(pa[i]) ? pa[i]! : 0) - (Number.isFinite(pb[i]) ? pb[i]! : 0)
    if (d !== 0) return d
  }
  return 0
}

export function belowStreamlinkFloor(version: string | null | undefined): boolean {
  if (!version) return false
  return compareVersion(version, MIN_STREAMLINK_VERSION) < 0
}

/** The installed streamlink's reported version, or null when unknown. */
export function installedStreamlinkVersion(): string | null {
  return installed
}

/**
 * Fetch streamlink's reported version once (idempotent, fire-and-forget at
 * app mount; silent on every failure — an unknown version simply never
 * produces a hint).
 */
export async function initStreamlinkVersion(): Promise<void> {
  if (!isTauri() || installed !== null) return
  try {
    const status = await invoke<{ present: boolean; version?: string | null }>('streamlink_status')
    installed = status.present ? (status.version ?? null) : null
  } catch {
    installed = null
  }
}

/** The hint line for a resolve failure, or null when it does not apply. */
export function streamlinkFloorHint(version: string | null | undefined): string | null {
  return belowStreamlinkFloor(version)
    ? t('player_streamlinkOld', { version: version!, min: MIN_STREAMLINK_VERSION })
    : null
}
