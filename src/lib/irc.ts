import type { EmoteRange } from './emotes'
import { parseTwitchEmoteTag } from './emotes'
import { t } from './i18n/index.svelte'

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

  let username = t('irc_user')
  if (frame.prefixText !== null) {
    const prefixText = frame.prefixText
    const bang = prefixText.indexOf('!')
    username = bang === -1 ? prefixText.toLowerCase() : prefixText.slice(0, bang).toLowerCase()
  }

  const tags = frame.tags
  const displayName = tags['display-name'] || username || t('irc_user')
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
  const tags = frame.tags
  return {
    type: 'ROOMSTATE',
    channel: frame.channel ?? '',
    emoteOnly: hasTag(tags, 'emote-only') ? tags['emote-only'] === '1' : null,
    followersOnly: hasTag(tags, 'followers-only') ? Number(tags['followers-only']) : null,
    subsOnly: hasTag(tags, 'subs-only') ? tags['subs-only'] === '1' : null,
    slow: hasTag(tags, 'slow') ? Number(tags['slow']) : null,
    r9k: hasTag(tags, 'r9k') ? tags['r9k'] === '1' : null,
  }
}

function buildClearmsg(frame: IrcFrame): ClearmsgEvent {
  const tags = frame.tags
  return {
    type: 'CLEARMSG',
    channel: frame.channel ?? '',
    targetMsgId: tags['target-msg-id'] ?? '',
    login: tags.login ?? '',
  }
}

function buildClearchat(frame: IrcFrame): ClearchatEvent {
  const tags = frame.tags
  return {
    type: 'CLEARCHAT',
    channel: frame.channel ?? '',
    targetUserId: hasTag(tags, 'target-user-id') ? tags['target-user-id'] : null,
    banDuration: hasTag(tags, 'ban-duration') ? Number(tags['ban-duration']) : null,
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
  const login = tags.login || tags['display-name'] || t('irc_someone')
  switch (msgId) {
    case 'raid': {
      const viewers = tags['msg-param-viewerCount'] ?? '?'
      return t('irc_raid', { login, viewers })
    }
    case 'sub':
    case 'resub':
      return t('irc_subscribed', { login })
    case 'subgift':
    case 'anonsubgift': {
      const recipient =
        tags['msg-param-recipient-display-name'] || tags['msg-param-recipient-user-name'] || t('irc_someoneLower')
      return t('irc_giftedSub', { login, recipient })
    }
    case 'submysterygift':
      return t('irc_giftingCommunity', { login })
    case 'giftpaidupgrade':
      return t('irc_continuingGift', { login })
    case 'announcement':
      return t('irc_announcement', { login })
    case 'bitsbadgetier':
      return t('irc_bitsBadge', { login })
    case 'viewermilestone':
      return t('irc_milestone', { login })
    case 'unraid':
      return t('irc_unraid')
    default:
      // Unknown msg-id — do not drop it. Twitch ships new ids over time.
      return msgId ? t('irc_channelEvent', { msgId }) : t('irc_channelEventGeneric')
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

export function normalizeColor(c: string | undefined): string {
  if (!c) return '#ffffff'
  return /^#[0-9a-fA-F]{6}$/.test(c) ? c : '#ffffff'
}

export interface BadgeInfo {
  id: string
  version: string
  label: string
  imageUrl: string | null
}

export interface BadgeMeta {
  label: string
  uuid: string
  perVersion?: Record<string, string>
  perVersionLabel?: Record<string, string>
}

// Shipped baseline of global chat-badge image UUIDs (auto-generated by
// scripts/generate-badges.mjs from Twitch GQL `Query.badges`; every UUID was
// verified to return a real PNG). The runtime global map starts here and is
// swapped for a fresh/cached map by the weekly in-app refresh
// (src/lib/badges.svelte.ts). Resolution order for a global badge:
//   cached/refreshed global map -> THIS baseline -> drop.
// The baseline is the floor so a GQL failure or cold first run still renders
// every known badge. Per-channel custom art (subscriber/founder) is applied on
// top at RENDER time via a reactive override in App.svelte.
import { BASELINE_BADGES } from './badges.generated'

let globalBadges: Record<string, BadgeMeta> = BASELINE_BADGES

/**
 * Replace the global badge map (e.g. install a freshly fetched or cached map).
 * Messages parsed AFTER this call resolve against the new map; per-channel
 * overrides are applied separately at render time. */
export function setGlobalBadges(map: Record<string, BadgeMeta>): void {
  globalBadges = map
}

// static-cdn badge image URL for a UUID at size 1 (18px NORMAL). The trailing
// segment is the image SIZE index, NOT the IRC version (see badgeUrl).
export function badgeImageUrl(uuid: string): string {
  return 'https://static-cdn.jtvnw.net/badges/v1/' + uuid + '/1'
}

/**
 * Effective image URL for a parsed badge, applying a per-channel override on
 * top of the parse-time global resolution. The override (setID -> {version ->
 * uuid}) carries a channel's custom subscriber/founder art; when present it
 * replaces the global default image for that (setID, version). Returns the
 * badge's global imageUrl when no override applies (including null, which
 * drops the badge). Pure function — App.svelte calls it per-badge at render
 * against a REACTIVE override so buffered messages re-resolve when the channel
 * badge fetch lands.
 */
export function resolveBadgeImageUrl(
  badge: Pick<BadgeInfo, 'id' | 'version' | 'imageUrl'>,
  override: Record<string, Record<string, string>> | null,
): string | null {
  const ov = override?.[badge.id]?.[badge.version]
  return ov ? badgeImageUrl(ov) : badge.imageUrl
}

function badgeUrl(id: string, version: string): string | null {
  const meta = globalBadges[id]
  if (!meta) return null
  // The IRC badge `version` selects the per-version UUID above. The trailing
  // path segment on static-cdn is the image SIZE index (1 = 18px NORMAL,
  // 2 = 36px, 3 = 72px), NOT the version. Appending the IRC version here 404s
  // for any versioned badge whose version isn't "1" (bits/100, moments/5,
  // predictions/blue-3 …), so tiered badges silently failed to render via the
  // <img> onerror hide. GQL's imageURL(size: NORMAL) is .../v1/<uuid>/1,
  // confirming the format; the version is already encoded in the UUID.
  const uuid = (version && meta.perVersion?.[version]) || meta.uuid
  return badgeImageUrl(uuid)
}

function badgeLabel(id: string, version: string): string {
  const meta = globalBadges[id]
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
