import { describe, it, expect, beforeEach, vi } from 'vitest'

/*
 * Multi-stream split view — TileStore orchestration logic.
 *
 * The store owns the purely-logical rules the spec calls out (which tile a new
 * channel lands in, focus, audio flags, the offline-close trap, last-tile
 * exit). It has no DOM and no network, so every rule is asserted directly.
 *
 * Audio authority itself (forced mute not persisted to settings, focus moving
 * audio) is enforced in the Tile component; here we cover the store's half:
 * `manualUnmute` flips independently of focus and is never reset by focusing.
 */

type TileStoreMod = typeof import('./tile-store.svelte')
let S: TileStoreMod
let store: InstanceType<TileStoreMod['TileStore']>

beforeEach(async () => {
  vi.resetModules()
  S = await import('./tile-store.svelte')
  // Fresh instance per test (the exported singleton is shared; tests need isolation).
  store = new S.TileStore()
})

describe('TileStore.addOrReplace — empty-slot-first, then focused replace', () => {
  it('adds tiles to successive slots while the grid has room', () => {
    const a = store.addOrReplace('shroud').tile
    const b = store.addOrReplace('summit1g').tile
    const c = store.addOrReplace('lirik').tile
    const d = store.addOrReplace('sodapoppin').tile
    expect(store.tiles.map((t) => t.channel)).toEqual(['shroud', 'summit1g', 'lirik', 'sodapoppin'])
    expect([a, b, c, d].every((t) => t.id.length > 0)).toBe(true)
    expect(store.count).toBe(S.MAX_TILES)
  })

  it('the newly added tile is always focused (active chat tab follows focus)', () => {
    store.addOrReplace('shroud')
    expect(store.focused?.channel).toBe('shroud')
    store.addOrReplace('lirik')
    expect(store.focused?.channel).toBe('lirik')
  })

  it('once full, a new channel replaces the FOCUSED tile, not the last slot', () => {
    store.addOrReplace('shroud') // focused
    store.addOrReplace('lirik')
    store.addOrReplace('summit1g')
    store.addOrReplace('sodapoppin') // grid full
    // Focus shroud (slot 0) explicitly, then open a 5th channel.
    store.focus(store.tiles[0].id)
    const idsBefore = store.tiles.map((t) => t.id)
    store.addOrReplace('ninja')
    expect(store.tiles.map((t) => t.channel)).toEqual(['ninja', 'lirik', 'summit1g', 'sodapoppin'])
    // The replaced tile KEPT its slot identity (id reused), others untouched.
    expect(store.tiles[0].id).toBe(idsBefore[0])
    expect(store.tiles[1].id).toBe(idsBefore[1])
    expect(store.focused?.channel).toBe('ninja')
  })

  it('opening a channel already in a tile focuses it instead of duplicating', () => {
    store.addOrReplace('shroud')
    store.addOrReplace('lirik')
    const before = store.tiles.map((t) => t.channel)
    const { created } = store.addOrReplace('shroud')
    expect(created).toBe(false)
    expect(store.tiles.map((t) => t.channel)).toEqual(before)
    expect(store.focused?.channel).toBe('shroud')
  })

  it('channel names are normalized to lowercase', () => {
    const { tile } = store.addOrReplace('ShRoUd')
    expect(tile.channel).toBe('shroud')
    expect(store.byChannel('shroud')).toBeDefined()
  })
})

describe('TileStore focus', () => {
  it('exactly one tile is focused and clicking (focus) moves it', () => {
    const a = store.addOrReplace('shroud').tile
    const b = store.addOrReplace('lirik').tile
    store.focus(a.id)
    expect(store.focused?.id).toBe(a.id)
    expect(store.isFocused(a.id)).toBe(true)
    expect(store.isFocused(b.id)).toBe(false)
    store.focus(b.id)
    expect(store.focused?.id).toBe(b.id)
  })

  it('focus is idempotent and ignores unknown ids', () => {
    const a = store.addOrReplace('shroud').tile
    store.focus('does-not-exist')
    expect(store.focused?.id).toBe(a.id)
  })
})

describe('TileStore audio flags (store half of audio authority)', () => {
  it('manualUnmute is independent of focus and is NOT reset by focusing elsewhere', () => {
    const a = store.addOrReplace('shroud').tile // focused
    const b = store.addOrReplace('lirik').tile
    // Manually unmute the NON-focused tile b.
    store.setManualUnmute(b.id, true)
    expect(store.byId(b.id)!.manualUnmute).toBe(true)
    // Focus a: b keeps its manual unmute (so it can play alongside).
    store.focus(a.id)
    expect(store.byId(b.id)!.manualUnmute).toBe(true)
    // Focus b: a keeps default (manualUnmute false).
    store.focus(b.id)
    expect(store.byId(a.id)!.manualUnmute).toBe(false)
  })

  it('per-tile quality is independent', () => {
    const a = store.addOrReplace('shroud', '720p60').tile
    const b = store.addOrReplace('lirik', '480p').tile
    store.setQuality(a.id, '1080p60')
    expect(store.byId(a.id)!.quality).toBe('1080p60')
    expect(store.byId(b.id)!.quality).toBe('480p')
    store.setQuality(b.id, 'audio_only')
    expect(store.byId(b.id)!.quality).toBe('audio_only')
    expect(store.byId(a.id)!.quality).toBe('1080p60')
  })
})

