// Multi-stream split view: a small reactive store managing up to MAX_TILES
// simultaneous live streams. Pure orchestration logic (which tile is focused,
// where a newly opened channel lands, audio authority flags, and the
// offline-close rule) so it is fully unit-testable without a DOM or a network.
//
// DESIGN — see the multi-view section of AGENTS.md / the task spec:
//  - Multi-view is ALWAYS OFF on startup and is NEVER persisted to localStorage.
//    Starting in multi-view after a restart would be surprising and would spawn
//    up to 4 streamlink resolve calls + 4 hls.js instances on launch.
//  - openChannel(): when < MAX_TILES it fills the next empty slot; when full it
//    replaces the FOCUSED tile. If the channel is already open, it just focuses
//    that tile (no duplicate tiles). The newly added/replaced tile becomes
//    focused (its chat tab is the active one — focus and active chat tab are one
//    concept, never allowed to drift).
//  - Exactly one tile is focused at all times (until the grid empties). Focus
//    drives: the active chat tab, the keyboard-shortcut target, the tile that
//    gets replaced when full, and (with the audio authority below) which tile is
//    audible by default.
//  - Audio authority (mirrors src/lib/pip-controller.svelte.ts): by DEFAULT only
//    the focused tile is audible; focusing another tile moves audio to it. A
//    non-focused tile can be manually unmuted so several play at once. A
//    tile's audibility is computed by the Tile component from
//    `(focused && !settings.muted) || manualUnmute`; only the FOCUSED tile ever
//    persists volume/mute to settings (non-focused tiles' mute toggle flips the
//    local `manualUnmute` flag, never settings) — so a forced mute is never
//    persisted, exactly like PiP's `overridingMainMute` guard.
//  - Offline-close (the data-loss trap): a tile closes ONLY on a genuine
//    live→offline transition (setLiveStatus with state 'offline' for a tile that
//    was previously live). A transient transport/hls error is reported via
//    setStatus('error', …) and does NOT close the tile — the Tile component
//    shows an error overlay and retries, matching the single-stream path which
//    only surfaces 'offline' from an authoritative resolve result.
//  - Closing the last remaining tile exits multi-view (onShouldExit fires).

import type { LiveStatus } from './favorites.svelte'

export const MAX_TILES = 4

export type TilePlaybackStatus = 'loading' | 'playing' | 'offline' | 'error'

/**
 * The audibility rule for a tile (the audio-authority pattern mirrored from
 * src/lib/pip-controller.svelte.ts). Exported as a PURE function so the exact
 * rule — "the focused tile is audible by default; a non-focused tile is audible
 * only if the user manually unmuted it; global mute silences everything" — is
 * unit-testable and Tile.svelte cannot silently diverge from it.
 *
 * Persistence is the OTHER half of audio authority and lives entirely in
 * Tile.svelte's explicit control handlers (only the focused tile writes
 * volume/mute to `settings`; a non-focused tile's toggle flips `manualUnmute`,
 * never `settings`). The store never imports or writes `settings`, so a forced
 * mute can never be persisted by store logic.
 */
export function tileAudible(isFocused: boolean, manualUnmute: boolean, globalMuted: boolean): boolean {
  return !globalMuted && (isFocused || manualUnmute)
}

export interface TileState {
  /** Stable unique id (crypto.randomUUID at creation). */
  id: string
  channel: string
  /** Per-tile quality — independently settable per tile. */
  quality: string
  /**
   * A non-focused tile the user manually unmuted so it plays alongside the
   * focused one. The focused tile is audible by default (via settings.muted),
   * so this flag only matters for NON-focused tiles. Flipping it never writes
   * to settings (see the audio-authority note above).
   */
  manualUnmute: boolean
  /**
   * Per-tile volume (0–1) for NON-focused tiles (the focused tile follows the
   * global settings.volume, being the audio authority). Seeded from
   * settings.volume at creation; nudged by scroll-wheel over the tile. Kept in
   * the store (not settings) so it is per-tile and never pollutes the persisted
   * global volume.
   */
  volume: number
  /** Playback status reported by the Tile component (drives overlays + status bar). */
  status: TilePlaybackStatus
  /** Error detail when status === 'error'. */
  error: string
  /** Live metadata for the status bar + offline-close detection. */
  liveStatus: LiveStatus
}

function freshTile(channel: string, quality: string, volume: number): TileState {
  return {
    id: crypto.randomUUID(),
    channel,
    quality,
    manualUnmute: false,
    volume,
    status: 'loading',
    error: '',
    liveStatus: { state: 'unknown' },
  }
}

export class TileStore {
  tiles: TileState[] = $state([])
  focusedId: string | null = $state(null)

  /**
   * Fired when the last tile closes so App.svelte can exit multi-view back to
   * the single-stream view (and, if desired, restore that channel). Set by App.
   */
  onShouldExit?: () => void

  get count(): number {
    return this.tiles.length
  }

  get focused(): TileState | null {
    const id = this.focusedId
    if (!id) return this.tiles[0] ?? null
    return this.tiles.find((t) => t.id === id) ?? null
  }

  isFocused(id: string): boolean {
    return this.focused?.id === id
  }

  byId(id: string): TileState | undefined {
    return this.tiles.find((t) => t.id === id)
  }

