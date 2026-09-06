import { describe, it, expect, afterEach } from 'vitest'
import {
  parseIrcLine,
  parseIrcEvent,
  mergeRoomState,
  activeRoomModes,
  composeUsernoticeFallback,
  usernoticeCategory,
  isNoticeVisible,
  isMessageStricken,
  setGlobalBadges,
  resolveBadgeImageUrl,
  type RoomstateEvent,
  type RoomState,
} from './irc'
import { BASELINE_BADGES } from './badges.generated'

/*
 * Tests for the IRCv3 tag-value escape decoder inside parseIrcLine
 * (src/lib/irc.ts decodeTagValue). The decoder is not exported directly, so
 * each escape is asserted through parseIrcLine on a realistic PRIVMSG whose
 * `display-name` tag carries the escape sequence under test. This is the same
 * path the live IRC socket feeds through, so it covers the parser + decoder
 * together.
 */

// Build a PRIVMSG line whose `display-name` tag carries the raw (already-
// escaped) value `raw`. The rest of the line is a minimal valid PRIVMSG.
function lineWithDisplayName(raw: string): string {
  return `@display-name=${raw};id=abc;tmi-sent-ts=0 :nick!nick@nick.tmi.twitch.tv PRIVMSG #channel :hello`
}

describe('decodeTagValue (via parseIrcLine display-name)', () => {
  it('decodes \\s to a space', () => {
    const msg = parseIrcLine(lineWithDisplayName('foo\\sbar'))
    expect(msg?.displayName).toBe('foo bar')
  })

  it('decodes \\n to a newline', () => {
    const msg = parseIrcLine(lineWithDisplayName('foo\\nbar'))
    expect(msg?.displayName).toBe('foo\nbar')
  })

  it('decodes \\r to a carriage return', () => {
    const msg = parseIrcLine(lineWithDisplayName('foo\\rbar'))
    expect(msg?.displayName).toBe('foo\rbar')
  })

  it('decodes \\: to a semicolon', () => {
    // `;` would otherwise split the tag, so this also confirms decode happens
    // before tag splitting would have a chance to mis-cut.
    const msg = parseIrcLine(lineWithDisplayName('foo\\:bar'))
    expect(msg?.displayName).toBe('foo;bar')
  })

  it('decodes \\\\ to a single backslash', () => {
    const msg = parseIrcLine(lineWithDisplayName('foo\\\\bar'))
    expect(msg?.displayName).toBe('foo\\bar')
  })

  it('drops the backslash for an unknown escape, keeping the char', () => {
    // \q is not a defined IRCv3 escape: the backslash is removed and 'q' is
    // kept as-is.
    const msg = parseIrcLine(lineWithDisplayName('foo\\qbar'))
    expect(msg?.displayName).toBe('fooqbar')
  })

  it('does not mis-decode \\\\ followed by s (a\\\\sb → a\\sb, not a\\ b)', () => {
    // Regression: the old sequential .replace() chain ran `\\` → `\` before
    // `\s` → ` `, turning `a\\sb` into `a\ b`. The single-pass decoder
    // consumes `\\` as one escape, leaving `sb` literal.
    const msg = parseIrcLine(lineWithDisplayName('a\\\\sb'))
    expect(msg?.displayName).toBe('a\\sb')
  })
})

/*
 * Tier 2 chat-completeness tests.
 *
 * The legacy parseIrcLine must still return ONLY PRIVMSG (baseline unchanged),
 * while parseIrcEvent surfaces USERNOTICE / ROOMSTATE / CLEARMSG / CLEARCHAT.
 * PRIVMSG now also carries userId + bits. Tag unescaping (the prerequisite)
 * is already covered above and applies to every tag value including system-msg.
 */