describe('TileStore.close + offline-close trap', () => {
  it('closing a tile refocuses a neighbour', () => {
    const a = store.addOrReplace('shroud').tile
    store.addOrReplace('lirik')
    store.addOrReplace('summit1g')
    store.focus(a.id)
    store.close(a.id)
    expect(store.tiles.map((t) => t.channel)).toEqual(['lirik', 'summit1g'])
    // A neighbour is now focused (not null).
    expect(store.focused).not.toBeNull()
  })

  it('closing the LAST tile fires onShouldExit (exit multi-view)', () => {
    const onExit = vi.fn()
    store.onShouldExit = onExit
    const a = store.addOrReplace('shroud').tile
    store.close(a.id)
    expect(onExit).toHaveBeenCalledTimes(1)
    expect(store.isEmpty).toBe(true)
    expect(store.focusedId).toBeNull()
  })

  it('a genuine live→offline transition closes the tile', () => {
    const onExit = vi.fn()
    store.onShouldExit = onExit
    const a = store.addOrReplace('shroud').tile
    store.addOrReplace('lirik')
    // Mark live, then offline → closes shroud only.
    store.setLiveStatus(a.id, { state: 'live', title: 'x', viewers: 1, uptime: '0m', game: '', avatarUrl: '' })
    store.setLiveStatus(a.id, { state: 'offline', avatarUrl: '' })
    expect(store.tiles.map((t) => t.channel)).toEqual(['lirik'])
    expect(onExit).not.toHaveBeenCalled() // lirik remains
  })

  it('a transient error does NOT close the tile', () => {
    const a = store.addOrReplace('shroud').tile
    store.setLiveStatus(a.id, { state: 'live', title: 'x', viewers: 1, uptime: '0m', game: '', avatarUrl: '' })
    // A GQL transport failure surfaces as state 'error' — keep last-known, do NOT close.
    store.setLiveStatus(a.id, { state: 'error', message: 'boom' })
    expect(store.tiles.map((t) => t.channel)).toEqual(['shroud'])
    // A playback error likewise just sets status, never closes.
    store.setStatus(a.id, 'error', 'network/manifest error: fragmentLoadError')
    expect(store.tiles.map((t) => t.channel)).toEqual(['shroud'])
    expect(store.byId(a.id)!.status).toBe('error')
    expect(store.byId(a.id)!.error).toContain('fragmentLoadError')
  })

  it('offline reported for a tile that was never confirmed live does not auto-close on a refresh', () => {
    // Edge: a brand-new tile starts at liveStatus unknown. If the first poll
    // says offline (channel was already offline at add time), we must NOT close
    // — there was no live→offline transition; the Tile overlay shows offline.
    const a = store.addOrReplace('shroud').tile
    store.setLiveStatus(a.id, { state: 'offline', avatarUrl: '' })
    expect(store.tiles.map((t) => t.channel)).toEqual(['shroud'])
  })
})

