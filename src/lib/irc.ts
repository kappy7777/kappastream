import type { EmoteRange } from './emotes'
import { parseTwitchEmoteTag } from './emotes'

export interface ParsedMessage {
  id: string
  channel: string
  username: string
  displayName: string
  color: string
  message: string
  rawColor: string | null
  isAction: boolean
  twitchEmotes: EmoteRange[]
  badges: BadgeInfo[]
  timestamp: number
  // `user-id` tag — the stable join key CLEARCHAT matches on (never a display
  // name, which can change). Null only if Twitch omits the tag (it never does
  // on a tagged PRIVMSG).
  userId: string | null
  // `bits` tag amount for cheers (Tier 2 section 6). Null on a normal message.
  bits: number | null
}

const ACTION_PREFIX = '\u0001ACTION '

// ---------------------------------------------------------------------------
// Tier 2 chat completeness — event parsing.
//
// `parseIrcLine` below still returns ONLY PRIVMSG (back-compat: the existing
// tests and the baseline chat path call it). `parseIrcEvent` is the new entry
// point that also surfaces USERNOTICE / ROOMSTATE / CLEARMSG / CLEARCHAT. It
// shares the exact same PRIVMSG builder, so PRIVMSG output is byte-identical
// to the legacy function (plus the two new nullable fields). The baseline
// chat (all toggles off) never calls into the new render paths.
//
// Per the architecture rule, PARSING IS UNGATED: every supported event is
// parsed and stored by the caller regardless of settings; only PRESENTATION is
// gated. See App.svelte.
// ---------------------------------------------------------------------------

export type IrcEvent =
  | (ParsedMessage & { type: 'PRIVMSG' })
  | UsernoticeEvent
  | RoomstateEvent
  | ClearmsgEvent
  | ClearchatEvent

export interface UsernoticeEvent {
  type: 'USERNOTICE'
  channel: string
  // `msg-id` selects the event kind (sub, raid, …). Unknown ids are surfaced
  // generically rather than dropped — Twitch adds new ones.
  msgId: string
  // Twitch's own rendered string (the `system-msg` tag, IRCv3-unescaped). The
  // preferred display text; we only fall back to msg-param composition when it
  // is empty.
  systemMsg: string
  // `login` of the acting user, if present.
  login: string | null
  // All decoded tags — passed to composeUsernoticeFallback for the rare case
  // system-msg is absent, and so the render layer can read msg-param-* values.
  tags: Record<string, string>
  // Trailing parameter: the user's message (resub comments, announcements).
  // Null when the USERNOTICE carries no message.
  message: string | null
  // Raw `emotes` tag for the trailing message (parsed by the caller).
  emotes: string | undefined
}

export interface RoomstateEvent {
  type: 'ROOMSTATE'
  channel: string
  // Each field is null when the tag is ABSENT from this message. The JOIN
  // message carries ALL tags; later change messages carry ONLY the changed
  // tag. Callers must merge (mergeRoomState), never replace — null means
  // "leave the existing value alone".
  emoteOnly: boolean | null
  // -1 = off, 0 = any follower, N = must follow for N minutes.
  followersOnly: number | null
  subsOnly: boolean | null
  // Seconds (0 = off).
  slow: number | null
  r9k: boolean | null
}

export interface ClearmsgEvent {
  type: 'CLEARMSG'
  channel: string
  // `target-msg-id` — matches ParsedMessage.id of the deleted PRIVMSG.
  targetMsgId: string
  // `login` of the moderator who deleted it.
  login: string
}

export interface ClearchatEvent {
  type: 'CLEARCHAT'
  channel: string
  // `target-user-id` tag. Null => whole room cleared.
  targetUserId: string | null
  // `ban-duration` tag. Null => permanent ban (or room-wide clear).
  banDuration: number | null
  // Trailing parameter: the target's login, if a single user was targeted.
  login: string | null
}

interface IrcFrame {
  tags: Record<string, string>
  prefixText: string | null
  command: string
  channel: string | null
  middle: string[]
  trailing: string | null
}

