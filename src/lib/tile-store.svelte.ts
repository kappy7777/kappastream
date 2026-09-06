// Multi-stream split view: a small reactive store managing up to MAX_TILES
// simultaneous live streams. Pure orchestration logic (which tile holds audio,
// which chat is displayed, where a newly opened channel lands, audio authority
// flags, and the offline-close rule) so it is fully unit-testable without a DOM
// or a network.
//
// DESIGN — see the multi-view section of AGENTS.md / the task spec:
//  - Multi-view is ALWAYS OFF on startup and is NEVER persisted to localStorage.
//    Starting in multi-view after a restart would be surprising and would spawn
//    up to 4 streamlink resolve calls + 4 hls.js instances on launch.
//  - Focus is SPLIT into two independent pointers (deliberate design change —
//    the original "focus and active chat tab are one concept, never allowed to
//    drift" model was revised):
//      • AUDIO AUTHORITY (`authorityId`) — which tile has sound. Moved by
//        TILE clicks (the video area, the status-bar rows, the drag handle).
//        NOT moved by chat-tab clicks.
//      • ACTIVE CHAT (`chatId`) — which tile's chat the pane displays. Moved
//        by chat-tab clicks AND by tile clicks. The relationship is
//        ASYMMETRIC: a tile click moves both; a chat-tab click moves chat
//        only, so the user can read one channel's chat while listening to
//        another.
//    Both pointers are repaired on tile close and cleared on exit. While any
//    tile exists, each resolves to a live tile (getters fall back to the first
//    tile so the chat pane never shows "No streams open" spuriously).
//  - KEYBOARD SHORTCUT TARGET + the replace-when-full slot follow the AUDIO
//    AUTHORITY, not the active chat. The shortcuts (space/k/m/arrows/f) are
//    media controls whose feedback is audible — they must act on the stream
//    you can hear to be predictable — and only the authority tile persists
//    volume/mute to settings, so a chat-following target would let the arrow
//    keys change an inaudible tile's volume with no feedback at all.
//  - openChannel(): when < MAX_TILES it fills the next empty slot; when full it
//    replaces the AUTHORITY tile (the shortcut-target rule above). If the
//    channel is already open, it just moves both pointers to that tile (no
//    duplicate tiles). The newly added/replaced tile becomes BOTH authority and
//    active chat.
//  - Audio authority (mirrors src/lib/pip-controller.svelte.ts): by DEFAULT only
//    the authority tile is audible; moving authority to another tile moves audio
//    to it. A non-authority tile can be manually unmuted so several play at
//    once. A tile's audibility is computed by the Tile component from
//    `(isAuthority && !settings.muted) || manualUnmute`; only the AUTHORITY tile
//    ever persists volume/mute to settings (a non-authority tile's mute toggle
//    flips the local `manualUnmute` flag, never settings — the one exception is
//    an explicit unmute that must ALSO clear a global mute blocking it, see
//    planTileMuteToggle) — so a forced mute is never persisted, exactly like
//    PiP's `overridingMainMute` guard.
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
 * rule — "the authority tile is audible by default; a non-authority tile is
 * audible only if the user manually unmuted it; global mute silences
 * everything" — is unit-testable and Tile.svelte cannot silently diverge from
 * it.
 *
 * Persistence is the OTHER half of audio authority and lives entirely in
 * Tile.svelte's explicit control handlers (only the authority tile writes
 * volume/mute to `settings`; a non-authority tile's toggle flips
 * `manualUnmute`, never `settings`). The store never imports or writes
 * `settings`, so a forced mute can never be persisted by store logic.
 */
export function tileAudible(isAuthority: boolean, manualUnmute: boolean, globalMuted: boolean): boolean {
  return !globalMuted && (isAuthority || manualUnmute)
}