describe('parseIrcLine baseline (PRIVMSG only)', () => {
  it('returns null for non-PRIVMSG events', () => {
    expect(parseIrcLine('@msg-id=raid :tmi.twitch.tv USERNOTICE #channel')).toBeNull()
    expect(parseIrcLine(':tmi.twitch.tv ROOMSTATE #channel')).toBeNull()
    expect(parseIrcLine(':tmi.twitch.tv CLEARCHAT #channel')).toBeNull()
  })

  it('still parses a normal PRIVMSG and exposes userId + bits', () => {
    const msg = parseIrcLine(
      '@id=abc;user-id=42;bits=500;display-name=Bob;tmi-sent-ts=0 :bob!bob@bob.tmi.twitch.tv PRIVMSG #channel :cheer100',
    )
    expect(msg).not.toBeNull()
    expect(msg!.id).toBe('abc')
    expect(msg!.userId).toBe('42')
    expect(msg!.bits).toBe(500)
    expect(msg!.message).toBe('cheer100')
  })

  it('nulls userId/bits when the tags are absent', () => {
    const msg = parseIrcLine('@id=x;tmi-sent-ts=0 :u!u@u PRIVMSG #c :hi')
    expect(msg!.userId).toBeNull()
    expect(msg!.bits).toBeNull()
  })
})

describe('parseIrcEvent USERNOTICE', () => {
  function usernotice(tags: string, trailing = ''): string {
    const body = trailing ? ' :' + trailing : ''
    return `@${tags} :tmi.twitch.tv USERNOTICE #channel${body}`
  }

  it.each([
    ['sub', 'sub'],
    ['resub', 'resub'],
    ['subgift', 'subgift'],
    ['submysterygift', 'submysterygift'],
    ['giftpaidupgrade', 'giftpaidupgrade'],
    ['anonsubgift', 'anonsubgift'],
    ['raid', 'raid'],
    ['unraid', 'unraid'],
    ['announcement', 'announcement'],
    ['viewermilestone', 'viewermilestone'],
    ['bitsbadgetier', 'bitsbadgetier'],
  ])('parses the known msg-id %s', (msgId) => {
    const ev = parseIrcEvent(usernotice(`msg-id=${msgId};system-msg=Hello;login=u`))
    expect(ev?.type).toBe('USERNOTICE')
    if (ev?.type === 'USERNOTICE') {
      expect(ev.msgId).toBe(msgId)
      expect(ev.systemMsg).toBe('Hello')
      expect(ev.login).toBe('u')
      expect(ev.channel).toBe('channel')
    }
  })

  it('handles an unknown msg-id generically rather than dropping it', () => {
    const ev = parseIrcEvent(usernotice('msg-id=some-future-event-id;system-msg='))
    expect(ev?.type).toBe('USERNOTICE')
    if (ev?.type === 'USERNOTICE') {
      expect(ev.msgId).toBe('some-future-event-id')
      // system-msg absent -> composer fallback must produce a non-empty line
      expect(composeUsernoticeFallback(ev.msgId, ev.tags)).not.toBe('')
      expect(composeUsernoticeFallback(ev.msgId, ev.tags)).toContain('some-future-event-id')
    }
  })

  it('captures the trailing user message (resub comment)', () => {
    const ev = parseIrcEvent(usernotice('msg-id=resub;system-msg=Subbed', 'Thanks for the stream!'))
    if (ev?.type === 'USERNOTICE') {
      expect(ev.message).toBe('Thanks for the stream!')
    }
  })

  it('null message when USERNOTICE carries no trailing param', () => {
    const ev = parseIrcEvent(usernotice('msg-id=sub;system-msg=Subbed'))
    if (ev?.type === 'USERNOTICE') expect(ev.message).toBeNull()
  })

  it('IRCv3-unescapes the system-msg (prerequisite coverage)', () => {
    // `\s` -> space; without unescaping the system line is unreadable.
    const ev = parseIrcEvent(usernotice('msg-id=raid;system-msg=alice\\sis\\sraiding'))
    if (ev?.type === 'USERNOTICE') expect(ev.systemMsg).toBe('alice is raiding')
  })

  it('composeUsernoticeFallback renders each known msg-id and a generic unknown', () => {
    expect(composeUsernoticeFallback('raid', { login: 'alice', 'msg-param-viewerCount': '50' })).toBe(
      'alice is raiding with a party of 50',
    )
    expect(composeUsernoticeFallback('sub', { login: 'bob' })).toBe('bob subscribed')
    expect(composeUsernoticeFallback('subgift', { login: 'g', 'msg-param-recipient-display-name': 'R' })).toBe(
      'g gifted a sub to R',
    )
    expect(composeUsernoticeFallback('announcement', { login: 'x' })).toBe('x sent an announcement')
    expect(composeUsernoticeFallback('brand-new-id', {})).toBe('Channel event: brand-new-id')
  })
})

