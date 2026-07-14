export type EmoteProvider = 'twitch' | '7tv' | 'bttv' | 'ffz'

export interface Emote {
  id: string
  name: string
  url: string
  provider: EmoteProvider
}

interface ProviderCache {
  seventv: Emote[]
  bttv: Emote[]
  ffz: Emote[]
}

const cache = new Map<string, ProviderCache>()
const FETCH_TIMEOUT_MS = 8_000

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
    const t = (window as unknown as { __TAURI__: { core: { invoke(cmd: string, args?: Record<string, unknown>): Promise<unknown> } } }).__TAURI__
    const id = await t.core.invoke('decapi_fetch', { path: `twitch/id/${username}`, timeoutMs: FETCH_TIMEOUT_MS })
    if (signal?.aborted) return null
    return typeof id === 'string' && /^\d+$/.test(id) ? id : null
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

function isPublicSevenTv(emote: SevenTvSetEmote): boolean {
  const state = Array.isArray(emote.data?.state) ? emote.data!.state : []
  if (state.includes('PERSONAL')) return false
  return true
}

function sevenTvEmote(setEmote: SevenTvSetEmote): Emote | null {
  if (!isPublicSevenTv(setEmote)) return null
  const id = setEmote.data?.id || setEmote.id
  const name = setEmote.data?.name || setEmote.name
  if (!id || !name) return null
  return { id, name, url: sevenTvUrl(id), provider: '7tv' }
}

function uniquePush(list: Emote[], emote: Emote | null) {
  if (!emote) return
  const key = emote.name.toLowerCase()
  if (list.some((e) => e.name.toLowerCase() === key)) return
  list.push(emote)
}

async function fetch7TVChannel(twitchUserId: string, signal?: AbortSignal): Promise<Emote[]> {
  try {
    const res = await fetchWithTimeout(`https://7tv.io/v3/users/twitch/${twitchUserId}`, signal)
    if (!res.ok) return []
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
    return []
  }
}

async function fetch7TVGlobal(signal?: AbortSignal): Promise<Emote[]> {
  try {
    const res = await fetchWithTimeout('https://7tv.io/v3/emote-sets/global', signal)
    if (!res.ok) return []
    const data = (await res.json()) as SevenTvSet
    const out: Emote[] = []
    for (const e of data.emotes ?? []) uniquePush(out, sevenTvEmote(e))
    return out
  } catch {
    return []
  }
}

interface BttvEmote { id: string; code: string }
interface BttvUser {
  channelEmotes?: BttvEmote[]
  sharedEmotes?: BttvEmote[]
}

function bttvEmote(e: BttvEmote): Emote {
  return { id: e.id, name: e.code, url: bttvUrl(e.id), provider: 'bttv' }
}

async function fetchBTTVChannel(twitchUserId: string, signal?: AbortSignal): Promise<Emote[]> {
  try {
    const res = await fetchWithTimeout(`https://api.betterttv.net/3/cached/users/twitch/${twitchUserId}`, signal)
    if (!res.ok) return []
    const data = (await res.json()) as BttvUser
    const out: Emote[] = []
    for (const e of data.channelEmotes ?? []) uniquePush(out, bttvEmote(e))
    for (const e of data.sharedEmotes ?? []) uniquePush(out, bttvEmote(e))
    return out
  } catch {
    return []
  }
}

async function fetchBTTVGlobal(signal?: AbortSignal): Promise<Emote[]> {
  try {
    const res = await fetchWithTimeout('https://api.betterttv.net/3/cached/emotes/global', signal)
    if (!res.ok) return []
    const data = (await res.json()) as BttvEmote[]
    const out: Emote[] = []
    for (const e of data) uniquePush(out, bttvEmote(e))
    return out
  } catch {
    return []
  }
}

interface FfzEmote { id: number; name: string }
interface FfzUser {
  sets?: Record<string, { emoticons?: FfzEmote[] }>
}

function ffzEmote(e: FfzEmote): Emote {
  return { id: String(e.id), name: e.name, url: ffzUrl(String(e.id)), provider: 'ffz' }
}

async function fetchFFZChannel(twitchUserId: string, signal?: AbortSignal): Promise<Emote[]> {
  try {
    const res = await fetchWithTimeout(`https://api.frankerfacez.com/v1/user/id/${twitchUserId}`, signal)
    if (!res.ok) return []
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

export async function loadChannelEmotes(channel: string, signal?: AbortSignal): Promise<Emote[]> {
  const key = channel.toLowerCase()
  const cached = cache.get(key)
  if (cached) return [...cached.seventv, ...cached.bttv, ...cached.ffz]

  const userId = await getTwitchUserId(channel, signal)
  if (signal?.aborted) return []
  if (!userId) {
    cache.set(key, { seventv: [], bttv: [], ffz: [] })
    return []
  }

  const [seventv, bttv, ffz] = await Promise.all([
    fetch7TVChannel(userId, signal),
    fetchBTTVChannel(userId, signal),
    fetchFFZChannel(userId, signal),
  ])

  if (signal?.aborted) return []
  cache.set(key, { seventv, bttv, ffz })
  return [...seventv, ...bttv, ...ffz]
}

export async function loadGlobalEmotes(signal?: AbortSignal): Promise<Emote[]> {
  const [seventv, bttv] = await Promise.all([fetch7TVGlobal(signal), fetchBTTVGlobal(signal)])
  return [...seventv, ...bttv]
}

export function buildEmoteMap(emotes: Emote[]): Map<string, Emote> {
  const map = new Map<string, Emote>()
  for (const e of emotes) {
    const key = e.name.toLowerCase()
    if (!map.has(key)) map.set(key, e)
  }
  return map
}

export interface EmoteRange {
  start: number
  end: number
  id: string
}

export function parseTwitchEmoteTag(tag: string | undefined, message: string): EmoteRange[] {
  if (!tag) return []
  const ranges: EmoteRange[] = []
  for (const part of tag.split('/')) {
    if (!part) continue
    const [id, positions] = part.split(':')
    if (!id || !positions) continue
    for (const pos of positions.split(',')) {
      const [a, b] = pos.split('-')
      const start = Number(a)
      const end = Number(b)
      if (Number.isFinite(start) && Number.isFinite(end)) {
        ranges.push({ start, end, id })
      }
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
  | { type: 'text'; text: string }
  | { type: 'emote'; name: string; url: string; provider: EmoteProvider }

export function renderMessage({ message, thirdParty, twitchRanges = [] }: RenderInput): RenderedMessagePart[] {
  const merged = [...twitchRanges, ...thirdPartyRanges(message, thirdParty)].sort(
    (x, y) => x.start - y.start,
  )
  if (merged.length === 0) return [{ type: 'text', text: message }]

  let cursor = 0
  const parts: RenderedMessagePart[] = []
  for (const r of merged) {
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
    const stripped = word.replace(/^[^A-Za-z0-9_]+|[^A-Za-z0-9_]+$/g, '')
    if (!stripped) continue
    const emote = thirdParty.get(stripped.toLowerCase())
    if (!emote) continue
    ranges.push({
      start,
      end: start + word.length - 1,
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