/**
 * Decision for a tile's mute-button click, derived from the tile's EFFECTIVE
 * audibility (tileAudible), never from the raw `manualUnmute` flag.
 *
 * Why this exists: the button's icon shows `audible`, so the toggle direction
 * must be computed from the same value. When the GLOBAL mute is on (e.g. the
 * user hit M, which in multi-view toggles the global mute), a non-authority
 * tile shows the muted icon but flipping `manualUnmute` alone changes nothing
 * audible — the global mute overrides it — and a second click flips the flag
 * back off. Presenting exactly as "unmuting a non-authority tile sometimes
 * does nothing". The honest semantics:
 *   - authority tile: toggles the global mute (persisted — explicit action).
 *   - non-authority + inaudible: make it audible — set manualUnmute AND clear
 *     the global mute if that is what is blocking it (explicit unmute; making
 *     the authority audible again too is the accepted side effect, the
 *     alternative is a button that can never keep its promise).
 *   - non-authority + audible: mute just this tile (clear manualUnmute; the
 *     global mute and the authority tile are untouched).
 */
export interface TileMutePlan {
  manualUnmute?: boolean
  globalMuted?: boolean
}

export function planTileMuteToggle(isAuthority: boolean, manualUnmute: boolean, globalMuted: boolean): TileMutePlan {
  if (isAuthority) return { globalMuted: !globalMuted }
  if (tileAudible(false, manualUnmute, globalMuted)) return { manualUnmute: false }
  return globalMuted ? { manualUnmute: true, globalMuted: false } : { manualUnmute: true }
}

/**
 * Decision for a NON-authority tile's volume control (the tile's volume slider
 * or a scroll-wheel nudge). Mirrors the single-stream PlayerControls rule
 * "dragging above 0 unmutes": setting a positive volume is an explicit unmute
 * (manualUnmute := true — and if the GLOBAL mute is what silences the tile, it
 * is cleared too, exactly like planTileMuteToggle's explicit-unmute branch), so
 * the control can never be dragged up with no audible effect. Dragging to 0
 * mutes just this tile and leaves the global mute alone. The AUTHORITY tile is
 * not handled here — its slider drives the global settings.volume (persisted,
 * it is the audio authority).
 */
export interface TileVolumePlan {
  tileVolume: number
  manualUnmute: boolean
  globalMuted?: boolean
}

export function planTileVolumeInput(volume: number, globalMuted: boolean): TileVolumePlan {
  const unmute = volume > 0
  return unmute && globalMuted
    ? { tileVolume: volume, manualUnmute: true, globalMuted: false }
    : { tileVolume: volume, manualUnmute: unmute }
}

/**
 * Apply the audio-authority rule to a media element (the Tile component calls
 * this from its $effect; tests call it with a plain stub). Centralising the
 * write here means store state and the element CANNOT disagree after a flush:
 * the element's `muted` is always `!tileAudible(...)` of the same inputs, and
 * re-running it (any effect re-run) is idempotent. It never touches settings —
 * a forced mute is applied to the element only, never persisted.
 */
export interface TileAudioTarget {
  muted: boolean
  volume: number
}

export interface TileAudioInputs {
  isAuthority: boolean
  manualUnmute: boolean
  globalMuted: boolean
  globalVolume: number
  tileVolume: number
}

export function applyTileAudio(el: TileAudioTarget, i: TileAudioInputs): void {
  el.muted = !tileAudible(i.isAuthority, i.manualUnmute, i.globalMuted)
  el.volume = i.isAuthority ? i.globalVolume : i.tileVolume
}

export interface TileState {
  /** Stable unique id (crypto.randomUUID at creation). */
  id: string
  channel: string
  /** Per-tile quality — independently settable per tile. */
  quality: string
  /**
   * A non-authority tile the user manually unmuted so it plays alongside the
   * authority one. The authority tile is audible by default (via
   * settings.muted), so this flag only matters for NON-authority tiles.
   * Flipping it never writes to settings (see the audio-authority note above).
   */
  manualUnmute: boolean
  /**
   * Per-tile volume (0–1) for NON-authority tiles (the authority tile follows
   * the global settings.volume, being the audio authority). Seeded from
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
  /** Audio authority — the tile that has sound (moved by TILE clicks only). */
  authorityId: string | null = $state(null)
  /** Active chat — the tile whose chat the pane shows (chat-tab + tile clicks). */
  chatId: string | null = $state(null)

