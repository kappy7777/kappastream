// Shared volume-adjustment math used by BOTH the single-stream player
// (PlayerControls.svelte) and the multi-view tiles (Tile.svelte), so there is
// ONE implementation of "scroll = nudge volume" — the single-stream behaviour is
// byte-identical (same step, same clamp), and multi-view reuses the exact same
// math for per-tile volume. The mute/unmute policy around it differs by context
// (single-stream toggles the element's muted; multi-view toggles the global mute
// for the focused tile or the per-tile manualUnmute for the others) and stays at
// the call sites.

export const VOLUME_STEP = 0.05

/** Clamp a one-step nudge of `current` (0–1) by scroll direction (+1 up / -1 down). */
export function nextVolume(current: number, dir: number): number {
  return Math.max(0, Math.min(1, current + dir * VOLUME_STEP))
}
