import { describe, it, expect, beforeEach, vi } from 'vitest'

/*
 * Tier 2 chat-feature toggles (sections 1–6).
 *
 * The settings store is a singleton constructed at module load and reads from
 * localStorage at construction time, so each test re-imports the module
 * (`vi.resetModules`) on a clean localStorage to assert the TRUE defaults and
 * persistence — not the state left over by an earlier test.
 *
 * Acceptance criteria covered here:
 *  - every chat-feature toggle defaults to false on a fresh store;
 *  - each toggle persists to its own localStorage key and is independent of the
 *    others (toggling one never flips another);
 *  - Toggle C is retroactive: it gates only PRESENTATION, and the predicate
 *    `isMessageStricken` already proved (in irc.test.ts) that flipping the
 *    flag re-evaluates already-stored deletions. Here we assert the store half
 *    of that contract (the flag flips live, with no reconnect).
 */

type SettingsMod = typeof import('./settings.svelte')
let S: SettingsMod

beforeEach(async () => {
  vi.resetModules()
  localStorage.clear()
  S = await import('./settings.svelte')
})

const KEYS = {
  subnotices: 'app-chat-subnotices-v1',
  roomstate: 'app-chat-roomstate-v1',
  moderation: 'app-chat-moderation-v1',
  bits: 'app-chat-bits-v1',
} as const

describe('chat-feature toggle defaults', () => {
  it('all four toggles default to false on a fresh store', () => {
    expect(S.settings.chatSubnotices).toBe(false)
    expect(S.settings.chatRoomstate).toBe(false)
    expect(S.settings.chatModeration).toBe(false)
    expect(S.settings.chatBits).toBe(false)
  })

  it('a stored "true" is respected (opt-in persists across reloads)', async () => {
    localStorage.setItem(KEYS.moderation, 'true')
    localStorage.setItem(KEYS.bits, 'true')
    vi.resetModules()
    const mod = await import('./settings.svelte')
    expect(mod.settings.chatModeration).toBe(true)
    expect(mod.settings.chatBits).toBe(true)
    // The other two remain off.
    expect(mod.settings.chatSubnotices).toBe(false)
    expect(mod.settings.chatRoomstate).toBe(false)
  })

  it('a junk value is treated as false (default off)', async () => {
    localStorage.setItem(KEYS.subnotices, 'garbage')
    vi.resetModules()
    const mod = await import('./settings.svelte')
    expect(mod.settings.chatSubnotices).toBe(false)
  })
})

describe('chat-feature toggle persistence + independence', () => {
  it('toggleChatModeration writes its own key and leaves the others alone', () => {
    S.settings.toggleChatModeration()
    expect(S.settings.chatModeration).toBe(true)
    expect(localStorage.getItem(KEYS.moderation)).toBe('true')
    // Independence: the other toggles stay false / unwritten.
    expect(S.settings.chatSubnotices).toBe(false)
    expect(S.settings.chatRoomstate).toBe(false)
    expect(S.settings.chatBits).toBe(false)
    expect(localStorage.getItem(KEYS.subnotices)).toBeNull()
    expect(localStorage.getItem(KEYS.roomstate)).toBeNull()
    expect(localStorage.getItem(KEYS.bits)).toBeNull()
  })

  it('each toggle persists and flips only itself', () => {
    S.settings.setChatSubnotices(true)
    S.settings.setChatRoomstate(true)
    S.settings.setChatBits(true)
    expect(S.settings.chatSubnotices).toBe(true)
    expect(S.settings.chatRoomstate).toBe(true)
    expect(S.settings.chatBits).toBe(true)
    expect(S.settings.chatModeration).toBe(false) // untouched
    expect(localStorage.getItem(KEYS.subnotices)).toBe('true')
    expect(localStorage.getItem(KEYS.roomstate)).toBe('true')
    expect(localStorage.getItem(KEYS.bits)).toBe('true')
    expect(localStorage.getItem(KEYS.moderation)).toBeNull()
  })

  it('setters are idempotent on the same value', () => {
    S.settings.setChatModeration(true)
    S.settings.setChatModeration(true)
    expect(S.settings.chatModeration).toBe(true)
    expect(localStorage.getItem(KEYS.moderation)).toBe('true')
    S.settings.setChatModeration(false)
    expect(localStorage.getItem(KEYS.moderation)).toBe('false')
  })
})

describe('Toggle C is retroactive (live, no reconnect)', () => {
  it('flipping chatModeration re-evaluates presentation immediately', () => {
    // Start: moderation off. A message deleted earlier in the session is
    // stored as deleted=true (parsing is ungated) but not yet presented.
    const deletedStored = true
    expect(S.settings.chatModeration).toBe(false)
    // The render predicate is settings.chatModeration && msg.deleted.
    let presented = S.settings.chatModeration && deletedStored
    expect(presented).toBe(false)

    // User enables the toggle mid-stream — same stored deletion now shows.
    S.settings.toggleChatModeration()
    presented = S.settings.chatModeration && deletedStored
    expect(presented).toBe(true)
  })
})
