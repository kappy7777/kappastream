import { resolveUserIds } from './gql'

export type EmoteProvider = 'twitch' | '7tv' | 'bttv' | 'ffz'

export interface Emote {
  id: string
  name: string
  url: string
  provider: EmoteProvider
}

/**
 * A load's outcome: the emotes that resolved plus whether EVERY provider
 * request failed (network/timeout/5xx). A definitive "no emotes" (404, empty
 * payload) is a SUCCESS — `emotes` is just empty and `allFailed` is false.
 * Consumers use `allFailed` to distinguish "channel has no third-party
 * emotes" from "the emote providers are unreachable" (the latter deserves an
 * error banner and a retry on the next join).
 */
export interface EmoteLoadResult {
  emotes: Emote[]
  allFailed: boolean
}

interface ProviderCache {
  seventv: Emote[]
  bttv: Emote[]
  ffz: Emote[]
}

const cache = new Map<string, ProviderCache>()
const FETCH_TIMEOUT_MS = 8_000

/**
 * null = transient failure (network error, timeout, 5xx) — the caller must
 * NOT cache the result and may report the outage; a resolved (possibly
 * empty) array = definitive answer for this request.
 */
type ProviderResult = Promise<Emote[] | null>

async function fetchWithTimeout(url: string, signal?: AbortSignal): Promise<Response> {
  const controller = new AbortController()
  const abort = () => controller.abort()
  if (signal?.aborted) abort()
  else signal?.addEventListener('abort', abort, { once: true })
  const timer = setTimeout(abort, FETCH_TIMEOUT_MS)
  try {
    return await fetch(url, { signal: controller.signal })
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', abort)
  }
}

function sevenTvUrl(id: string, size: 1 | 2 | 3 | 4 = 2): string {
  return `https://cdn.7tv.app/emote/${id}/${size}x.webp`
}

function bttvUrl(id: string): string {
  return `https://cdn.betterttv.net/emote/${id}/3x.webp`
}

function ffzUrl(id: string): string {
  return `https://cdn.frankerfacez.com/emote/${id}/2`
}

export async function getTwitchUserId(username: string, signal?: AbortSignal): Promise<string | null> {
  try {
    if (signal?.aborted) return null
    // Batched GQL lookup (one users(logins:) request). emotes only ever
    // resolves ONE id at a time (per channel-join), so this passes a
    // single-element list — the batching pays off for the favorites refresh,
    // not here, but the transport (gql_fetch) stays uniform across the app.
    const ids = await resolveUserIds([username], signal)
    if (signal?.aborted) return null
    // Twitch returns `login` in canonical lowercase, so the map is keyed
    // lowercase. Match that here — a mixed-case channel name (e.g. "Somechan")
    // would otherwise miss and silently drop that channel's third-party emotes.
    return ids.get(username.toLowerCase()) ?? null
  } catch {
    return null
  }
}

interface SevenTvEmoteData {
  id: string
  name: string
  state?: string[]
  listed?: boolean
}

interface SevenTvSetEmote {
  id: string
  name: string
  data?: SevenTvEmoteData
  flags?: number
}

interface SevenTvSet {
  id: string
  emotes?: SevenTvSetEmote[]
  capacity?: number
}

interface SevenTvUserResponse {
  emote_set?: SevenTvSet
  user?: { emote_sets?: SevenTvSet[] }
}

function sevenTvEmote(setEmote: SevenTvSetEmote): Emote | null {
  const id = setEmote.data?.id || setEmote.id
  // In a 7TV v3 emote-set entry the TOP-LEVEL `name` is the alias active in
  // THAT set — the string chat messages actually contain — while `data.name`
  // is the emote's original name. A channel that renames catErm to erm returns
  // { name: "erm", data: { name: "catErm" } }; keying on data.name leaves the
  // alias unmapped. Prefer the set-entry name, falling back to data.name only
  // when the entry has no top-level name (e.g. the global set shape).
  const name = setEmote.name || setEmote.data?.name
  if (!id || !name) return null
  return { id, name, url: sevenTvUrl(id), provider: '7tv' }
}

function uniquePush(list: Emote[], emote: Emote | null) {
  if (!emote) return
  // Provider codes are CASE-SENSITIVE (7TV/BTTV/FFZ match the exact string a
  // chatter typed), so dedupe on the exact name — lowercasing here collapsed
  // Pog and POG into one entry.
  if (list.some((e) => e.name === emote.name)) return
  list.push(emote)
}

