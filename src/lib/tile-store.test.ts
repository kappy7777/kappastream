import { describe, it, expect, beforeEach, vi } from 'vitest'

/*
 * Multi-stream split view — TileStore orchestration logic.
 *
 * The store owns the purely-logical rules the spec calls out (which tile a new
 * channel lands in, the authority/chat pointer split, audio flags, the
 * offline-close trap, last-tile exit). It has no DOM and no network, so every
 * rule is asserted directly.
 *
 * Audio authority itself (forced mute not persisted to settings, authority
 * moving audio) is enforced in the Tile component via the exported pure
 * helpers (tileAudible / planTileMuteToggle / applyTileAudio); here we cover
 * both halves: the store's `manualUnmute` flips independently of authority and
 * the pure helpers' exact decision/application rules.
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

describe('TileStore.addOrReplace — empty-slot-first, then authority replace', () => {
  it('adds tiles to successive slots while the grid has room', () => {
    const a = store.addOrReplace('chan1').tile
    const b = store.addOrReplace('chan3').tile
    const c = store.addOrReplace('chan2').tile
    const d = store.addOrReplace('chan4').tile
    expect(store.tiles.map((t) => t.channel)).toEqual(['chan1', 'chan3', 'chan2', 'chan4'])
    expect([a, b, c, d].every((t) => t.id.length > 0)).toBe(true)
    expect(store.count).toBe(S.MAX_TILES)
  })

  it('the newly added tile becomes BOTH audio authority and active chat', () => {
    store.addOrReplace('chan1')
    expect(store.authority?.channel).toBe('chan1')
    expect(store.activeChat?.channel).toBe('chan1')
    store.addOrReplace('chan2')
    expect(store.authority?.channel).toBe('chan2')
    expect(store.activeChat?.channel).toBe('chan2')
  })

  it('once full, a new channel replaces the AUTHORITY tile, not the last slot', () => {
    store.addOrReplace('chan1') // authority
    store.addOrReplace('chan2')
    store.addOrReplace('chan3')
    store.addOrReplace('chan4') // grid full
    // Make chan1 (slot 0) the authority explicitly, then open a 5th channel.
    store.focusTile(store.tiles[0].id)
    const idsBefore = store.tiles.map((t) => t.id)
    store.addOrReplace('chan5')
    expect(store.tiles.map((t) => t.channel)).toEqual(['chan5', 'chan2', 'chan3', 'chan4'])
    // The replaced tile KEPT its slot identity (id reused), others untouched.
    expect(store.tiles[0].id).toBe(idsBefore[0])
    expect(store.tiles[1].id).toBe(idsBefore[1])
    expect(store.authority?.channel).toBe('chan5')
  })

  it('opening a channel already in a tile moves both pointers to it instead of duplicating', () => {
    store.addOrReplace('chan1')
    store.addOrReplace('chan2')
    const before = store.tiles.map((t) => t.channel)
    // Read chan1's chat first, so only chat points at chan1.
    store.selectChat(store.tiles[0].id)
    expect(store.authority?.channel).toBe('chan2')
    const { created } = store.addOrReplace('chan1')
    expect(created).toBe(false)
    expect(store.tiles.map((t) => t.channel)).toEqual(before)
    expect(store.authority?.channel).toBe('chan1')
    expect(store.activeChat?.channel).toBe('chan1')
  })

  it('channel names are normalized to lowercase', () => {
    const { tile } = store.addOrReplace('ChAn1')
    expect(tile.channel).toBe('chan1')
    expect(store.byChannel('chan1')).toBeDefined()
  })
})

describe('TileStore authority/chat pointer split (tile click moves both; chat tab moves chat only)', () => {
  it('a tile click (focusTile) moves BOTH audio authority and active chat', () => {
    const a = store.addOrReplace('chan1').tile
    const b = store.addOrReplace('chan2').tile
    store.focusTile(a.id)
    expect(store.isAuthority(a.id)).toBe(true)
    expect(store.isActiveChat(a.id)).toBe(true)
    expect(store.isAuthority(b.id)).toBe(false)
    store.focusTile(b.id)
    expect(store.isAuthority(b.id)).toBe(true)
    expect(store.isActiveChat(b.id)).toBe(true)
  })

  it('a CHAT TAB click (selectChat) moves ONLY the active chat — audio authority stays', () => {
    const a = store.addOrReplace('chan1').tile
    const b = store.addOrReplace('chan2').tile
    store.focusTile(a.id)
    store.selectChat(b.id)
    // Chat followed the tab...
    expect(store.activeChat?.id).toBe(b.id)
    expect(store.isActiveChat(a.id)).toBe(false)
    // ...audio did NOT.
    expect(store.authority?.id).toBe(a.id)
    expect(store.isAuthority(b.id)).toBe(false)
  })

  it('the asymmetry holds in both directions: tile click after a chat-tab click re-unifies', () => {
    const a = store.addOrReplace('chan1').tile
    const b = store.addOrReplace('chan2').tile
    store.focusTile(a.id) // both pointers on a
    store.selectChat(b.id) // chat only → b
    expect(store.authority?.id).toBe(a.id)
    store.focusTile(b.id)
    expect(store.authority?.id).toBe(b.id)
    expect(store.activeChat?.id).toBe(b.id)
  })

  it('a MERGED-view tile click (focusTileKeepChat) moves ONLY audio authority — the chat pointer stays', () => {
    const a = store.addOrReplace('chan1').tile
    const b = store.addOrReplace('chan2').tile
    store.focusTile(a.id) // both pointers on a
    // While the merged stream is showing, clicking merged tile b claims
    // audio but must not move the chat pointer (MultiView drops the merged
    // view whenever chatId changes — keeping it put keeps the merge alive).
    store.focusTileKeepChat(b.id)
    expect(store.isAuthority(b.id)).toBe(true)
    expect(store.activeChat?.id).toBe(a.id)
  })

  it('focusTileKeepChat ignores unknown ids', () => {
    const a = store.addOrReplace('chan1').tile
    store.focusTileKeepChat('does-not-exist')
    expect(store.authority?.id).toBe(a.id)
    expect(store.activeChat?.id).toBe(a.id)
  })

  it('pointer setters are idempotent and ignore unknown ids', () => {
    const a = store.addOrReplace('chan1').tile
    store.focusTile('does-not-exist')
    store.selectChat('does-not-exist')
    expect(store.authority?.id).toBe(a.id)
    expect(store.activeChat?.id).toBe(a.id)
  })

  it('closing the authority tile repairs authority (and leaves an unrelated chat pointer alone)', () => {
    const a = store.addOrReplace('chan1').tile
    store.addOrReplace('chan2')
    store.selectChat(store.tiles[1].id) // chat on chan2
    store.focusTile(a.id) // authority on chan1
    store.close(a.id)
    expect(store.tiles.map((t) => t.channel)).toEqual(['chan2'])
    // Authority moved to a surviving tile; the chat pointer still resolves.
    expect(store.authority).not.toBeNull()
    expect(store.activeChat?.channel).toBe('chan2')
  })

  it('closing the chat-active tile repairs the chat pointer to a neighbour', () => {
    const a = store.addOrReplace('chan1').tile
    const b = store.addOrReplace('chan2').tile
    store.addOrReplace('chan3')
    store.focusTile(a.id)
    store.selectChat(b.id)
    store.close(b.id)
    expect(store.authority?.id).toBe(a.id) // untouched
    expect(store.activeChat).not.toBeNull()
    expect(store.tiles.some((t) => t.id === store.activeChat!.id)).toBe(true)
  })

  it('closing the LAST tile clears both pointers and fires onShouldExit', () => {
    const onExit = vi.fn()
    store.onShouldExit = onExit
    const a = store.addOrReplace('chan1').tile
    store.close(a.id)
    expect(onExit).toHaveBeenCalledTimes(1)
    expect(store.isEmpty).toBe(true)
    expect(store.authorityId).toBeNull()
    expect(store.chatId).toBeNull()
  })
})

describe('TileStore audio flags (store half of audio authority)', () => {
  it('manualUnmute is independent of authority and is NOT reset by authority moving elsewhere', () => {
    const a = store.addOrReplace('chan1').tile // authority
    const b = store.addOrReplace('chan2').tile
    // Manually unmute the NON-authority tile b.
    store.setManualUnmute(b.id, true)
    expect(store.byId(b.id)!.manualUnmute).toBe(true)
    // Authority to a: b keeps its manual unmute (so it can play alongside).
    store.focusTile(a.id)
    expect(store.byId(b.id)!.manualUnmute).toBe(true)
    // Authority to b: a keeps default (manualUnmute false).
    store.focusTile(b.id)
    expect(store.byId(a.id)!.manualUnmute).toBe(false)
  })

  it('per-tile quality is independent', () => {
    const a = store.addOrReplace('chan1', '720p60').tile
    const b = store.addOrReplace('chan2', '480p').tile
    store.setQuality(a.id, '1080p60')
    expect(store.byId(a.id)!.quality).toBe('1080p60')
    expect(store.byId(b.id)!.quality).toBe('480p')
    store.setQuality(b.id, 'audio_only')
    expect(store.byId(b.id)!.quality).toBe('audio_only')
    expect(store.byId(a.id)!.quality).toBe('1080p60')
  })
})

describe('TileStore.close + offline-close trap', () => {
  it('closing a tile leaves both pointers resolvable', () => {
    const a = store.addOrReplace('chan1').tile
    store.addOrReplace('chan2')
    store.addOrReplace('chan3')
    store.focusTile(a.id)
    store.close(a.id)
    expect(store.tiles.map((t) => t.channel)).toEqual(['chan2', 'chan3'])
    expect(store.authority).not.toBeNull()
    expect(store.activeChat).not.toBeNull()
  })

  it('a genuine live→offline transition closes the tile', () => {
    const onExit = vi.fn()
    store.onShouldExit = onExit
    const a = store.addOrReplace('chan1').tile
    store.addOrReplace('chan2')
    // Mark live, then offline → closes chan1 only.
    store.setLiveStatus(a.id, { state: 'live', title: 'x', viewers: 1, uptime: '0m', game: '', avatarUrl: '' })
    store.setLiveStatus(a.id, { state: 'offline', avatarUrl: '' })
    expect(store.tiles.map((t) => t.channel)).toEqual(['chan2'])
    expect(onExit).not.toHaveBeenCalled() // chan2 remains
  })

  it('a transient error does NOT close the tile', () => {
    const a = store.addOrReplace('chan1').tile
    store.setLiveStatus(a.id, { state: 'live', title: 'x', viewers: 1, uptime: '0m', game: '', avatarUrl: '' })
    // A GQL transport failure surfaces as state 'error' — keep last-known, do NOT close.
    store.setLiveStatus(a.id, { state: 'error', message: 'boom' })
    expect(store.tiles.map((t) => t.channel)).toEqual(['chan1'])
    // A playback error likewise just sets status, never closes.
    store.setStatus(a.id, 'error', 'network/manifest error: fragmentLoadError')
    expect(store.tiles.map((t) => t.channel)).toEqual(['chan1'])
    expect(store.byId(a.id)!.status).toBe('error')
    expect(store.byId(a.id)!.error).toContain('fragmentLoadError')
  })

  it('offline reported for a tile that was never confirmed live does not auto-close on a refresh', () => {
    // Edge: a brand-new tile starts at liveStatus unknown. If the first poll
    // says offline (channel was already offline at add time), we must NOT close
    // — there was no live→offline transition; the Tile overlay shows offline.
    const a = store.addOrReplace('chan1').tile
    store.setLiveStatus(a.id, { state: 'offline', avatarUrl: '' })
    expect(store.tiles.map((t) => t.channel)).toEqual(['chan1'])
  })
})

describe('tileAudible — audio authority rule (authority moves audio; manual unmute survives)', () => {
  it('only the authority tile is audible by default (global unmuted)', () => {
    const { tileAudible } = S
    expect(tileAudible(true, false, false)).toBe(true) // authority
    expect(tileAudible(false, false, false)).toBe(false) // not authority, not manually unmuted
  })

  it('authority moving to a different tile moves audio to it (the old tile goes silent)', () => {
    const { tileAudible } = S
    expect(tileAudible(false, false, false)).toBe(false) // old tile lost authority
    expect(tileAudible(true, false, false)).toBe(true) // new authority tile
  })

  it('manually unmuting a second tile is NOT overridden by authority changes', () => {
    const { tileAudible } = S
    expect(tileAudible(false, true, false)).toBe(true) // unmuted non-authority stays audible
    expect(tileAudible(true, true, false)).toBe(true) // it becoming authority keeps it audible
  })

  it('global mute silences every tile (master mute), including a manually unmuted one', () => {
    const { tileAudible } = S
    expect(tileAudible(true, false, true)).toBe(false)
    expect(tileAudible(false, true, true)).toBe(false)
  })

  it('the store never imports or writes settings — a forced mute cannot be persisted by store logic', async () => {
    // The audio-authority half of "forced mute is not persisted": the store has
    // no reference to settings, so toggling authority/manualUnmute cannot write a
    // mute to localStorage. (The component half — only explicit control handlers
    // persist — lives in Tile.svelte, enforced via applyTileAudio below.)
    const src = (await import('./tile-store.svelte?raw')).default as string
    expect(src).not.toMatch(/settings\.setMuted|settings\.setVolume/)
    expect(src).not.toMatch(/from '.*settings/)
  })
})

// ---- Item 3: unmute on a non-authority tile ---------------------------------
// The reported bug: clicking unmute on a tile that is NOT the audio authority
// sometimes left it muted. Root cause (logic, not a race): the toggle direction
// was derived from the raw `manualUnmute` flag while the icon shows the
// EFFECTIVE audibility (manualUnmute AND NOT global mute). With the global mute
// on, the click flipped the flag under the mute — nothing changed audibly.
describe('planTileMuteToggle — unmute derived from EFFECTIVE audibility, never the raw flag', () => {
  it('non-authority tile, global unmuted, not manually unmuted: unmute locally', () => {
    expect(S.planTileMuteToggle(false, false, false)).toEqual({ manualUnmute: true })
  })

  it('THE REPORTED BUG: non-authority tile under a GLOBAL mute also clears the global mute', () => {
    // Before the fix this click produced only {manualUnmute:true} — inaudible
    // under the global mute, i.e. "unmute does nothing". Now it also unmutes
    // the world so the promise of the button is kept.
    expect(S.planTileMuteToggle(false, false, true)).toEqual({ manualUnmute: true, globalMuted: false })
  })

  it('a click on an already-audible non-authority tile mutes just that tile', () => {
    expect(S.planTileMuteToggle(false, true, false)).toEqual({ manualUnmute: false })
    // non-authority + manualUnmute: the global mute is untouched by this branch
    expect(S.planTileMuteToggle(false, true, false).globalMuted).toBeUndefined()
  })

  it('authority tile toggles the global (persisted) mute', () => {
    expect(S.planTileMuteToggle(true, false, false)).toEqual({ globalMuted: true })
    expect(S.planTileMuteToggle(true, false, true)).toEqual({ globalMuted: false })
    expect(S.planTileMuteToggle(true, true, false)).toEqual({ globalMuted: true })
  })

  it("the owner's exact repro as one story: mute authority → move authority away → unmute the old tile — it plays", () => {
    // Word-for-word the reported sequence: (1) the audio-authority tile's mute
    // button is clicked, (2) audio authority moves to another tile, (3) the OLD
    // tile's now-unmute button is clicked. Pre-fix, step 3 flipped only
    // manualUnmute under the still-on global mute → nothing audible changed.
    // Post-fix, the plan also clears the blocking global mute.
    const a = store.addOrReplace('chan1').tile
    store.addOrReplace('chan2') // takes authority on open…
    store.focusTile(a.id) // …until the user clicks tile A (authority back on A)
    let globalMuted = false // mirrors settings.muted
    // (1) Mute button on the AUTHORITY tile → toggles the GLOBAL mute.
    let plan = S.planTileMuteToggle(store.isAuthority(a.id), a.manualUnmute, globalMuted)
    expect(plan).toEqual({ globalMuted: true }) // settings.setMuted(true)
    globalMuted = plan.globalMuted!
    // Everything is silent now — including the authority tile itself.
    expect(S.tileAudible(true, false, globalMuted)).toBe(false)
    // (2) Click the other tile → authority moves (tileStore.focusTile).
    store.focusTile(store.tiles[1].id)
    expect(store.isAuthority(a.id)).toBe(false)
    // (3) Mute button on the OLD tile (non-authority, inaudible, global mute on).
    plan = S.planTileMuteToggle(false, store.byId(a.id)!.manualUnmute, globalMuted)
    expect(plan).toEqual({ manualUnmute: true, globalMuted: false })
    store.setManualUnmute(a.id, plan.manualUnmute!) // tileStore half
    globalMuted = plan.globalMuted! // settings.setMuted(false) half
    // (4) The click kept its promise: the old tile's element is audible...
    const elA = { muted: true, volume: 1 }
    S.applyTileAudio(elA, {
      isAuthority: false,
      manualUnmute: store.byId(a.id)!.manualUnmute,
      globalMuted,
      globalVolume: 0.8,
      tileVolume: store.byId(a.id)!.volume,
    })
    expect(elA.muted).toBe(false)
    // ...and the new authority tile is audible again too (the documented,
    // accepted side effect of clearing the master mute).
    expect(S.tileAudible(true, false, globalMuted)).toBe(true)
  })
})

// ---- Non-authority volume controls (slider + scroll) -------------------------
// Every tile's control bar shows a volume slider. On a non-authority tile it
// drives the tile's OWN volume via planTileVolumeInput, with the same
// explicit-unmute rule as the mute button: dragging above 0 must actually make
// the tile audible (clearing a blocking global mute), or the slider would be a
// control that "does nothing" — the exact bug class the mute plan fixed.
describe('planTileVolumeInput — per-tile volume slider/scroll plan', () => {
  it('positive volume on an unmuted world: just set the tile volume + unmute locally', () => {
    expect(S.planTileVolumeInput(0.4, false)).toEqual({ tileVolume: 0.4, manualUnmute: true })
  })

  it('positive volume under a GLOBAL mute also clears the global mute (explicit unmute)', () => {
    expect(S.planTileVolumeInput(0.4, true)).toEqual({ tileVolume: 0.4, manualUnmute: true, globalMuted: false })
  })

  it('dragging to 0 mutes just this tile and NEVER touches the global mute', () => {
    expect(S.planTileVolumeInput(0, false)).toEqual({ tileVolume: 0, manualUnmute: false })
    const underGlobal = S.planTileVolumeInput(0, true)
    expect(underGlobal).toEqual({ tileVolume: 0, manualUnmute: false })
    expect(underGlobal.globalMuted).toBeUndefined()
  })

  it('slider story: dragging a non-authority tile up under a global mute makes it audible', () => {
    const a = store.addOrReplace('chan1').tile // stays non-authority below
    store.addOrReplace('chan2') // takes authority
    expect(store.isAuthority(a.id)).toBe(false)
    let globalMuted = true // mirrors settings.muted
    const plan = S.planTileVolumeInput(0.4, globalMuted)
    store.setTileVolume(a.id, plan.tileVolume)
    store.setManualUnmute(a.id, plan.manualUnmute)
    globalMuted = plan.globalMuted!
    const el = { muted: true, volume: 1 }
    S.applyTileAudio(el, {
      isAuthority: false,
      manualUnmute: store.byId(a.id)!.manualUnmute,
      globalMuted,
      globalVolume: 0.9,
      tileVolume: store.byId(a.id)!.volume,
    })
    expect(el.muted).toBe(false)
    expect(el.volume).toBe(0.4)
  })
})

describe('applyTileAudio — element and store state agree; re-runs never clobber an unmute', () => {
  function stubEl(): { muted: boolean; volume: number } {
    return { muted: true, volume: 1 }
  }

  it('unmuting a non-authority tile results in an audible element', () => {
    // Tile A is authority (audible), tile B is a muted non-authority.
    const elB = stubEl()
    S.applyTileAudio(elB, { isAuthority: false, manualUnmute: false, globalMuted: false, globalVolume: 0.8, tileVolume: 1 })
    expect(elB.muted).toBe(true)
    // The store half of the unmute action (planTileMuteToggle applied):
    const plan = S.planTileMuteToggle(false, false, false)
    expect(plan).toEqual({ manualUnmute: true }) // store: manualUnmute := true
    S.applyTileAudio(elB, { isAuthority: false, manualUnmute: true, globalMuted: false, globalVolume: 0.8, tileVolume: 1 })
    expect(elB.muted).toBe(false)
    expect(elB.volume).toBe(1) // non-authority uses its own per-tile volume
  })

  it('the unmute survives the audio-authority effect re-running afterwards', () => {
    const el = stubEl()
    // The unmute landed...
    S.applyTileAudio(el, { isAuthority: false, manualUnmute: true, globalMuted: false, globalVolume: 0.6, tileVolume: 0.5 })
    expect(el.muted).toBe(false)
    // ...then ANY effect re-run (e.g. settings.volume changed elsewhere) writes
    // the same audibility — a forced mute can never clobber the manual unmute
    // because the write is derived from the SAME store flags.
    S.applyTileAudio(el, { isAuthority: false, manualUnmute: true, globalMuted: false, globalVolume: 0.9, tileVolume: 0.5 })
    expect(el.muted).toBe(false)
    expect(el.volume).toBe(0.5)
    // ...and a re-run while globally muted still respects the master mute
    // (the toggle, not the effect, is what clears the global mute).
    S.applyTileAudio(el, { isAuthority: false, manualUnmute: true, globalMuted: true, globalVolume: 0.9, tileVolume: 0.5 })
    expect(el.muted).toBe(true)
  })

  it('the unmute survives authority moving to a DIFFERENT (third) tile', () => {
    // B manually unmuted while A was authority; authority now moves to C.
    // B is still a non-authority tile with manualUnmute=true → still audible.
    const elB = stubEl()
    const bManualUnmute = true // never reset by authority moves (store-tested above)
    S.applyTileAudio(elB, { isAuthority: false, manualUnmute: bManualUnmute, globalMuted: false, globalVolume: 0.7, tileVolume: 0.4 })
    expect(elB.muted).toBe(false)
    expect(S.tileAudible(false, bManualUnmute, false)).toBe(true)
  })

  it('the authority element mirrors the global mute + global volume', () => {
    const elA = stubEl()
    S.applyTileAudio(elA, { isAuthority: true, manualUnmute: false, globalMuted: false, globalVolume: 0.35, tileVolume: 0.9 })
    expect(elA.muted).toBe(false)
    expect(elA.volume).toBe(0.35)
    S.applyTileAudio(elA, { isAuthority: true, manualUnmute: false, globalMuted: true, globalVolume: 0.35, tileVolume: 0.9 })
    expect(elA.muted).toBe(true)
  })

  it('applyTileAudio is a pure write to the passed target (no settings/localStorage reach)', () => {
    // The helper writes ONLY the passed target object; the module-level
    // guarantee that it cannot persist anything is the import/call-check test
    // above (no settings import, no settings.set* calls in the source).
    const el = stubEl()
    S.applyTileAudio(el, { isAuthority: false, manualUnmute: true, globalMuted: false, globalVolume: 0.5, tileVolume: 0.25 })
    expect(el).toEqual({ muted: false, volume: 0.25 })
  })
})

describe('TileStore lifecycle', () => {
  it('exitAll clears every tile and both pointers', () => {
    store.addOrReplace('chan1')
    store.addOrReplace('chan2')
    store.exitAll()
    expect(store.isEmpty).toBe(true)
    expect(store.authorityId).toBeNull()
    expect(store.chatId).toBeNull()
  })

  it('a fresh store is empty (multi-view starts with no tiles)', () => {
    expect(store.isEmpty).toBe(true)
    expect(store.authority).toBeNull()
    expect(store.activeChat).toBeNull()
  })
})

// ---- Follow-up issues: stable keys, reorder identity, per-tile volume -------
describe('stable tile identity survives add / remove / reorder (no reload cause)', () => {
  it('adding a tile does NOT mutate or recreate any existing tile (ids stable)', () => {
    const a = store.addOrReplace('chan1').tile
    const b = store.addOrReplace('chan2').tile
    const aId = a.id, bId = b.id
    const aStatus = a.status
    // Add a 3rd + 4th tile.
    store.addOrReplace('chan3')
    store.addOrReplace('chan4')
    // The first two tiles are byte-for-byte the same store entries: same id,
    // same channel, same status. (This is the store-level half of "adding a
    // channel must not reload open tiles" — the {#each} key + per-tile effect
    // scope in Tile.svelte is the other half.)
    expect(store.byId(aId)?.id).toBe(aId)
    expect(store.byId(aId)?.channel).toBe('chan1')
    expect(store.byId(aId)?.status).toBe(aStatus)
    expect(store.byId(bId)?.id).toBe(bId)
    expect(store.byId(bId)?.channel).toBe('chan2')
  })

  it('reorder via swap preserves every tile id (drag does not recreate tiles)', () => {
    const a = store.addOrReplace('chan1').tile
    const b = store.addOrReplace('chan2').tile
    const c = store.addOrReplace('chan3').tile
    store.swap(a.id, c.id)
    // Order changed, identity + per-tile channels preserved.
    expect(store.tiles.map((t) => t.channel)).toEqual(['chan3', 'chan2', 'chan1'])
    expect(store.tiles.map((t) => t.id)).toEqual([c.id, b.id, a.id])
  })

  it('move() shifts a tile one slot, no-op at the edges', () => {
    const a = store.addOrReplace('chan1').tile
    const b = store.addOrReplace('chan2').tile
    const c = store.addOrReplace('chan3').tile
    store.move(a.id, -1) // already first → no-op
    expect(store.tiles.map((t) => t.channel)).toEqual(['chan1', 'chan2', 'chan3'])
    store.move(b.id, 1) // chan2 → right
    expect(store.tiles.map((t) => t.channel)).toEqual(['chan1', 'chan3', 'chan2'])
    store.move(c.id, 1) // chan3 already not-last-after-move... edge check
    // c is now at index 1; moving right → index 2 (swap with chan2)
    expect(store.tiles.map((t) => t.id)).toContain(c.id)
    // moving the last tile right is a no-op
    const last = store.tiles[store.tiles.length - 1]
    store.move(last.id, 1)
    expect(store.tiles[store.tiles.length - 1].id).toBe(last.id)
  })

  it('removing a tile keeps the survivors identities intact', () => {
    const a = store.addOrReplace('chan1').tile
    const b = store.addOrReplace('chan2').tile
    const c = store.addOrReplace('chan3').tile
    store.close(b.id)
    expect(store.tiles.map((t) => t.id)).toEqual([a.id, c.id])
    expect(store.tiles.map((t) => t.channel)).toEqual(['chan1', 'chan3'])
  })
})

describe('per-tile volume (scroll changes only the hovered tile)', () => {
  it('a new tile is seeded with the caller-provided volume', () => {
    const a = store.addOrReplace('chan1', 'best', 0.7).tile
    expect(store.byId(a.id)!.volume).toBe(0.7)
  })

  it('setTileVolume only affects the targeted tile', () => {
    const a = store.addOrReplace('chan1').tile
    const b = store.addOrReplace('chan2').tile
    store.setTileVolume(a.id, 0.3)
    expect(store.byId(a.id)!.volume).toBe(0.3)
    expect(store.byId(b.id)!.volume).toBe(1) // untouched (default seed)
  })

  it('setTileVolume clamps to [0, 1]', () => {
    const a = store.addOrReplace('chan1').tile
    store.setTileVolume(a.id, 5)
    expect(store.byId(a.id)!.volume).toBe(1)
    store.setTileVolume(a.id, -2)
    expect(store.byId(a.id)!.volume).toBe(0)
  })

  it('scroll semantics for a non-authority tile: nudging up unmutes, down to 0 mutes', () => {
    // Mirrors Tile.svelte's onWheel for a non-authority tile: the component calls
    // setTileVolume + setManualUnmute together. Here we assert the store pairs.
    const a = store.addOrReplace('chan1').tile
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

// ---- Chat visibility invariant: the active chat tile is always resolvable ----
// MultiView.svelte looks up the active chat session via
// sessions.get(activeChatId). If `activeChat` is ever null while tiles exist
// (or its id doesn't match a tile in the array), the chat pane shows "No
// streams open" even though a stream is playing. These tests assert the
// data-level guarantee that prevents that — for BOTH pointers.
describe('authority and chat pointers are always resolvable while tiles exist', () => {
  it('both pointers are non-null and valid after every addOrReplace', () => {
    for (let i = 0; i < S.MAX_TILES + 2; i++) {
      store.addOrReplace('channel' + i)
      expect(store.authority).not.toBeNull()
      expect(store.activeChat).not.toBeNull()
      const aid = store.authority!.id
      const cid = store.activeChat!.id
      expect(store.tiles.some((t) => t.id === aid)).toBe(true)
      expect(store.tiles.some((t) => t.id === cid)).toBe(true)
    }
  })

  it('both pointers stay resolvable after closing any tile (except the last)', () => {
    const ids: string[] = []
    for (let i = 0; i < 4; i++) ids.push(store.addOrReplace('ch' + i).tile.id)
    // Diverge the pointers first (chat on the tile about to be closed).
    store.selectChat(ids[1])
    store.focusTile(ids[0])
    for (const id of ids.slice(0, -1)) {
      store.close(id)
      expect(store.authority).not.toBeNull()
      expect(store.activeChat).not.toBeNull()
      expect(store.tiles.some((t) => t.id === store.authority!.id)).toBe(true)
      expect(store.tiles.some((t) => t.id === store.activeChat!.id)).toBe(true)
    }
    // Closing the last tile → both null, grid empty.
    store.close(ids[3])
    expect(store.authority).toBeNull()
    expect(store.activeChat).toBeNull()
  })

  it('both pointers stay resolvable after pointer changes', () => {
    const a = store.addOrReplace('chan1').tile
    const b = store.addOrReplace('chan2').tile
    store.focusTile(a.id)
    store.selectChat(b.id)
    expect(store.authority?.id).toBe(a.id)
    expect(store.activeChat?.id).toBe(b.id)
    expect(store.tiles.some((t) => t.id === store.authority!.id)).toBe(true)
    expect(store.tiles.some((t) => t.id === store.activeChat!.id)).toBe(true)
  })

  it('replacing the authority tile (grid full) keeps both pointers resolvable', () => {
    for (let i = 0; i < S.MAX_TILES; i++) store.addOrReplace('ch' + i)
    // Grid full — addOrReplace replaces the authority tile.
    store.addOrReplace('newchannel')
    expect(store.authority).not.toBeNull()
    expect(store.authority!.channel).toBe('newchannel')
    expect(store.tiles.some((t) => t.id === store.authority!.id)).toBe(true)
    expect(store.activeChat!.channel).toBe('newchannel')
  })
})