describe('notice categories (granular USERNOTICE toggles)', () => {
  it('subs and resubs share ONE category', () => {
    expect(usernoticeCategory('sub')).toBe('sub')
    expect(usernoticeCategory('resub')).toBe('sub')
  })

  it('the gift chain (gifted / anon / community / upgrade) is the gift category', () => {
    expect(usernoticeCategory('subgift')).toBe('gift')
    expect(usernoticeCategory('anonsubgift')).toBe('gift')
    expect(usernoticeCategory('submysterygift')).toBe('gift')
    expect(usernoticeCategory('giftpaidupgrade')).toBe('gift')
  })

  it('raid + unraid are raids; announcement is its own category', () => {
    expect(usernoticeCategory('raid')).toBe('raid')
    expect(usernoticeCategory('unraid')).toBe('raid')
    expect(usernoticeCategory('announcement')).toBe('announcement')
  })

  it('exotic and unknown ids land in other', () => {
    expect(usernoticeCategory('bitsbadgetier')).toBe('other')
    expect(usernoticeCategory('viewermilestone')).toBe('other')
    expect(usernoticeCategory('brand-new-id')).toBe('other')
    expect(usernoticeCategory('')).toBe('other')
  })

  it('each named category follows exactly its own toggle', () => {
    const none = { sub: false, gift: false, raid: false, announcement: false }
    expect(isNoticeVisible('sub', { ...none, sub: true })).toBe(true)
    expect(isNoticeVisible('sub', { ...none, gift: true })).toBe(false)
    expect(isNoticeVisible('gift', { ...none, gift: true })).toBe(true)
    expect(isNoticeVisible('raid', { ...none, raid: true })).toBe(true)
    expect(isNoticeVisible('announcement', { ...none, announcement: true })).toBe(true)
  })

  it('other (unknown ids) shows when ANY toggle is on — never dropped while the group is enabled', () => {
    const none = { sub: false, gift: false, raid: false, announcement: false }
    expect(isNoticeVisible('other', none)).toBe(false)
    expect(isNoticeVisible('other', { ...none, raid: true })).toBe(true)
    expect(isNoticeVisible('other', { ...none, announcement: true })).toBe(true)
  })
})

describe('parseIrcEvent ROOMSTATE + mergeRoomState', () => {
  function roomstate(tags: string): string {
    return `@${tags} :tmi.twitch.tv ROOMSTATE #channel`
  }

  it('the JOIN message carries ALL tags', () => {
    const ev = parseIrcEvent(
      roomstate('emote-only=0;followers-only=-1;subs-only=1;slow=0;r9k=0;room-id=1'),
    )
    if (ev?.type === 'ROOMSTATE') {
      expect(ev.emoteOnly).toBe(false)
      expect(ev.followersOnly).toBe(-1)
      expect(ev.subsOnly).toBe(true)
      expect(ev.slow).toBe(0)
      expect(ev.r9k).toBe(false)
    }
  })

  it('a CHANGE message carries ONLY the changed tag (others null)', () => {
    const ev = parseIrcEvent(roomstate('slow=30;room-id=1'))
    if (ev?.type === 'ROOMSTATE') {
      expect(ev.slow).toBe(30)
      expect(ev.emoteOnly).toBeNull()
      expect(ev.followersOnly).toBeNull()
      expect(ev.subsOnly).toBeNull()
      expect(ev.r9k).toBeNull()
    }
  })

  it('mergeRoomState merges partial updates without resetting other modes', () => {
    const join: RoomstateEvent = {
      type: 'ROOMSTATE',
      channel: 'c',
      emoteOnly: false,
      followersOnly: -1,
      subsOnly: true,
      slow: 0,
      r9k: false,
    }
    const state: RoomState = mergeRoomState({}, join)
    expect(state).toEqual({ emoteOnly: false, followersOnly: -1, subsOnly: true, slow: 0, r9k: false })

    // Only slow changed — every other mode MUST survive.
    const change: RoomstateEvent = {
      type: 'ROOMSTATE',
      channel: 'c',
      emoteOnly: null,
      followersOnly: null,
      subsOnly: null,
      slow: 30,
      r9k: null,
    }
    const next = mergeRoomState(state, change)
    expect(next).toEqual({ emoteOnly: false, followersOnly: -1, subsOnly: true, slow: 30, r9k: false })
  })

  it('followers-only 0 means "any follower", not off', () => {
    const ev = parseIrcEvent(roomstate('followers-only=0'))
    if (ev?.type === 'ROOMSTATE') expect(ev.followersOnly).toBe(0)
  })
})