  byChannel(channel: string): TileState | undefined {
    const c = channel.toLowerCase()
    return this.tiles.find((t) => t.channel === c)
  }

  /** Empty when no tiles — App renders the single-stream view then. */
  get isEmpty(): boolean {
    return this.tiles.length === 0
  }

  /**
   * The single channel-open entry point for multi-view. Returns the tile that
   * ended up holding the channel and whether a NEW tile was created (vs. an
   * existing one reused/focused). Always focuses the resulting tile. `seedVolume`
   * seeds a new tile's per-tile volume (the caller passes settings.volume); the
   * store stays decoupled from settings.
   */
  addOrReplace(channel: string, quality = 'best', seedVolume = 1): { tile: TileState; created: boolean } {
    const norm = channel.toLowerCase()
    const existing = this.byChannel(norm)
    if (existing) {
      this.focus(existing.id)
      return { tile: existing, created: false }
    }
    let tile: TileState
    if (this.tiles.length < MAX_TILES) {
      this.tiles.push(freshTile(norm, quality, seedVolume))
      // Read back through the reactive array so callers receive the proxied
      // element (Svelte 5 wraps inserted objects); a held reference to the
      // pre-insertion plain object would NOT see later store mutations.
      tile = this.tiles[this.tiles.length - 1]
    } else {
      // Grid full → replace the focused tile (focus is the "active" slot).
      const target = this.focused ?? this.tiles[0]
      target.channel = norm
      target.quality = quality
      target.status = 'loading'
      target.error = ''
      target.liveStatus = { state: 'unknown' }
      target.manualUnmute = false
      target.volume = seedVolume
      tile = target
    }
    this.focusedId = tile.id
    return { tile, created: true }
  }

  focus(id: string): void {
    if (this.byId(id)) this.focusedId = id
  }

  /** Remove a tile; refocus a neighbour; exit multi-view if that was the last. */
  close(id: string): void {
    const idx = this.tiles.findIndex((t) => t.id === id)
    if (idx === -1) return
    this.tiles.splice(idx, 1)
    if (this.focusedId === id) {
      // Focus the tile that took its place, else the last remaining, else null.
      const next = this.tiles[idx] ?? this.tiles[this.tiles.length - 1] ?? null
      this.focusedId = next ? next.id : null
    }
    if (this.tiles.length === 0) {
      this.focusedId = null
      this.onShouldExit?.()
    }
  }

  setManualUnmute(id: string, value: boolean): void {
    const t = this.byId(id)
    if (t) t.manualUnmute = value
  }

  /** Per-tile volume for a NON-focused tile (the focused tile uses settings.volume). */
  setTileVolume(id: string, volume: number): void {
    const t = this.byId(id)
    if (t) t.volume = Math.max(0, Math.min(1, volume))
  }

  setQuality(id: string, quality: string): void {
    const t = this.byId(id)
    if (t) t.quality = quality
  }

  /**
   * Swap two tiles' grid positions (drag-and-drop reorder). Only the array
   * ORDER changes — tile ids, channels and all per-tile state (incl. the hls.js
   * instance owned by each Tile component) are preserved, so Svelte's keyed
   * `{#each}` MOVES the existing DOM nodes without recreating them → playback is
   * NOT interrupted. Identity is stable across a reorder.
   */
  swap(idA: string, idB: string): void {
    const ia = this.tiles.findIndex((t) => t.id === idA)
    const ib = this.tiles.findIndex((t) => t.id === idB)
    if (ia === -1 || ib === -1 || ia === ib) return
    const tmp = this.tiles[ia]
    this.tiles[ia] = this.tiles[ib]
    this.tiles[ib] = tmp
  }

  /** Move a tile one slot left (-1) or right (+1); no-op at the edges. */
  move(id: string, dir: -1 | 1): void {
    const i = this.tiles.findIndex((t) => t.id === id)
    if (i === -1) return
    const j = i + dir
    if (j < 0 || j >= this.tiles.length) return
    const tmp = this.tiles[i]
    this.tiles[i] = this.tiles[j]
    this.tiles[j] = tmp
  }

  setStatus(id: string, status: TilePlaybackStatus, error = ''): void {
    const t = this.byId(id)
    if (t) {
      t.status = status
      if (status !== 'error') t.error = ''
      else t.error = error
    }
  }

  /**
   * Live metadata for the status bar + the offline-close rule. A genuine
   * live→offline transition CLOSES the tile (the channel actually went offline).
   * Any other transition (unknown→live, live→live refresh, error) just updates
   * the bar; a 'live' with state 'error' (a GQL transport failure) is treated as
   * transient — the tile keeps its last-known status and is NOT closed.
   */
  setLiveStatus(id: string, status: LiveStatus): void {
    const t = this.byId(id)
    if (!t) return
    const wasLive = t.liveStatus.state === 'live'
    t.liveStatus = status
    // Only an authoritative offline (after being live) closes the tile.
    if (wasLive && status.state === 'offline') {
      this.close(id)
    }
  }

  /** Tear down everything (mode toggle off / sleep timer / shutdown). */
  exitAll(): void {
    this.tiles = []
    this.focusedId = null
  }
}

export const tileStore = new TileStore()