async function fetch7TVChannel(twitchUserId: string, signal?: AbortSignal): ProviderResult {
  try {
    const res = await fetchWithTimeout(`https://7tv.io/v3/users/twitch/${twitchUserId}`, signal)
    if (!res.ok) return res.status === 404 ? [] : null
    const data = (await res.json()) as SevenTvUserResponse
    const out: Emote[] = []

    if (data.emote_set?.emotes) {
      for (const e of data.emote_set.emotes) uniquePush(out, sevenTvEmote(e))
    }

    const seenSets = new Set<string>()
    if (data.emote_set?.id) seenSets.add(data.emote_set.id)
    for (const set of data.user?.emote_sets ?? []) {
      if (!set?.emotes || seenSets.has(set.id)) continue
      seenSets.add(set.id)
      for (const e of set.emotes) uniquePush(out, sevenTvEmote(e))
    }

    return out
  } catch {
    return null
  }
}

async function fetch7TVGlobal(signal?: AbortSignal): ProviderResult {
  try {
    const res = await fetchWithTimeout('https://7tv.io/v3/emote-sets/global', signal)
    if (!res.ok) return res.status === 404 ? [] : null
    const data = (await res.json()) as SevenTvSet
    const out: Emote[] = []
    for (const e of data.emotes ?? []) uniquePush(out, sevenTvEmote(e))
    return out
  } catch {
    return null
  }
}

interface BttvEmote {
  id: string
  code: string
}
interface BttvUser {
  channelEmotes?: BttvEmote[]
  sharedEmotes?: BttvEmote[]
}

function bttvEmote(e: BttvEmote): Emote {
  return { id: e.id, name: e.code, url: bttvUrl(e.id), provider: 'bttv' }
}

async function fetchBTTVChannel(twitchUserId: string, signal?: AbortSignal): ProviderResult {
  try {
    const res = await fetchWithTimeout(`https://api.betterttv.net/3/cached/users/twitch/${twitchUserId}`, signal)
    if (!res.ok) return res.status === 404 ? [] : null
    const data = (await res.json()) as BttvUser
    const out: Emote[] = []
    for (const e of data.channelEmotes ?? []) uniquePush(out, bttvEmote(e))
    for (const e of data.sharedEmotes ?? []) uniquePush(out, bttvEmote(e))
    return out
  } catch {
    return []
  }
}

async function fetchBTTVGlobal(signal?: AbortSignal): ProviderResult {
  try {
    const res = await fetchWithTimeout('https://api.betterttv.net/3/cached/emotes/global', signal)
    if (!res.ok) return res.status === 404 ? [] : null
    const data = (await res.json()) as BttvEmote[]
    const out: Emote[] = []
    for (const e of data) uniquePush(out, bttvEmote(e))
    return out
  } catch {
    return null
  }
}

interface FfzEmote {
  id: number
  name: string
}
interface FfzUser {
  sets?: Record<string, { emoticons?: FfzEmote[] }>
}
interface FfzGlobal {
  default_sets: number[]
  sets?: Record<string, { emoticons?: FfzEmote[] }>
}

function ffzEmote(e: FfzEmote): Emote {
  return { id: String(e.id), name: e.name, url: ffzUrl(String(e.id)), provider: 'ffz' }
}

async function fetchFFZChannel(twitchUserId: string, signal?: AbortSignal): ProviderResult {
  try {
    const res = await fetchWithTimeout(`https://api.frankerfacez.com/v1/user/id/${twitchUserId}`, signal)
    if (!res.ok) return res.status === 404 ? [] : null
    const data = (await res.json()) as FfzUser
    const out: Emote[] = []
    for (const set of Object.values(data.sets ?? {})) {
      for (const e of set.emoticons ?? []) uniquePush(out, ffzEmote(e))
    }
    return out
  } catch {
    return []
  }
}

async function fetchFFZGlobal(signal?: AbortSignal): ProviderResult {
  try {
    const res = await fetchWithTimeout('https://api.frankerfacez.com/v1/set/global', signal)
    if (!res.ok) return res.status === 404 ? [] : null
    const data = (await res.json()) as FfzGlobal
    // Only the sets listed in `default_sets` are the global ones — `sets` may
    // also contain other (e.g. featured) collections, so iterate by id rather
    // than flattening every key.
    const out: Emote[] = []
    for (const id of data.default_sets ?? []) {
      const set = data.sets?.[String(id)]
      for (const e of set?.emoticons ?? []) uniquePush(out, ffzEmote(e))
    }
    return out
  } catch {
    return null
  }
}