describe('activeRoomModes (chat-mode pill)', () => {
  it('lists every active mode in display order', () => {
    const rs: RoomState = {
      subsOnly: true,
      followersOnly: 30,
      slow: 5,
      emoteOnly: true,
      r9k: true,
    }
    expect(activeRoomModes(rs)).toEqual(['subsOnly', 'followersOnly', 'slow', 'emoteOnly', 'r9k'])
  })

  it('excludes off values: followers-only -1, slow 0, false booleans, absent fields', () => {
    const rs: RoomState = {
      emoteOnly: false,
      followersOnly: -1,
      subsOnly: false,
      slow: 0,
      r9k: false,
    }
    expect(activeRoomModes(rs)).toEqual([])
  })

  it('followers-only 0 counts as active (any follower)', () => {
    expect(activeRoomModes({ followersOnly: 0 })).toEqual(['followersOnly'])
  })

  it('a subset renders in the same fixed order regardless of merge history', () => {
    // r9k arrived first, emote-only later — display order stays subs → …
    let rs: RoomState = { r9k: true }
    rs = mergeRoomState(rs, { type: 'ROOMSTATE', channel: 'c', emoteOnly: true, followersOnly: null, subsOnly: null, slow: null, r9k: null })
    rs = mergeRoomState(rs, { type: 'ROOMSTATE', channel: 'c', emoteOnly: null, followersOnly: null, subsOnly: true, slow: null, r9k: null })
    expect(activeRoomModes(rs)).toEqual(['subsOnly', 'emoteOnly', 'r9k'])
  })
})

describe('parseIrcEvent CLEARMSG (single-message delete)', () => {
  it('exposes target-msg-id + login', () => {
    const ev = parseIrcEvent(
      '@target-msg-id=abc-123;login=mod :tmi.twitch.tv CLEARMSG #channel :original text here',
    )
    if (ev?.type === 'CLEARMSG') {
      expect(ev.targetMsgId).toBe('abc-123')
      expect(ev.login).toBe('mod')
      expect(ev.channel).toBe('channel')
    }
  })

  it('joins to a PRIVMSG by tags.id (the existing key)', () => {
    const priv = parseIrcLine('@id=abc-123;tmi-sent-ts=0 :u!u@u PRIVMSG #channel :hello')
    const clr = parseIrcEvent('@target-msg-id=abc-123 :tmi.twitch.tv CLEARMSG #channel :hello')
    expect(priv!.id).toBe('abc-123')
    if (clr?.type === 'CLEARMSG') expect(clr.targetMsgId).toBe(priv!.id)
  })
})