  /**
   * Fired when the last tile closes so App.svelte can exit multi-view back to
   * the single-stream view (and, if desired, restore that channel). Set by App.
   */
  onShouldExit?: () => void

  get count(): number {
    return this.tiles.length
  }

  /** The audio-authority tile (also the keyboard-shortcut + replace target). */
  get authority(): TileState | null {
    const id = this.authorityId
    if (id) {
      const t = this.tiles.find((x) => x.id === id)
      if (t) return t
    }
    return this.tiles[0] ?? null
  }

  /** The tile whose chat the pane displays (falls back to the authority). */
  get activeChat(): TileState | null {
    const id = this.chatId
    if (id) {
      const t = this.tiles.find((x) => x.id === id)
      if (t) return t
    }
    return this.authority
  }

  isAuthority(id: string): boolean {
    return this.authority?.id === id
  }

  isActiveChat(id: string): boolean {
    return this.activeChat?.id === id
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
   * existing one reused) — both pointers always follow (see the focus-split
   * rule in the header). `seedVolume` seeds a new tile's per-tile volume (the
   * caller passes settings.volume); the store stays decoupled from settings.
   */
  addOrReplace(channel: string, quality = 'best', seedVolume = 1): { tile: TileState; created: boolean } {
    const norm = channel.toLowerCase()
    const existing = this.byChannel(norm)
    if (existing) {
      this.focusTile(existing.id)
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
      // Grid full → replace the AUTHORITY tile (the shortcut-target rule in
      // the header).
      const target = this.authority ?? this.tiles[0]
      target.channel = norm
      target.quality = quality
      target.status = 'loading'
      target.error = ''
      target.liveStatus = { state: 'unknown' }
      target.manualUnmute = false
      target.volume = seedVolume
      tile = target
    }
    this.authorityId = tile.id
    this.chatId = tile.id
    return { tile, created: true }
  }

  /**
   * TILE click (video area / status-bar row / drag handle): moves BOTH the
   * audio authority and the active chat to the tile (the focus-split rule in
   * the header — the asymmetry with selectChat is deliberate).
   */
  focusTile(id: string): void {
    if (this.byId(id)) {
      this.authorityId = id
      this.chatId = id
    }
  }

  /**
   * CHAT TAB click: moves ONLY the active chat (the focus-split rule in the
   * header — the audio authority stays put).
   */
  selectChat(id: string): void {
    if (this.byId(id)) this.chatId = id
  }

  /** Remove a tile; repair both pointers to a neighbour; exit if that was the last. */
  close(id: string): void {
    const idx = this.tiles.findIndex((t) => t.id === id)
    if (idx === -1) return
    this.tiles.splice(idx, 1)
    // The tile that took its place, else the last remaining, else none.
    const next = () => this.tiles[idx] ?? this.tiles[this.tiles.length - 1] ?? null
    if (this.authorityId === id) this.authorityId = next()?.id ?? null
    if (this.chatId === id) this.chatId = next()?.id ?? null
    if (this.tiles.length === 0) {
      this.authorityId = null
      this.chatId = null
      this.onShouldExit?.()
    }
  }

  setManualUnmute(id: string, value: boolean): void {
    const t = this.byId(id)
    if (t) t.manualUnmute = value
  }

  /** Per-tile volume for a NON-authority tile (the authority tile uses settings.volume). */
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
    if (wasLive && status.state === 'offline') {
      this.close(id)
    }
  }

  /** Tear down everything (mode toggle off / sleep timer / shutdown). */
  exitAll(): void {
    this.tiles = []
    this.authorityId = null
    this.chatId = null
  }
}

export const tileStore = new TileStore()