export async function loadChannelEmotes(channel: string, signal?: AbortSignal): Promise<EmoteLoadResult> {
  const key = channel.toLowerCase()
  const cached = cache.get(key)
  if (cached) return { emotes: [...cached.seventv, ...cached.bttv, ...cached.ffz], allFailed: false }

  const userId = await getTwitchUserId(channel, signal)
  if (signal?.aborted) return { emotes: [], allFailed: false }
  if (!userId) {
    // Do NOT cache the empty result. A null userId is most often a transient
    // GQL failure (getTwitchUserId swallows the error and returns null), and
    // cache is consulted first on the next call — caching [] here would cost
    // that channel its third-party emotes for the rest of the process. The
    // channel side counts as failed so an all-providers outage still reports.
    return { emotes: [], allFailed: true }
  }

  const [seventv, bttv, ffz] = await Promise.all([
    fetch7TVChannel(userId, signal),
    fetchBTTVChannel(userId, signal),
    fetchFFZChannel(userId, signal),
  ])

  if (signal?.aborted) return { emotes: [], allFailed: false }
  // A transient provider failure (null) must not poison the cache: the
  // partial result is returned for THIS join, but nothing is stored, so the
  // next join refetches every failed provider instead of silently running
  // without its emotes for the rest of the process.
  if (seventv === null || bttv === null || ffz === null) {
    const emotes = [seventv, bttv, ffz].filter((l): l is Emote[] => l !== null).flat()
    return { emotes, allFailed: seventv === null && bttv === null && ffz === null }
  }
  cache.set(key, { seventv, bttv, ffz })
  return { emotes: [...seventv, ...bttv, ...ffz], allFailed: false }
}

export async function loadGlobalEmotes(signal?: AbortSignal): Promise<EmoteLoadResult> {
  const [seventv, bttv, ffz] = await Promise.all([
    fetch7TVGlobal(signal),
    fetchBTTVGlobal(signal),
    fetchFFZGlobal(signal),
  ])
  const emotes = [seventv, bttv, ffz].filter((l): l is Emote[] => l !== null).flat()
  // FFZ appended last so channel emotes (which already won earlier in
  // buildEmoteMap's first-write-wins on the exact name) keep winning.
  return { emotes, allFailed: seventv === null && bttv === null && ffz === null }
}

export function buildEmoteMap(emotes: Emote[]): Map<string, Emote> {
  // Keys are the EXACT provider codes: 7TV/BTTV/FFZ match case-sensitively,
  // so "Pog" and "POG" are distinct emotes and must both resolve.
  const map = new Map<string, Emote>()
  for (const e of emotes) {
    if (!map.has(e.name)) map.set(e.name, e)
  }
  return map
}

export interface EmoteRange {
  start: number
  end: number
  id: string
}

// Twitch's emote-tag positions count Unicode CODE POINTS; every consumer of
// EmoteRange slices the message in UTF-16 code units. An emoji outside the
// BMP (1 code point, 2 code units) before an emote shifts each later range by
// one unit per emoji, slicing the emote mid-glyph. Build the code-point →
// UTF-16 offset table on the exact string the renderer later slices (callers
// must pass THAT string, not a wrapped variant like the raw CTCP ACTION
// trailing) and translate every range through it.
export function parseTwitchEmoteTag(tag: string | undefined, message: string): EmoteRange[] {
  if (!tag) return []
  // offsets[i] = UTF-16 index of the i-th code point; for..of iterates code
  // points, and each yielded string's length is its unit size (2 for an
  // astral emoji).
  const offsets: number[] = []
  let u16 = 0
  for (const ch of message) {
    offsets.push(u16)
    u16 += ch.length
  }
  const codePoints = offsets.length
  const ranges: EmoteRange[] = []
  for (const part of tag.split('/')) {
    if (!part) continue
    const [id, positions] = part.split(':')
    if (!id || !positions) continue
    for (const pos of positions.split(',')) {
      const [a, b] = pos.split('-')
      const cpStart = Number(a)
      const cpEnd = Number(b)
      if (!Number.isFinite(cpStart) || !Number.isFinite(cpEnd)) continue
      // Out-of-message or inverted ranges can only be a malformed tag; drop
      // them rather than clamp (a clamped range would render arbitrary text
      // as a broken emote).
      if (cpStart < 0 || cpEnd < cpStart || cpEnd >= codePoints) continue
      // The UTF-16 end covers both units of a trailing surrogate pair: it is
      // the offset of the NEXT code point minus one (or the string end).
      const start = offsets[cpStart]
      const end = (cpEnd + 1 < codePoints ? offsets[cpEnd + 1] : message.length) - 1
      ranges.push({ start, end, id })
    }
  }
  ranges.sort((x, y) => x.start - y.start)
  return ranges
}