describe('parseIrcEvent CLEARCHAT (timeout / ban / room-wide)', () => {
  it('timeout: target user-id + ban-duration', () => {
    const ev = parseIrcEvent(
      '@ban-duration=600;target-user-id=42 :tmi.twitch.tv CLEARCHAT #channel :bob',
    )
    if (ev?.type === 'CLEARCHAT') {
      expect(ev.targetUserId).toBe('42')
      expect(ev.banDuration).toBe(600)
      expect(ev.login).toBe('bob')
    }
  })

  it('permanent ban: target user-id, no ban-duration', () => {
    const ev = parseIrcEvent('@target-user-id=42 :tmi.twitch.tv CLEARCHAT #channel :bob')
    if (ev?.type === 'CLEARCHAT') {
      expect(ev.targetUserId).toBe('42')
      expect(ev.banDuration).toBeNull()
    }
  })

  it('room-wide clear: no target user-id, no trailing user', () => {
    const ev = parseIrcEvent(':tmi.twitch.tv CLEARCHAT #channel')
    if (ev?.type === 'CLEARCHAT') {
      expect(ev.targetUserId).toBeNull()
      expect(ev.banDuration).toBeNull()
      expect(ev.login).toBeNull()
    }
  })

  it('matches PRIVMSG by user-id (the tag CLEARCHAT keys on), never by name', () => {
    const priv = parseIrcLine('@id=x;user-id=42;tmi-sent-ts=0 :bob!bob@bob PRIVMSG #channel :hi')
    const ban = parseIrcEvent('@target-user-id=42 :tmi.twitch.tv CLEARCHAT #channel :bob')
    if (ban?.type === 'CLEARCHAT') expect(ban.targetUserId).toBe(priv!.userId)
  })
})

describe('PRIVMSG bits (Toggle D)', () => {
  it('parses the bits amount on a cheer', () => {
    const ev = parseIrcEvent(
      '@id=x;bits=1500;user-id=9;display-name=Cheer;tmi-sent-ts=0 :c!c@c PRIVMSG #channel :cheer1500 wow',
    )
    if (ev?.type === 'PRIVMSG') {
      expect(ev.bits).toBe(1500)
      expect(ev.userId).toBe('9')
      expect(ev.message).toBe('cheer1500 wow')
    }
  })

  it('a normal message has bits null', () => {
    const ev = parseIrcEvent('@id=y;tmi-sent-ts=0 :u!u@u PRIVMSG #channel :hi')
    if (ev?.type === 'PRIVMSG') expect(ev.bits).toBeNull()
  })
})

describe('moderation presentation predicate (Toggle C, retroactive)', () => {
  // The deletion is ALWAYS stored on the message (parsing is ungated). The
  // predicate keys presentation off the setting — so flipping the toggle on
  // mid-stream immediately strikes messages deleted earlier in the session.
  it('hides a deleted message when the toggle is off', () => {
    expect(isMessageStricken(false, true)).toBe(false)
  })

  it('shows a deleted message (struck through) only when the toggle is on', () => {
    expect(isMessageStricken(true, true)).toBe(true)
    expect(isMessageStricken(true, false)).toBe(false)
  })

  it('a non-deleted message is never stricken regardless of the toggle', () => {
    expect(isMessageStricken(true, false)).toBe(false)
    expect(isMessageStricken(false, false)).toBe(false)
  })
})

/*
 * Badge resolution (parseBadges via parseIrcLine on the PRIVMSG `badges` tag).
 * Each badge must resolve to a static-cdn URL of the form
 *   https://static-cdn.jtvnw.net/badges/v1/<uuid>/1
 * where <uuid> is the version-specific image UUID and the trailing segment is
 * the image SIZE index (1 = 18px NORMAL), not the IRC version. Unknown ids are
 * dropped silently (badgeUrl returns null), so they never produce a broken img.
 */