export function parseIrcEvent(line: string): IrcEvent | null {
  const frame = tokenize(line)
  if (!frame) return null
  switch (frame.command) {
    case 'PRIVMSG':
      return buildPrivmsg(frame)
    case 'USERNOTICE':
      return buildUsernotice(frame)
    case 'ROOMSTATE':
      return buildRoomstate(frame)
    case 'CLEARMSG':
      return buildClearmsg(frame)
    case 'CLEARCHAT':
      return buildClearchat(frame)
    default:
      return null
  }
}

function tokenize(line: string): IrcFrame | null {
  if (!line || !line.startsWith('@')) return null

  const spaceIdx = line.indexOf(' ')
  if (spaceIdx === -1) return null

  const tagsPart = line.slice(1, spaceIdx)
  const rest = line.slice(spaceIdx + 1)

  let prefixText: string | null = null
  let s = rest
  if (s.startsWith(':')) {
    const prefixEnd = s.indexOf(' ')
    if (prefixEnd === -1) return null
    prefixText = s.slice(1, prefixEnd)
    s = s.slice(prefixEnd + 1)
  }

  const cmdSpace = s.indexOf(' ')
  const command = cmdSpace === -1 ? s : s.slice(0, cmdSpace)
  const afterCommand = cmdSpace === -1 ? '' : s.slice(cmdSpace + 1)

  const { middle, trailing } = splitParams(afterCommand)
  const tags = parseTags(tagsPart)

  let channel: string | null = null
  if (middle.length > 0) channel = middle[0].replace(/^#/, '').toLowerCase()

  return { tags, prefixText, command, channel, middle, trailing }
}

// Split IRC params into the leading "middle" tokens and the optional trailing
// parameter (the part after the first " :", per the IRC framing convention
// the legacy PRIVMSG parser already relied on).
function splitParams(src: string): { middle: string[]; trailing: string | null } {
  const idx = src.indexOf(' :')
  if (idx === -1) return { middle: src.split(' ').filter(Boolean), trailing: null }
  const middlePart = src.slice(0, idx)
  const trailing = src.slice(idx + 2)
  return { middle: middlePart.split(' ').filter(Boolean), trailing }
}

function buildPrivmsg(frame: IrcFrame): (ParsedMessage & { type: 'PRIVMSG' }) | null {
  const messageBody = frame.trailing
  if (messageBody === null) return null

  let username = 'user'
  if (frame.prefixText !== null) {
    const prefixText = frame.prefixText
    const bang = prefixText.indexOf('!')
    username = bang === -1 ? prefixText.toLowerCase() : prefixText.slice(0, bang).toLowerCase()
  }

  const tags = frame.tags
  const displayName = tags['display-name'] || username || 'user'
  const color = normalizeColor(tags.color)
  const id = tags.id ?? ''
  const twitchEmotes = parseTwitchEmoteTag(tags.emotes, messageBody)

  let text = messageBody
  let isAction = false
  if (text.startsWith(ACTION_PREFIX) && text.endsWith('\u0001')) {
    isAction = true
    text = text.slice(ACTION_PREFIX.length, -1)
  }

  return {
    type: 'PRIVMSG',
    id,
    channel: frame.channel ?? '',
    username,
    displayName,
    color,
    message: text,
    rawColor: tags.color ?? null,
    isAction,
    twitchEmotes,
    badges: parseBadges(tags.badges ? tags.badges.split(',').filter(Boolean) : []),
    timestamp: tags['tmi-sent-ts'] ? Number(tags['tmi-sent-ts']) : Date.now(),
    userId: tags['user-id'] ?? null,
    bits: tags.bits ? Number(tags.bits) : null,
  }
}

function buildUsernotice(frame: IrcFrame): UsernoticeEvent {
  const tags = frame.tags
  return {
    type: 'USERNOTICE',
    channel: frame.channel ?? '',
    msgId: tags['msg-id'] ?? '',
    systemMsg: tags['system-msg'] ?? '',
    login: tags.login ?? null,
    tags,
    message: frame.trailing ?? null,
    emotes: tags.emotes,
  }
}

function buildRoomstate(frame: IrcFrame): RoomstateEvent {
  const t = frame.tags
  return {
    type: 'ROOMSTATE',
    channel: frame.channel ?? '',
    emoteOnly: hasTag(t, 'emote-only') ? t['emote-only'] === '1' : null,
    followersOnly: hasTag(t, 'followers-only') ? Number(t['followers-only']) : null,
    subsOnly: hasTag(t, 'subs-only') ? t['subs-only'] === '1' : null,
    slow: hasTag(t, 'slow') ? Number(t['slow']) : null,
    r9k: hasTag(t, 'r9k') ? t['r9k'] === '1' : null,
  }
}

function buildClearmsg(frame: IrcFrame): ClearmsgEvent {
  const t = frame.tags
  return {
    type: 'CLEARMSG',
    channel: frame.channel ?? '',
    targetMsgId: t['target-msg-id'] ?? '',
    login: t.login ?? '',
  }
}

function buildClearchat(frame: IrcFrame): ClearchatEvent {
  const t = frame.tags
  return {
    type: 'CLEARCHAT',
    channel: frame.channel ?? '',
    targetUserId: hasTag(t, 'target-user-id') ? t['target-user-id'] : null,
    banDuration: hasTag(t, 'ban-duration') ? Number(t['ban-duration']) : null,
    login: frame.trailing ?? null,
  }
}

// A tag key is "present" only if it appeared in the raw tag string. parseTags
// stores every parsed key (even with an empty value), so a direct lookup
// distinguishes "absent" (later change message) from "present but empty".
function hasTag(tags: Record<string, string>, key: string): boolean {
  return key in tags
}

// Merge a ROOMSTATE event into accumulated state. Only non-null fields
// overwrite — a null field means "this message did not carry that tag", so the
// previous value is preserved. Critical: the JOIN message carries every tag,
// but each subsequent change message carries only the one that changed. A naive
// replace silently resets the other chat modes.
export interface RoomState {
  emoteOnly?: boolean
  followersOnly?: number
  subsOnly?: boolean
  slow?: number
  r9k?: boolean
}

export function mergeRoomState(prev: RoomState, ev: RoomstateEvent): RoomState {
  const next: RoomState = { ...prev }
  if (ev.emoteOnly !== null) next.emoteOnly = ev.emoteOnly
  if (ev.followersOnly !== null) next.followersOnly = ev.followersOnly
  if (ev.subsOnly !== null) next.subsOnly = ev.subsOnly
  if (ev.slow !== null) next.slow = ev.slow
  if (ev.r9k !== null) next.r9k = ev.r9k
  return next
}

// Compose a display line from msg-param-* only when Twitch did not send a
// usable system-msg. In practice system-msg is always present; this is the
// safety net so an absent system-msg never renders a blank line. Handles the
// known msg-ids explicitly and any future/unknown id generically.
export function composeUsernoticeFallback(msgId: string, tags: Record<string, string>): string {
  const login = tags.login || tags['display-name'] || 'Someone'
  switch (msgId) {
    case 'raid': {
      const viewers = tags['msg-param-viewerCount'] ?? '?'
      return `${login} is raiding with a party of ${viewers}`
    }
    case 'sub':
    case 'resub':
      return `${login} subscribed`
    case 'subgift':
    case 'anonsubgift': {
      const recipient =
        tags['msg-param-recipient-display-name'] || tags['msg-param-recipient-user-name'] || 'someone'
      return `${login} gifted a sub to ${recipient}`
    }
    case 'submysterygift':
      return `${login} is gifting community subs`
    case 'giftpaidupgrade':
      return `${login} is continuing the gift they received`
    case 'announcement':
      return `${login} sent an announcement`
    case 'bitsbadgetier':
      return `${login} earned a new bits badge tier`
    case 'viewermilestone':
      return `${login} reached a viewer milestone`
    case 'unraid':
      return 'The raid was cancelled'
    default:
      // Unknown msg-id — do not drop it. Twitch ships new ids over time.
      return msgId ? `Channel event: ${msgId}` : 'Channel event'
  }
}

// Single source of truth for how a deleted/timed-out message is PRESENTED.
// Today it is strikethrough with the original text left visible. Tradeoff:
// this still shows content a moderator removed — an explicit product choice.
// Centralising the decision here (one predicate, one CSS class —
// DELETED_MESSAGE_CLASS) means a future "collapsed placeholder" presentation
// can swap the implementation without touching the render path.
export const DELETED_MESSAGE_CLASS = 'message--deleted'

export function isMessageStricken(showModeration: boolean, deleted: boolean): boolean {
  return showModeration && deleted
}

// Legacy PRIVMSG-only entry point. Kept for the existing tests and any caller
// that wants only chat messages. Non-PRIVMSG events return null, exactly as
// before — the baseline chat path is unchanged.
export function parseIrcLine(line: string): ParsedMessage | null {
  const ev = parseIrcEvent(line)
  return ev && ev.type === 'PRIVMSG' ? ev : null
}

function parseTags(raw: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const part of raw.split(';')) {
    if (!part) continue
    const eq = part.indexOf('=')
    if (eq === -1) {
      out[part] = ''
    } else {
      out[part.slice(0, eq)] = decodeTagValue(part.slice(eq + 1))
    }
  }
  return out
}