export function twitchEmoteUrl(id: string, size: '1' | '2' | '3' = '2'): string {
  return `https://static-cdn.jtvnw.net/emoticons/v2/${id}/default/dark/${size}.0`
}

export interface RenderInput {
  message: string
  thirdParty: Map<string, Emote>
  twitchRanges?: EmoteRange[]
}

export type RenderedMessagePart =
  { type: 'text'; text: string } | { type: 'emote'; name: string; url: string; provider: EmoteProvider }

export function renderMessage({ message, thirdParty, twitchRanges = [] }: RenderInput): RenderedMessagePart[] {
  const merged = [...twitchRanges, ...thirdPartyRanges(message, thirdParty)].sort((x, y) => x.start - y.start)
  if (merged.length === 0) return [{ type: 'text', text: message }]

  let cursor = 0
  const parts: RenderedMessagePart[] = []
  for (const r of merged) {
    // A range overlapping one already rendered is skipped, not stacked: the
    // practical producer is a third-party emote with the same name as a
    // Twitch emote. twitchRanges precede the third-party ranges here and the
    // sort is stable, so Twitch wins any tie.
    if (r.start < cursor) continue
    if (r.start > cursor) parts.push({ type: 'text', text: message.slice(cursor, r.start) })
    parts.push(renderEmoteAt(message, r))
    cursor = r.end + 1
  }
  if (cursor < message.length) parts.push({ type: 'text', text: message.slice(cursor) })
  return parts
}

function thirdPartyRanges(message: string, thirdParty: Map<string, Emote>): EmoteRange[] {
  const ranges: EmoteRange[] = []
  let i = 0
  while (i < message.length) {
    const ch = message[i]
    if (ch === ' ' || ch === '\t' || ch === '\n') {
      i++
      continue
    }
    const start = i
    while (i < message.length && message[i] !== ' ' && message[i] !== '\t' && message[i] !== '\n') {
      i++
    }
    const word = message.slice(start, i)
    // Provider codes match case-sensitively. Try the WHOLE word first — that
    // is the only way punctuation-bearing ("D:", ":tf:", "(ditto)") and
    // non-ASCII codes can ever match, since the strip below removes exactly
    // those characters. Then the edge-punctuation-stripped token, still
    // exactly, so "ez" never renders the emote registered as "EZ".
    const whole = thirdParty.get(word)
    const stripped = word.replace(/^[^A-Za-z0-9_]+|[^A-Za-z0-9_]+$/g, '')
    const emote = whole ?? (stripped && stripped !== word ? thirdParty.get(stripped) : undefined)
    if (!emote) continue
    // The emitted range must cover only the matched span — not the full
    // word — so edge punctuation ("EZ!") stays as text instead of being
    // absorbed into the emote span. indexOf gives the match's offset within
    // the word.
    const matched = whole ? word : stripped
    const offset = word.indexOf(matched)
    ranges.push({
      start: start + offset,
      end: start + offset + matched.length - 1,
      id: emote.id + '|' + emote.provider,
    })
  }
  return ranges
}

function renderEmoteAt(message: string, r: EmoteRange): RenderedMessagePart {
  const name = message.slice(r.start, r.end + 1)
  if (r.id.includes('|')) {
    const [id, provider] = r.id.split('|') as [string, EmoteProvider]
    return { type: 'emote', name, url: urlFor(id, provider), provider }
  }
  return { type: 'emote', name, url: twitchEmoteUrl(r.id), provider: 'twitch' }
}

function urlFor(id: string, provider: EmoteProvider): string {
  switch (provider) {
    case '7tv':
      return sevenTvUrl(id)
    case 'bttv':
      return bttvUrl(id)
    case 'ffz':
      return ffzUrl(id)
    case 'twitch':
      return twitchEmoteUrl(id)
  }
}