describe('parseBadges (global chat badges via PRIVMSG badges tag)', () => {
  function badgesOf(badgesTag: string) {
    const msg = parseIrcLine(
      `@badges=${badgesTag};display-name=X;id=b;tmi-sent-ts=0 :x!x@x PRIVMSG #c :hi`,
    )
    return msg!.badges
  }

  it('resolves a newly added single-version badge to its CDN URL', () => {
    const b = badgesOf('lead_moderator/1')
    expect(b).toHaveLength(1)
    expect(b[0].id).toBe('lead_moderator')
    expect(b[0].version).toBe('1')
    expect(b[0].label).toBe('Lead Moderator')
    expect(b[0].imageUrl).toBe(
      'https://static-cdn.jtvnw.net/badges/v1/0822047b-65e0-46f2-94a9-d1091d685d33/1',
    )
  })

  it('picks the correct per-version UUID for a versioned badge (numeric version)', () => {
    const b = badgesOf('moments/5')
    expect(b).toHaveLength(1)
    // version 5 carries its own UUID, distinct from the tier-1 default
    expect(b[0].imageUrl).toBe(
      'https://static-cdn.jtvnw.net/badges/v1/c8a0d95a-856e-4097-9fc0-7765300a4f58/1',
    )
    expect(b[0].label).toBe('Moments Badge - Tier 5')
  })

  it('picks the correct per-version UUID for a versioned badge (color-version key)', () => {
    const b = badgesOf('predictions/blue-3')
    expect(b).toHaveLength(1)
    expect(b[0].imageUrl).toBe(
      'https://static-cdn.jtvnw.net/badges/v1/f2ab9a19-8ef7-4f9f-bd5d-9cf4e603f845/1',
    )
    expect(b[0].label).toBe('Predicted Blue (3)')
  })

  it('drops an unknown badge id cleanly (fallback must not regress)', () => {
    expect(badgesOf('totally-fake-badge/1')).toHaveLength(0)
    // A known badge alongside an unknown one survives; the unknown is skipped.
    const b = badgesOf('lead_moderator/1,totally-fake-badge/1,broadcaster/1')
    expect(b.map((x) => x.id)).toEqual(['lead_moderator', 'broadcaster'])
  })

  it('a version absent from perVersion falls back to the default UUID + base label', () => {
    const b = badgesOf('moments/999')
    expect(b).toHaveLength(1)
    expect(b[0].imageUrl).toBe(
      'https://static-cdn.jtvnw.net/badges/v1/bf370830-d79a-497b-81c6-a365b2b60dda/1',
    )
    expect(b[0].label).toBe('Moments')
  })

  it('keeps an existing version-1 badge URL byte-identical (behavior-preserving)', () => {
    const b = badgesOf('broadcaster/1')
    expect(b[0].imageUrl).toBe(
      'https://static-cdn.jtvnw.net/badges/v1/5527c58c-fb7d-422d-b71b-f309dcb85cc1/1',
    )
  })

  it('resolves an existing versioned badge to a valid size-1 URL (bits/100 fix)', () => {
    const b = badgesOf('bits/100')
    expect(b).toHaveLength(1)
    // The per-version UUID is selected; the trailing segment is the size (1),
    // not the IRC version (100) — which previously produced a 404.
    expect(b[0].imageUrl).toBe(
      'https://static-cdn.jtvnw.net/badges/v1/09d93036-e7ce-431c-9a9e-7044297133f2/1',
    )
    expect(b[0].label).toBe('100 bits')
  })
})

/*
 * PHASE 2 — the global badge map is mutable: a cached/refreshed map installed
 * via setGlobalBadges is what parseBadges resolves against. These tests mutate
 * that module state, so afterEach restores the shipped baseline to keep the
 * rest of the suite (and other files' view of the module) intact.
 */