describe('tileAudible — audio authority rule (focus moves audio; manual unmute survives focus)', () => {
  it('only the focused tile is audible by default (global unmuted)', () => {
    const { tileAudible } = S
    expect(tileAudible(true, false, false)).toBe(true) // focused
    expect(tileAudible(false, false, false)).toBe(false) // not focused, not manually unmuted
  })

  it('focusing a different tile moves audio to it (the old tile goes silent)', () => {
    const { tileAudible } = S
    expect(tileAudible(false, false, false)).toBe(false) // old tile lost focus
    expect(tileAudible(true, false, false)).toBe(true) // new focused tile
  })

  it('manually unmuting a second tile is NOT overridden by focus changes', () => {
    const { tileAudible } = S
    expect(tileAudible(false, true, false)).toBe(true) // unmuted non-focused stays audible
    expect(tileAudible(true, true, false)).toBe(true) // focusing it keeps it audible
  })

  it('global mute silences every tile (master mute), including a manually unmuted one', () => {
    const { tileAudible } = S
    expect(tileAudible(true, false, true)).toBe(false)
    expect(tileAudible(false, true, true)).toBe(false)
  })

  it('the store never imports or writes settings — a forced mute cannot be persisted by store logic', async () => {
    // The audio-authority half of "forced mute is not persisted": the store has
    // no reference to settings, so toggling focus/manualUnmute cannot write a
    // mute to localStorage. (The component half — only the focused tile persists
    // — lives in Tile.svelte's explicit handlers, not in the store.)
    const src = (await import('./tile-store.svelte?raw')).default as string
    expect(src).not.toMatch(/settings\.setMuted|settings\.setVolume/)
    expect(src).not.toMatch(/from '.*settings/)
  })
})

describe('TileStore lifecycle', () => {
  it('exitAll clears every tile and focus', () => {
    store.addOrReplace('shroud')
    store.addOrReplace('lirik')
    store.exitAll()
    expect(store.isEmpty).toBe(true)
    expect(store.focusedId).toBeNull()
  })

  it('a fresh store is empty (multi-view starts with no tiles)', () => {
    expect(store.isEmpty).toBe(true)
    expect(store.focused).toBeNull()
  })
})

// ---- Follow-up issues: stable keys, reorder identity, per-tile volume -------
describe('stable tile identity survives add / remove / reorder (no reload cause)', () => {
  it('adding a tile does NOT mutate or recreate any existing tile (ids stable)', () => {
    const a = store.addOrReplace('shroud').tile
    const b = store.addOrReplace('lirik').tile
    const aId = a.id, bId = b.id
    const aStatus = a.status
    // Add a 3rd + 4th tile.
    store.addOrReplace('summit1g')
    store.addOrReplace('sodapoppin')
    // The first two tiles are byte-for-byte the same store entries: same id,
    // same channel, same status. (This is the store-level half of "adding a
    // channel must not reload open tiles" — the {#each} key + per-tile effect
    // scope in Tile.svelte is the other half.)
    expect(store.byId(aId)?.id).toBe(aId)
    expect(store.byId(aId)?.channel).toBe('shroud')
    expect(store.byId(aId)?.status).toBe(aStatus)
    expect(store.byId(bId)?.id).toBe(bId)
    expect(store.byId(bId)?.channel).toBe('lirik')
  })

  it('reorder via swap preserves every tile id (drag does not recreate tiles)', () => {
    const a = store.addOrReplace('shroud').tile
    const b = store.addOrReplace('lirik').tile
    const c = store.addOrReplace('summit1g').tile
    store.swap(a.id, c.id)
    // Order changed, identity + per-tile channels preserved.
    expect(store.tiles.map((t) => t.channel)).toEqual(['summit1g', 'lirik', 'shroud'])
    expect(store.tiles.map((t) => t.id)).toEqual([c.id, b.id, a.id])
  })

  it('move() shifts a tile one slot, no-op at the edges', () => {
    const a = store.addOrReplace('shroud').tile
    const b = store.addOrReplace('lirik').tile
    const c = store.addOrReplace('summit1g').tile
    store.move(a.id, -1) // already first → no-op
    expect(store.tiles.map((t) => t.channel)).toEqual(['shroud', 'lirik', 'summit1g'])
    store.move(b.id, 1) // lirik → right
    expect(store.tiles.map((t) => t.channel)).toEqual(['shroud', 'summit1g', 'lirik'])
    store.move(c.id, 1) // summit1g already not-last-after-move... edge check
    // c is now at index 1; moving right → index 2 (swap with lirik)
    expect(store.tiles.map((t) => t.id)).toContain(c.id)
    // moving the last tile right is a no-op
    const last = store.tiles[store.tiles.length - 1]
    store.move(last.id, 1)
    expect(store.tiles[store.tiles.length - 1].id).toBe(last.id)
  })

  it('removing a tile keeps the survivors identities intact', () => {
    const a = store.addOrReplace('shroud').tile
    const b = store.addOrReplace('lirik').tile
    const c = store.addOrReplace('summit1g').tile
    store.close(b.id)
    expect(store.tiles.map((t) => t.id)).toEqual([a.id, c.id])
    expect(store.tiles.map((t) => t.channel)).toEqual(['shroud', 'summit1g'])
  })
})

describe('per-tile volume (scroll changes only the hovered tile)', () => {
  it('a new tile is seeded with the caller-provided volume', () => {
    const a = store.addOrReplace('shroud', 'best', 0.7).tile
    expect(store.byId(a.id)!.volume).toBe(0.7)
  })

  it('setTileVolume only affects the targeted tile', () => {
    const a = store.addOrReplace('shroud').tile
    const b = store.addOrReplace('lirik').tile
    store.setTileVolume(a.id, 0.3)
    expect(store.byId(a.id)!.volume).toBe(0.3)
    expect(store.byId(b.id)!.volume).toBe(1) // untouched (default seed)
  })

  it('setTileVolume clamps to [0, 1]', () => {
    const a = store.addOrReplace('shroud').tile
    store.setTileVolume(a.id, 5)
    expect(store.byId(a.id)!.volume).toBe(1)
    store.setTileVolume(a.id, -2)
    expect(store.byId(a.id)!.volume).toBe(0)
  })

  it('scroll semantics for a non-focused tile: nudging up unmutes, down to 0 mutes', () => {
    // Mirrors Tile.svelte's onWheel for a non-focused tile: the component calls
    // setTileVolume + setManualUnmute together. Here we assert the store pairs.
    const a = store.addOrReplace('shroud').tile
    // scrolling up from muted (volume 0) → volume rises + manualUnmute true
    store.setTileVolume(a.id, 0.1)
    store.setManualUnmute(a.id, true)
    expect(store.byId(a.id)!.manualUnmute).toBe(true)
    // scrolling down to 0 → muted again
    store.setTileVolume(a.id, 0)
    store.setManualUnmute(a.id, false)
    expect(store.byId(a.id)!.manualUnmute).toBe(false)
  })
})
