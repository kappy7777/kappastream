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

describe('update-check toggle (default on, opt-out)', () => {
  // The startup update check is the one outbound request that is not a direct
  // consequence of a user action, so it is the one worth gating. It defaults
  // ON (matches the pre-toggle v0.2.6 behaviour); only an explicit 'false'
  // opts out — same shape as close-to-tray.
  const KEY = 'app-check-updates-v1'

  it('defaults to true on a fresh store', () => {
    expect(S.settings.checkUpdates).toBe(true)
  })

  it('a stored "false" is respected (opt-out persists across reloads)', async () => {
    localStorage.setItem(KEY, 'false')
    vi.resetModules()
    const mod = await import('./settings.svelte')
    expect(mod.settings.checkUpdates).toBe(false)
  })

  it('a junk value is treated as true (default on)', async () => {
    localStorage.setItem(KEY, 'garbage')
    vi.resetModules()
    const mod = await import('./settings.svelte')
    expect(mod.settings.checkUpdates).toBe(true)
  })

  it('toggleCheckUpdates flips the value and persists', () => {
    expect(S.settings.checkUpdates).toBe(true)
    S.settings.toggleCheckUpdates()
    expect(S.settings.checkUpdates).toBe(false)
    expect(localStorage.getItem(KEY)).toBe('false')
    S.settings.toggleCheckUpdates()
    expect(S.settings.checkUpdates).toBe(true)
    expect(localStorage.getItem(KEY)).toBe('true')
  })
})

/*
 * Client-side chat mute list.
 *
 * Matching is on the STABLE `login` field (the lowercased IRC nick), never on a
 * display name. The list is reactive: add/remove re-evaluates the render
 * predicate for messages already in the buffer (live, no reconnect). Input is
 * normalized (lowercased, non-login chars stripped) and deduped; the list is
 * capped so localStorage can't grow unbounded.
 */
const MUTE_KEY = 'app-chat-muted-v1'

describe('mute list defaults', () => {
  it('starts empty on a fresh store', () => {
    expect(S.settings.mutedUsers).toEqual([])
    expect(S.settings.isMuted('anyone')).toBe(false)
  })

  it('a stored list is loaded (opt-in persists across reloads)', async () => {
    localStorage.setItem(MUTE_KEY, JSON.stringify(['troll', 'spammer']))
    vi.resetModules()
    const mod = await import('./settings.svelte')
    expect(mod.settings.mutedUsers).toEqual(['troll', 'spammer'])
    expect(mod.settings.isMuted('troll')).toBe(true)
  })

  it('junk in storage is dropped, not crash', async () => {
    localStorage.setItem(MUTE_KEY, '{not json')
    vi.resetModules()
    const mod = await import('./settings.svelte')
    expect(mod.settings.mutedUsers).toEqual([])
  })
})

describe('mute list matches on login, never display-name caps', () => {
  it('adding "@TrOlL!" mutes the login "troll" (normalization + stable field)', () => {
    expect(S.settings.addMutedUser('@TrOlL!')).toBe('troll')
    // The render predicate is fed the sender's LOGIN (already lowercased by the
    // IRC parser). A message from login "troll" is hidden regardless of how the
    // sender's display-name is capitalized.
    expect(S.settings.isMuted('troll')).toBe(true)
    expect(S.settings.isMuted('TROLL')).toBe(true)
    expect(S.settings.isMuted('TrOlL')).toBe(true)
  })

  it('a different login that happens to share a display name is NOT muted', () => {
    S.settings.addMutedUser('troll')
    // The match key is the login supplied to isMuted — a different login is not
    // affected even if its display-name visually matches.
    expect(S.settings.isMuted('someoneelse')).toBe(false)
  })

  it('an empty/null login (e.g. an anon USERNOTICE) is never muted', () => {
    S.settings.addMutedUser('troll')
    expect(S.settings.isMuted('')).toBe(false)
    expect(S.settings.isMuted(null)).toBe(false)
    expect(S.settings.isMuted(undefined)).toBe(false)
  })
})

describe('mute list live apply / unapply (retroactive, no reconnect)', () => {
  it('adding a mute immediately hides already-buffered senders', () => {
    expect(S.settings.isMuted('noise')).toBe(false)
    let presented = !S.settings.isMuted('noise')
    expect(presented).toBe(true)
    S.settings.addMutedUser('noise')
    presented = !S.settings.isMuted('noise')
    expect(presented).toBe(false) // hidden now, same buffer
  })

  it('removing a mute shows the sender again immediately', () => {
    S.settings.addMutedUser('noise')
    expect(S.settings.isMuted('noise')).toBe(true)
    S.settings.removeMutedUser('noise')
    expect(S.settings.isMuted('noise')).toBe(false)
  })
})

describe('mute list persistence + input validation', () => {
  it('persists to its own localStorage key', () => {
    S.settings.addMutedUser('troll')
    expect(JSON.parse(localStorage.getItem(MUTE_KEY) ?? '[]')).toEqual(['troll'])
    S.settings.addMutedUser('bot')
    expect(JSON.parse(localStorage.getItem(MUTE_KEY) ?? '[]')).toEqual(['troll', 'bot'])
  })

  it('rejects empty / whitespace-only / punctuation-only input', () => {
    expect(S.settings.addMutedUser('')).toBeNull()
    expect(S.settings.addMutedUser('   ')).toBeNull()
    expect(S.settings.addMutedUser('!!!')).toBeNull()
    expect(S.settings.mutedUsers).toEqual([])
    expect(localStorage.getItem(MUTE_KEY)).toBeNull()
  })

  it('rejects duplicates (case- and decoration-insensitive)', () => {
    S.settings.addMutedUser('troll')
    expect(S.settings.addMutedUser('TROLL')).toBeNull()
    expect(S.settings.addMutedUser('@troll!')).toBeNull()
    expect(S.settings.mutedUsers).toEqual(['troll'])
  })

  it('is capped at MAX_MUTED_USERS (no unbounded localStorage growth)', async () => {
    vi.resetModules()
    const mod = await import('./settings.svelte')
    for (let i = 0; i < mod.MAX_MUTED_USERS; i++) mod.settings.addMutedUser('u' + i)
    expect(mod.settings.mutedUsers).toHaveLength(mod.MAX_MUTED_USERS)
    // Over-cap add is rejected, list unchanged.
    expect(mod.settings.addMutedUser('overflow')).toBeNull()
    expect(mod.settings.mutedUsers).toHaveLength(mod.MAX_MUTED_USERS)
    expect(mod.settings.mutedUsers).not.toContain('overflow')
  })

  it('removeMutedUser is a no-op for an unknown name', () => {
    S.settings.addMutedUser('troll')
    S.settings.removeMutedUser('nobody')
    expect(S.settings.mutedUsers).toEqual(['troll'])
  })
})