describe('global badge map swap (cached map beats baseline)', () => {
  function badgesOf(badgesTag: string) {
    const msg = parseIrcLine(
      `@badges=${badgesTag};display-name=X;id=b;tmi-sent-ts=0 :x!x@x PRIVMSG #c :hi`,
    )
    return msg!.badges
  }
  afterEach(() => {
    setGlobalBadges(BASELINE_BADGES)
  })

  it('a cached/refreshed map overrides the baseline UUID', () => {
    setGlobalBadges({
      broadcaster: { label: 'Host', uuid: '11111111-1111-1111-1111-111111111111' },
    })
    const b = badgesOf('broadcaster/1')
    expect(b).toHaveLength(1)
    expect(b[0].imageUrl).toBe(
      'https://static-cdn.jtvnw.net/badges/v1/11111111-1111-1111-1111-111111111111/1',
    )
  })

  it('an empty cached map drops every badge (degrades gracefully, no throw)', () => {
    setGlobalBadges({})
    expect(badgesOf('broadcaster/1,subscriber/12,bits/100')).toHaveLength(0)
  })

  it('a per-version UUID in a swapped map is selected by version', () => {
    setGlobalBadges({
      bits: {
        label: 'Bits',
        uuid: '00000000-0000-0000-0000-000000000001',
        perVersion: { '100': '22222222-2222-2222-2222-222222222222' },
      },
    })
    const b = badgesOf('bits/100')
    expect(b[0].imageUrl).toBe(
      'https://static-cdn.jtvnw.net/badges/v1/22222222-2222-2222-2222-222222222222/1',
    )
  })
})

/*
 * PHASE 3 — per-channel custom badge art. resolveBadgeImageUrl applies a
 * channel's broadcastBadges override on top of the parse-time global
 * resolution. It is a PURE function called per-badge at render against a
 * reactive override, so when the per-channel fetch lands, every buffered
 * message (parsed before it completed) re-resolves to the custom art.
 */
describe('per-channel badge override (resolveBadgeImageUrl)', () => {
  // A message parsed against the global map carries the global default art.
  const subBadge = { id: 'subscriber', version: '12', imageUrl: 'https://static-cdn.jtvnw.net/badges/v1/GLOBAL-SUB-UUID/1' }
  const founderBadge = { id: 'founder', version: '0', imageUrl: 'https://static-cdn.jtvnw.net/badges/v1/GLOBAL-FOUNDER-UUID/1' }
  // A channel's custom art (from User.broadcastBadges).
  const channelOverride = {
    subscriber: { '12': 'cccccccc-cccc-cccc-cccc-cccccccccccc' },
    founder: { '0': 'ffffffff-ffff-ffff-ffff-ffffffffffff' },
  }

  it('override beats the global default image', () => {
    expect(resolveBadgeImageUrl(subBadge, channelOverride)).toBe(
      'https://static-cdn.jtvnw.net/badges/v1/cccccccc-cccc-cccc-cccc-cccccccccccc/1',
    )
  })

  it('null override (before fetch / after channel change) falls back to global', () => {
    expect(resolveBadgeImageUrl(subBadge, null)).toBe(subBadge.imageUrl)
  })

  it('override for a different setID does not affect this badge', () => {
    expect(resolveBadgeImageUrl(subBadge, { founder: { '0': 'ffffffff-ffff-ffff-ffff-ffffffffffff' } })).toBe(
      subBadge.imageUrl,
    )
  })

  it('override for a different version does not affect this badge', () => {
    expect(resolveBadgeImageUrl(subBadge, { subscriber: { '6': 'dddddddd-dddd-dddd-dddd-dddddddddddd' } })).toBe(
      subBadge.imageUrl,
    )
  })

  it('founder custom art is covered (not just subscriber)', () => {
    expect(resolveBadgeImageUrl(founderBadge, channelOverride)).toBe(
      'https://static-cdn.jtvnw.net/badges/v1/ffffffff-ffff-ffff-ffff-ffffffffffff/1',
    )
  })

  it('the SAME buffered badge resolves differently before vs after the override lands', () => {
    // Simulates a message parsed before the channel badge fetch completed:
    // before the override arrives it shows the global default; after, custom.
    expect(resolveBadgeImageUrl(subBadge, null)).toBe(subBadge.imageUrl)
    expect(resolveBadgeImageUrl(subBadge, channelOverride)).toBe(
      'https://static-cdn.jtvnw.net/badges/v1/cccccccc-cccc-cccc-cccc-cccccccccccc/1',
    )
  })

  it('a badge with no global URL still drops when no override applies', () => {
    expect(resolveBadgeImageUrl({ id: 'subscriber', version: '12', imageUrl: null }, null)).toBeNull()
  })
})