function decodeTagValue(v: string): string {
  // IRCv3 escape decode, single pass. The previous sequential .replace()
  // chain reordered `\\` → `\` before `\\s` could be matched, so raw
  // `a\\sb` mis-decoded to `a\ b` instead of `a\sb`. Mapping the escape
  // char in one regex pass over the input fixes the ordering and drops
  // the backslash for any unknown escape (per the IRCv3 spec).
  return v.replace(/\\(.)/g, (_, c) =>
    ({ s: ' ', n: '\n', r: '\r', ':': ';', '\\': '\\' } as Record<string, string>)[c] ?? c)
}

function normalizeColor(c: string | undefined): string {
  if (!c) return '#ffffff'
  return /^#[0-9a-fA-F]{6}$/.test(c) ? c : '#ffffff'
}

export interface BadgeInfo {
  id: string
  version: string
  label: string
  imageUrl: string | null
}

interface BadgeMeta {
  label: string
  uuid: string
  perVersion?: Record<string, string>
  perVersionLabel?: Record<string, string>
}

const BADGE_META: Record<string, BadgeMeta> = {
  // Channel roles
  broadcaster: { label: 'Host', uuid: '5527c58c-fb7d-422d-b71b-f309dcb85cc1' },
  moderator: { label: 'Mod', uuid: '3267646d-33f0-4b17-b3df-f923a41db1d0' },
  vip: { label: 'VIP', uuid: 'b817aba4-fad8-49e2-b88a-7cc744dfa6ec' },
  artist: { label: 'Artist', uuid: '4300a897-03dc-4e83-8c0e-c332fee7057f' },
  'artist-badge': { label: 'Artist', uuid: '4300a897-03dc-4e83-8c0e-c332fee7057f' },
  // Subscriber tiers
  subscriber: { label: 'Sub', uuid: '5d9f2208-5dd8-11e7-8513-2ff4adfae661' },
  founder: { label: 'Founder', uuid: '511b78a9-ab37-472f-9569-457753bbe7d3' },
  // Twitch staff
  staff: { label: 'Staff', uuid: 'd97c37bd-a6f5-4c38-8f57-4e4bef88af34' },
  admin: { label: 'Admin', uuid: '9ef7e029-4cdf-4d4d-a0d5-e2b3fb2583fe' },
  partner: { label: 'Verified', uuid: 'd12a2e27-16f6-41d0-ab77-b780518f00a3' },
  // Premium / Turbo
  premium: { label: 'Prime', uuid: 'bbbe0db0-a598-423e-86d0-f9fb98ca1933' },
  turbo: { label: 'Turbo', uuid: 'bd444ec6-8f34-4bf9-91f4-af1e3428d80f' },
  // Bits — each version is a different visual tier
  bits: {
    label: 'Bits',
    uuid: '73b5c3fb-24f9-4a82-a852-2f475b59411c', // tier 1
    perVersion: {
      '1': '73b5c3fb-24f9-4a82-a852-2f475b59411c',
      '100': '09d93036-e7ce-431c-9a9e-7044297133f2',
      '1000': '0d85a29e-79ad-4c63-a285-3acd2c66f2ba',
      '5000': '57cd97fc-3e9e-4c6d-9d41-60147137234e',
      '10000': '68af213b-a771-4124-b6e3-9bb6d98aa732',
      '25000': '64ca5920-c663-4bd8-bfb1-751b4caea2dd',
      '50000': '62310ba7-9916-4235-9eba-40110d67f85d',
      '75000': 'ce491fa4-b24f-4f3b-b6ff-44b080202792',
      '100000': '96f0540f-aa63-49e1-a8b3-259ece3bd098',
      '200000': '4a0b90c4-e4ef-407f-84fe-36b14aebdbb6',
    },
    perVersionLabel: {
      '1': '1 bit',
      '100': '100 bits',
      '1000': '1K bits',
      '5000': '5K bits',
      '10000': '10K bits',
      '25000': '25K bits',
      '50000': '50K bits',
      '75000': '75K bits',
      '100000': '100K bits',
      '200000': '200K bits',
    },
  },
  'bits-tier': {
    label: 'Bits',
    uuid: '73b5c3fb-24f9-4a82-a852-2f475b59411c',
    perVersion: {
      '1': '73b5c3fb-24f9-4a82-a852-2f475b59411c',
      '100': '09d93036-e7ce-431c-9a9e-7044297133f2',
      '1000': '0d85a29e-79ad-4c63-a285-3acd2c66f2ba',
      '5000': '57cd97fc-3e9e-4c6d-9d41-60147137234e',
      '10000': '68af213b-a771-4124-b6e3-9bb6d98aa732',
      '25000': '64ca5920-c663-4bd8-bfb1-751b4caea2dd',
      '50000': '62310ba7-9916-4235-9eba-40110d67f85d',
      '75000': 'ce491fa4-b24f-4f3b-b6ff-44b080202792',
      '100000': '96f0540f-aa63-49e1-a8b3-259ece3bd098',
      '200000': '4a0b90c4-e4ef-407f-84fe-36b14aebdbb6',
    },
  },
  'bits-leader': {
    label: 'Bits leader',
    uuid: '73b5c3fb-24f9-4a82-a852-2f475b59411c',
    perVersion: {
      '1': '73b5c3fb-24f9-4a82-a852-2f475b59411c',
      '100': '09d93036-e7ce-431c-9a9e-7044297133f2',
      '1000': '0d85a29e-79ad-4c63-a285-3acd2c66f2ba',
      '5000': '57cd97fc-3e9e-4c6d-9d41-60147137234e',
      '10000': '68af213b-a771-4124-b6e3-9bb6d98aa732',
      '25000': '64ca5920-c663-4bd8-bfb1-751b4caea2dd',
      '50000': '62310ba7-9916-4235-9eba-40110d67f85d',
      '75000': 'ce491fa4-b24f-4f3b-b6ff-44b080202792',
      '100000': '96f0540f-aa63-49e1-a8b3-259ece3bd098',
    },
  },
  // Sub gifting — version = number of subs gifted
  'sub-gift-leader': {
    label: 'Gifter',
    uuid: 'f1d8486f-eb2e-4553-b44f-4d614617afc1', // 1 sub
    perVersion: {
      '1': 'f1d8486f-eb2e-4553-b44f-4d614617afc1',
      '5': '3e638e02-b765-4070-81bd-a73d1ae34965',
      '10': 'bffca343-9d7d-49b4-a1ca-90af2c6a1639',
      '25': '17e09e26-2528-4a04-9c7f-8518348324d1',
      '50': '47308ed4-c979-4f3f-ad20-35a8ab76d85d',
      '100': '5056c366-7299-4b3c-a15a-a18573650bfb',
      '250': 'df25dded-df81-408e-a2d3-40d48f0d529f',
      '500': 'f440decb-7468-4bf9-8666-98ba74f6eab5',
      '1000': 'b8c76744-c7e9-44be-90d0-08840a8f6e39',
    },
    perVersionLabel: {
      '1': '1 sub gifted',
      '5': '5 subs gifted',
      '10': '10 subs gifted',
      '25': '25 subs gifted',
      '50': '50 subs gifted',
      '100': '100 subs gifted',
      '250': '250 subs gifted',
      '500': '500 subs gifted',
      '1000': '1000 subs gifted',
    },
  },
  'sub-gifter': {
    label: 'Gifter',
    uuid: 'f1d8486f-eb2e-4553-b44f-4d614617afc1',
    perVersion: {
      '1': 'f1d8486f-eb2e-4553-b44f-4d614617afc1',
      '5': '3e638e02-b765-4070-81bd-a73d1ae34965',
      '10': 'bffca343-9d7d-49b4-a1ca-90af2c6a1639',
      '25': '17e09e26-2528-4a04-9c7f-8518348324d1',
      '50': '47308ed4-c979-4f3f-ad20-35a8ab76d85d',
      '100': '5056c366-7299-4b3c-a15a-a18573650bfb',
      '250': 'df25dded-df81-408e-a2d3-40d48f0d529f',
      '500': 'f440decb-7468-4bf9-8666-98ba74f6eab5',
      '1000': 'b8c76744-c7e9-44be-90d0-08840a8f6e39',
    },
  },
  // Hype Train conductor
  hype: { label: 'Hype Train', uuid: 'fae4086c-3190-44d4-83c8-8ef0cbe1a515' },
  'hype-train': { label: 'Hype Train', uuid: 'fae4086c-3190-44d4-83c8-8ef0cbe1a515' },
  // Clips leader / power clipper
  'clips-leader': { label: 'Clips leader', uuid: '12f70951-efea-48c2-b42b-d5e2ea0d71f7' },
  'clip-champ': { label: 'Power Clipper', uuid: 'f38976e0-ffc9-11e7-86d6-7f98b26a9d79' },
  // Anon / bot
  'anonymous-cheerer': { label: 'Anon', uuid: 'ca3db7f7-18f5-487e-a329-cd0b538ee979' },
  'anonymous-gifter': { label: 'Anon gifter', uuid: 'ca3db7f7-18f5-487e-a329-cd0b538ee979' },
  'bot-badge': { label: 'Bot', uuid: '3ffa9565-c35b-4cad-800b-041e60659cf2' },
  'twitchbot': { label: 'TwitchBot', uuid: '3ffa9565-c35b-4cad-800b-041e60659cf2' },
  // Accessibility
  'no_audio': { label: 'No audio', uuid: 'aef2cd08-f29b-45a1-8c12-d44d7fd5e6f0' },
  'no_video': { label: 'No video', uuid: '199a0dba-58f3-494e-a7fc-1fa0a1001fb8' },
  // Channel-specific extras that show up in IRC for some channels
  'glhf-': { label: 'GLHF', uuid: '30884d24-6a8b-4c45-89a6-1c20e5a5b9ed' },
}

function badgeUrl(id: string, version: string): string | null {
  const meta = BADGE_META[id]
  if (!meta) return null
  const uuid = (version && meta.perVersion?.[version]) || meta.uuid
  return 'https://static-cdn.jtvnw.net/badges/v1/' + uuid + '/' + (version || '1')
}

function badgeLabel(id: string, version: string): string {
  const meta = BADGE_META[id]
  if (!meta) return id
  if (version && meta.perVersionLabel?.[version]) return meta.perVersionLabel[version]
  return meta.label
}

export function parseBadges(raw: string[]): BadgeInfo[] {
  const out: BadgeInfo[] = []
  for (const entry of raw) {
    const slash = entry.indexOf('/')
    const id = slash === -1 ? entry : entry.slice(0, slash)
    const version = slash === -1 ? '1' : entry.slice(slash + 1)
    if (!id) continue
    const url = badgeUrl(id, version)
    if (!url) continue
    out.push({
      id,
      version,
      label: badgeLabel(id, version),
      imageUrl: url,
    })
  }
  return out
}
