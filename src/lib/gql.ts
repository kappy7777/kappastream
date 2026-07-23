import { invoke } from '@tauri-apps/api/core'

/*
 * Twitch GQL primary data source.
 *
 * The favorites refresh resolves the whole list in a SINGLE batched
 * `users(logins:)` query via the Rust `gql_fetch` command (a CORS-bypassing
 * reqwest POST with the public Client-ID pinned server-side). A live channel
 * returns its stream object; an offline channel returns `stream: null`; a
 * nonexistent login returns a `null` entry at its position. All three are
 * transport SUCCESSES — only a network/HTTP/parse failure is treated as an
 * error and triggers the DecAPI per-channel fallback in favorites.svelte.
 *
 * Field names + argument signatures confirmed against the live endpoint (see
 * the STEP 1 spike): `profileImageURL(width:)`, `previewImageURL` (+ optional
 * width/height), `boxArtURL(width:, height:)`, `viewersCount`, `createdAt`.
 */

// Max logins per GQL request. The spike confirmed the endpoint accepts 400+ in
// one request with no complexity cap, but 100 keeps each response small
// (~23 KB, ~600–900 ms) and well under the Rust 256 KB response cap. A full
// favorites list (MAX_FAVORITES = 1000) is fetched as ceil(N/100) SEQUENTIAL
// chunks — up to 10 requests for 1000 favorites (~7–9 s), still far inside the
// GQL_REFRESH_INTERVAL_MS window. Chunk order is preserved, so results zip by
// index regardless of how many chunks fire. See favorites.svelte pollOnce.
export const GQL_BATCH_SIZE = 100

// Favorites refresh cadence. One batched request covers the whole list, so a
// short interval is cheap (unlike the per-channel DecAPI path it replaces).
export const GQL_REFRESH_INTERVAL_MS = 150_000

const GQL_TIMEOUT_MS = 8_000

const USER_STATUS_QUERY = `
  query($logins: [String!]) {
    users(logins: $logins) {
      id
      login
      displayName
      profileImageURL(width: 70)
      stream {
        id
        title
        type
        viewersCount
        createdAt
        previewImageURL
        game {
          id
          name
          displayName
          boxArtURL(width: 52, height: 72)
        }
      }
    }
  }
`

const USER_ID_QUERY = `
  query($logins: [String!]) {
    users(logins: $logins) {
      id
      login
    }
  }
`

export interface ChannelStatus {
  login: string
  displayName: string
  live: boolean
  title: string
  game: string
  viewersCount: number
  // ISO-8601 stream start ('' when offline / nonexistent). Favorites converts
  // this to a human uptime string for the LiveStatus type.
  startedAt: string
  thumbnailUrl: string
  // profileImageURL — surfaced alongside status so favorites gets the avatar
  // "for free" in the same request (DecAPI needed a separate /avatar call).
  avatarUrl: string
}

interface RawUser {
  id: string
  login: string
  displayName: string
  profileImageURL?: string | null
  stream?: RawStream | null
}

interface RawStream {
  id: string
  title: string
  type: string
  viewersCount: number
  createdAt: string
  previewImageURL?: string | null
  game?: { name: string; displayName: string } | null
}

// A 200 GQL response envelope. `data` is an untyped object keyed by the
// operation's top-level selection set; callers narrow it via the generic on
// gqlRequest. A top-level `errors` array means the query failed to execute.
interface GqlEnvelope {
  data?: Record<string, unknown> | null
  errors?: unknown
}

/**
 * POST one query body to gql_fetch. Throws on ANY transport-level problem
 * (network error, non-2xx, malformed JSON, top-level GQL `errors`, or an
 * aborted signal). The favorites caller treats a throw as "GQL unavailable →
 * DecAPI fallback"; the discovery callers (search/browse) treat it as a
 * visible, non-blocking error state.
 *
 * The Rust `gql_fetch` command has no cancellation channel, so aborting the
 * signal cannot truly cancel the in-flight HTTP request — but checking the
 * signal both before invoke AND after its resolution lets the caller discard
 * a result that arrived after a newer keystroke superseded it (the JS promise
 * rejects with 'aborted' rather than resolving with stale data).
 */
async function gqlRequest<T = Record<string, unknown>>(
  query: string,
  variables: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<T> {
  if (signal?.aborted) throw new Error('aborted')
  const body = JSON.stringify({ query, variables })
  // Throws on non-2xx / network / timeout / oversized — same string-typed
  // error convention as decapi_fetch.
  const raw = await invoke<string>('gql_fetch', { body, timeoutMs: GQL_TIMEOUT_MS })
  // A request that resolved after its AbortController fired is stale.
  if (signal?.aborted) throw new Error('aborted')
  let parsed: GqlEnvelope
  try {
    parsed = JSON.parse(raw) as GqlEnvelope
  } catch {
    throw new Error('malformed gql response')
  }
  // A 200 with a top-level `errors` array means the query itself failed to
  // execute (schema drift, persistent-query issue, rate limit, …) — treat it
  // as a transport failure so callers surface an error rather than empty data.
  if (!parsed || parsed.errors || typeof parsed.data !== 'object' || parsed.data === null) {
    throw new Error('gql errors')
  }
  return parsed.data as T
}

function chunk<T>(items: T[], size: number): T[][] {
  if (size <= 0) return items.length ? [items] : []
  const out: T[][] = []
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size))
  return out
}

function toChannelStatus(user: RawUser | null): ChannelStatus {
  // A null entry = nonexistent login (positional). Surface it as an offline
  // channel with empty fields; favorites keeps whatever it already had. This
  // is a SUCCESS — never a fallback trigger.
  if (!user) {
    return {
      login: '',
      displayName: '',
      live: false,
      title: '',
      game: '',
      viewersCount: 0,
      startedAt: '',
      thumbnailUrl: '',
      avatarUrl: '',
    }
  }
  const stream = user.stream ?? null
  return {
    login: user.login,
    displayName: user.displayName ?? user.login,
    live: !!stream,
    title: stream?.title ?? '',
    game: stream?.game?.displayName ?? stream?.game?.name ?? '',
    viewersCount: typeof stream?.viewersCount === 'number' ? stream.viewersCount : 0,
    startedAt: stream?.createdAt ?? '',
    thumbnailUrl: stream?.previewImageURL ?? '',
    avatarUrl: user.profileImageURL ?? '',
  }
}

/**
 * Resolve Twitch user IDs for a set of logins. Replaces emotes.ts's per-user
 * `decapi_fetch('twitch/id/<user>')` calls with one batched GQL request per
 * GQL_BATCH_SIZE logins. Nonexistent logins (null entries) are omitted.
 */
export async function resolveUserIds(
  logins: string[],
  signal?: AbortSignal,
): Promise<Map<string, string>> {
  const out = new Map<string, string>()
  for (const batch of chunk(logins, GQL_BATCH_SIZE)) {
    if (signal?.aborted) return out
    const data = await gqlRequest<{ users?: (RawUser | null)[] | null }>(
      USER_ID_QUERY,
      { logins: batch },
      signal,
    )
    for (const user of data?.users ?? []) {
      if (user && typeof user.id === 'string' && user.login) {
        out.set(user.login, user.id)
      }
    }
  }
  return out
}

/**
 * Fetch live/offline status + metadata for a set of logins in one batched
 * request (per GQL_BATCH_SIZE). The returned array preserves the input order,
 * with empty-login placeholders for nonexistent users so callers can zip by
 * index if needed.
 */
export async function fetchChannelStatuses(
  logins: string[],
  signal?: AbortSignal,
): Promise<ChannelStatus[]> {
  const out: ChannelStatus[] = []
  for (const batch of chunk(logins, GQL_BATCH_SIZE)) {
    if (signal?.aborted) return out
    const data = await gqlRequest<{ users?: (RawUser | null)[] | null }>(
      USER_STATUS_QUERY,
      { logins: batch },
      signal,
    )
    const users = data?.users ?? []
    for (let i = 0; i < batch.length; i++) {
      const status = toChannelStatus(users[i] ?? null)
      // Preserve the input login for null (nonexistent) entries, since the
      // raw user is null and carries no login field.
      if (!status.login) status.login = batch[i]
      out.push(status)
    }
  }
  return out
}

/*
 * ============================================================================
 * Channel discovery — search + browse.
 *
 * GQL-ONLY and anonymous throughout (same public Client-ID, no auth). There is
 * NO DecAPI fallback for discovery, so on transport failure these throw and the
 * caller must surface a visible, non-blocking error state. An empty result set
 * is ALWAYS a success (matches the offline-vs-failure discipline above): never
 * report "no results" when the request actually errored.
 *
 * Operation names, argument shapes and field/argument names below were verified
 * field-by-field against the live schema dump (SuperSonicHub1/twitch-graphql-api
 * schema.graphql):
 *   - searchFor(userQuery, platform, target: { index: CHANNEL }) → SearchFor
 *       .channels: SearchForResultUsers → .items: [User!]   (USER fields incl.
 *       profileImageURL(width: Int!) + stream: Stream)
 *   - streams(first) → StreamConnection.edges: [StreamEdge] { node: Stream }
 *       (root streams rejects first > 30; see TOP_STREAMS_FIRST)
 *   - games(first) → GameConnection.edges: [GameEdge!] { node: Game }
 *   - game(name:) → Game.streams(first) → StreamConnection
 *   - Stream: id, title, type, viewersCount: Int, createdAt: Time,
 *       previewImageURL(width: Int, height: Int), broadcaster: User, game: Game
 *   - Game: id, name, displayName, boxArtURL(width: Int, height: Int)
 * NOTE: the schema supports `after: Cursor` pagination, but passing a cursor
 * to gql.twitch.tv as an anonymous client fails with "IntegrityCheckFailed" —
 * a server-side anti-bot control. We therefore request each list's full page
 * in ONE shot (over-fetching to the query's hard cap) and do a client-side
 * reveal (see browse-reveal.ts); no `after` is ever sent. All optional filter
 * inputs (StreamOptions / GameOptions) are omitted — we rely on the default
 * VIEWER_COUNT sort.
 * ============================================================================
 */

// Thumbnails / avatars are requested at explicit dimensions rather than the
// templated default, so the CDN serves a real (smaller) image. 320×180 is 16:9;
// box art is 3:4 (144×192); avatars 50px.
const THUMB_W = 320
const THUMB_H = 180
const BOX_W = 144
const BOX_H = 192
const AVATAR_PX = 50

// Page sizes per discovery query. Anonymous Twitch GQL rejects `after` cursors
// ("IntegrityCheckFailed" — an anti-bot control), so server-side pagination is
// not viable: each list is fetched in ONE request up to its hard cap and
// BrowseView reveals more client-side (see browse-reveal.ts). The root
// `streams` query rejects first > 30 ("argument 'first' value must be between
// 1 and 30"); `games(first:)` and `game(name:).streams(first:)` accept 100.
// Do NOT raise TOP_STREAMS_FIRST past 30.
const TOP_STREAMS_FIRST = 30
const TOP_GAMES_FIRST = 100
const GAME_STREAMS_FIRST = 100

export interface SearchChannelResult {
  id: string
  login: string
  displayName: string
  avatarUrl: string
  live: boolean
  title: string
  game: string
  viewersCount: number
}

export interface BrowseStream {
  id: string
  login: string
  displayName: string
  avatarUrl: string
  title: string
  game: string
  gameName: string
  viewersCount: number
  thumbnailUrl: string
}

export interface BrowseCategory {
  id: string
  name: string
  displayName: string
  boxArtUrl: string
}

/** One page of streams (cursor pagination removed — see TOP_STREAMS_FIRST). */
export interface StreamPage {
  streams: BrowseStream[]
}

/** One page of categories (cursor pagination removed — see TOP_GAMES_FIRST). */
export interface CategoryPage {
  categories: BrowseCategory[]
}

interface RawBrowseStream {
  id: string
  title?: string | null
  viewersCount?: number | null
  previewImageURL?: string | null
  broadcaster?: { login?: string; displayName?: string; profileImageURL?: string | null } | null
  game?: { name?: string; displayName?: string } | null
}
interface RawBrowseStreamEdge {
  node?: RawBrowseStream | null
}
interface RawBrowseStreamConnection {
  edges?: (RawBrowseStreamEdge | null)[] | null
}
interface RawBrowseGame {
  id: string
  name?: string
  displayName?: string
  boxArtURL?: string | null
}
interface RawBrowseGameEdge {
  node?: RawBrowseGame | null
}
interface RawBrowseGameConnection {
  edges?: (RawBrowseGameEdge | null)[] | null
}

const SEARCH_QUERY = `
  query($query: String!) {
    searchFor(userQuery: $query, platform: "web", target: { index: CHANNEL }) {
      channels {
        items {
          id
          login
          displayName
          profileImageURL(width: ${AVATAR_PX})
          stream {
            id
            title
            viewersCount
            game {
              id
              name
              displayName
            }
          }
        }
      }
    }
  }
`

const TOP_STREAMS_QUERY = `
  query($first: Int!) {
    streams(first: $first) {
      edges {
        node {
          id
          title
          viewersCount
          previewImageURL(width: ${THUMB_W}, height: ${THUMB_H})
          broadcaster {
            id
            login
            displayName
            profileImageURL(width: ${AVATAR_PX})
          }
          game {
            id
            name
            displayName
          }
        }
      }
    }
  }
`

const TOP_GAMES_QUERY = `
  query($first: Int!) {
    games(first: $first) {
      edges {
        node {
          id
          name
          displayName
          boxArtURL(width: ${BOX_W}, height: ${BOX_H})
        }
      }
    }
  }
`

const GAME_STREAMS_QUERY = `
  query($name: String!, $first: Int!) {
    game(name: $name) {
      streams(first: $first) {
        edges {
          node {
            id
            title
            viewersCount
            previewImageURL(width: ${THUMB_W}, height: ${THUMB_H})
            broadcaster {
              id
              login
              displayName
              profileImageURL(width: ${AVATAR_PX})
            }
            game {
              id
              name
              displayName
            }
          }
        }
      }
    }
  }
`

interface RawSearchUser {
  id: string
  login: string
  displayName: string
  profileImageURL?: string | null
  stream?: { title?: string | null; viewersCount?: number | null; game?: { name?: string; displayName?: string } | null } | null
}
interface RawSearchFor {
  searchFor?: { channels?: { items?: (RawSearchUser | null)[] | null } | null } | null
}

function toSearchResult(user: RawSearchUser | null): SearchChannelResult | null {
  if (!user || !user.login) return null
  const stream = user.stream ?? null
  return {
    id: user.id ?? '',
    login: user.login,
    displayName: user.displayName ?? user.login,
    avatarUrl: user.profileImageURL ?? '',
    live: !!stream,
    title: stream?.title ?? '',
    game: stream?.game?.displayName ?? stream?.game?.name ?? '',
    viewersCount: typeof stream?.viewersCount === 'number' ? stream.viewersCount : 0,
  }
}

function toBrowseStream(node: RawBrowseStream | null | undefined): BrowseStream | null {
  if (!node || !node.id || !node.broadcaster?.login) return null
  return {
    id: node.id,
    login: node.broadcaster.login,
    displayName: node.broadcaster.displayName ?? node.broadcaster.login,
    avatarUrl: node.broadcaster.profileImageURL ?? '',
    title: node.title ?? '',
    game: node.game?.displayName ?? node.game?.name ?? '',
    gameName: node.game?.name ?? '',
    viewersCount: typeof node.viewersCount === 'number' ? node.viewersCount : 0,
    thumbnailUrl: node.previewImageURL ?? '',
  }
}

function toCategory(node: RawBrowseGame | null | undefined): BrowseCategory | null {
  if (!node || !node.name) return null
  return {
    id: node.id ?? '',
    name: node.name,
    displayName: node.displayName ?? node.name,
    boxArtUrl: node.boxArtURL ?? '',
  }
}

/**
 * Search live + offline channels by query. Returns matching channels with
 * display name, login, avatar, and (when live) title/category/viewers. Throws
 * on transport failure; an empty query short-circuits to an empty list without
 * a request (the caller is expected to skip the call for empty input anyway).
 */
export async function searchChannels(query: string, signal?: AbortSignal): Promise<SearchChannelResult[]> {
  const data = await gqlRequest<RawSearchFor>(SEARCH_QUERY, { query }, signal)
  const items = data?.searchFor?.channels?.items ?? []
  const out: SearchChannelResult[] = []
  for (const item of items) {
    const result = toSearchResult(item ?? null)
    if (result) out.push(result)
  }
  return out
}

function parseStreamPage(conn: RawBrowseStreamConnection | null | undefined): StreamPage {
  const edges = conn?.edges ?? []
  const streams: BrowseStream[] = []
  for (const edge of edges) {
    const stream = toBrowseStream(edge?.node ?? null)
    if (stream) streams.push(stream)
  }
  return { streams }
}

/**
 * Fetch the top live streams (viewer-descending) — the Browse landing list.
 * Capped at TOP_STREAMS_FIRST (30): the root `streams` query rejects first > 30.
 */
export async function fetchTopStreams(signal?: AbortSignal): Promise<StreamPage> {
  const data = await gqlRequest<{ streams?: RawBrowseStreamConnection | null }>(
    TOP_STREAMS_QUERY,
    { first: TOP_STREAMS_FIRST },
    signal,
  )
  return parseStreamPage(data?.streams ?? null)
}

/**
 * Fetch the top categories/games (viewer-descending) for the Browse grid.
 * Over-fetches TOP_GAMES_FIRST (100) so BrowseView can reveal more client-side.
 */
export async function fetchTopCategories(signal?: AbortSignal): Promise<CategoryPage> {
  const data = await gqlRequest<{ games?: RawBrowseGameConnection | null }>(
    TOP_GAMES_QUERY,
    { first: TOP_GAMES_FIRST },
    signal,
  )
  const edges = data?.games?.edges ?? []
  const categories: BrowseCategory[] = []
  for (const edge of edges) {
    const cat = toCategory(edge?.node ?? null)
    if (cat) categories.push(cat)
  }
  return { categories }
}

/**
 * Fetch the live streams for a single category (game `name`). Used when a user
 * drills into a category from the Browse grid. Over-fetches GAME_STREAMS_FIRST
 * (100) so BrowseView can reveal more client-side.
 */
export async function fetchGameStreams(
  gameName: string,
  signal?: AbortSignal,
): Promise<StreamPage> {
  const data = await gqlRequest<{ game?: { streams?: RawBrowseStreamConnection | null } | null }>(
    GAME_STREAMS_QUERY,
    { name: gameName, first: GAME_STREAMS_FIRST },
    signal,
  )
  return parseStreamPage(data?.game?.streams ?? null)
}

/*
 * ============================================================================
 * Channel content — past broadcasts, highlights, clips.
 *
 * Same anonymous + GQL-only transport as discovery (no DecAPI fallback). Like
 * discovery, `after` cursors are unusable (IntegrityCheckFailed), so each list
 * over-fetches its hard cap (100) in ONE request and the caller reveals more
 * client-side (see browse-reveal.ts). Empty is a SUCCESS.
 *
 * Verified against the live schema (see the block above):
 *   - user(login:).videos(first, type: BroadcastType, sort: VideoSort)
 *       BroadcastType: ARCHIVE (past broadcast) / HIGHLIGHT / UPLOAD / ...
 *       VideoSort: TIME / TIME_ASC / VIEWS
 *   - user(login:).clips(first, criteria: UserClipsInput)
 *       UserClipsInput { period: ClipsPeriod, sort: ClipsSort, ... }
 *       ClipsPeriod: LAST_DAY / LAST_WEEK / LAST_MONTH / ALL_TIME
 *       ClipsSort: VIEWS_DESC / VIEWS_ASC / CREATED_AT_DESC / CREATED_AT_ASC
 *   - Video: id, title, lengthSeconds (use; `duration` deprecated), viewCount,
 *       createdAt, previewThumbnailURL(width,height), game{name,displayName}
 *   - Clip: id, slug, title, durationSeconds, viewCount, createdAt,
 *       thumbnailURL(width,height), game{name,displayName}, curator{login,displayName}
 *
 * Playback: clip media is fetched as direct MP4 URLs via clip(slug:).videoQualities
 * (anonymous) — streamlink 8.4.0 cannot resolve clips (PersistedQueryNotFound),
 * so clips play natively from these sourceURLs without streamlink. VODs resolve
 * through the Rust `resolve_vod` command (streamlink, CloudFront allowlist).
 * ============================================================================
 */

const CHANNEL_VIDEOS_FIRST = 100
const CHANNEL_CLIPS_FIRST = 100

// Clip thumbnail "valid sizes" per the schema are 86x45 / 260x147 / 480x272;
// 480x272 is the largest crisp option. Video thumbnails are templated to 320x180.
const CLIP_THUMB_W = 480
const CLIP_THUMB_H = 272

/** The BroadcastType values we surface as sections. */
export type VideoBroadcastType = 'ARCHIVE' | 'HIGHLIGHT'

export interface ChannelVideo {
  id: string
  title: string
  lengthSeconds: number
  viewCount: number
  createdAt: string
  thumbnailUrl: string
  broadcastType: string
  game: string
}

export interface ChannelClip {
  id: string
  slug: string
  title: string
  durationSeconds: number
  viewCount: number
  createdAt: string
  thumbnailUrl: string
  game: string
  curator: string
}

export interface ClipQuality {
  quality: string
  frameRate: number
  sourceUrl: string
}

export interface ClipMedia {
  id: string
  title: string
  durationSeconds: number
  qualities: ClipQuality[]
}

interface RawChannelVideo {
  id: string
  title?: string | null
  lengthSeconds?: number | null
  viewCount?: number | null
  createdAt?: string | null
  previewThumbnailURL?: string | null
  broadcastType?: string | null
  game?: { name?: string; displayName?: string } | null
}
interface RawChannelClip {
  id: string
  slug?: string | null
  title?: string | null
  durationSeconds?: number | null
  viewCount?: number | null
  createdAt?: string | null
  thumbnailURL?: string | null
  game?: { name?: string; displayName?: string } | null
  curator?: { login?: string; displayName?: string } | null
}
interface RawClipQuality {
  quality?: string | null
  frameRate?: number | null
  sourceURL?: string | null
}
interface RawClipMedia {
  id: string
  title?: string | null
  durationSeconds?: number | null
  videoQualities?: (RawClipQuality | null)[] | null
}

const CHANNEL_VIDEOS_QUERY = `
  query($login: String!, $first: Int!, $type: BroadcastType!) {
    user(login: $login) {
      videos(first: $first, type: $type, sort: TIME) {
        edges {
          node {
            id
            title
            lengthSeconds
            viewCount
            createdAt
            previewThumbnailURL(width: ${THUMB_W}, height: ${THUMB_H})
            broadcastType
            game {
              id
              name
              displayName
            }
          }
        }
      }
    }
  }
`

const CLIP_MEDIA_QUERY = `
  query($slug: ID!) {
    clip(slug: $slug) {
      id
      title
      durationSeconds
      videoQualities {
        quality
        frameRate
        sourceURL
      }
    }
  }
`

// Clip slugs are alphanumeric words joined by dashes/underscores, e.g.
// "CrispyJollyGullHassaanChop-nPlLKGxGRcBj37e4". Validated before the slug is
// sent in a GQL variable so a malformed/external value can never be issued.
const CLIP_SLUG_RE = /^[A-Za-z0-9_-]{1,100}$/

export function isValidClipSlug(slug: string): boolean {
  return CLIP_SLUG_RE.test(slug)
}

function toChannelVideo(node: RawChannelVideo | null | undefined): ChannelVideo | null {
  if (!node || !node.id) return null
  return {
    id: node.id,
    title: node.title ?? '',
    lengthSeconds: typeof node.lengthSeconds === 'number' ? node.lengthSeconds : 0,
    viewCount: typeof node.viewCount === 'number' ? node.viewCount : 0,
    createdAt: node.createdAt ?? '',
    thumbnailUrl: node.previewThumbnailURL ?? '',
    broadcastType: node.broadcastType ?? '',
    game: node.game?.displayName ?? node.game?.name ?? '',
  }
}

function toChannelClip(node: RawChannelClip | null | undefined): ChannelClip | null {
  if (!node || !node.id || !node.slug) return null
  return {
    id: node.id,
    slug: node.slug,
    title: node.title ?? '',
    durationSeconds: typeof node.durationSeconds === 'number' ? node.durationSeconds : 0,
    viewCount: typeof node.viewCount === 'number' ? node.viewCount : 0,
    createdAt: node.createdAt ?? '',
    thumbnailUrl: node.thumbnailURL ?? '',
    game: node.game?.displayName ?? node.game?.name ?? '',
    curator: node.curator?.displayName ?? node.curator?.login ?? '',
  }
}

/**
 * Fetch a channel's videos of one broadcast type (ARCHIVE = past broadcasts,
 * HIGHLIGHT = highlights). Returns most-recent-first; empty is a success.
 */
export async function fetchChannelVideos(
  login: string,
  type: VideoBroadcastType,
  signal?: AbortSignal,
): Promise<ChannelVideo[]> {
  const data = await gqlRequest<{
    user?: { videos?: { edges?: ({ node?: RawChannelVideo | null } | null)[] | null } | null } | null
  }>(CHANNEL_VIDEOS_QUERY, { login, first: CHANNEL_VIDEOS_FIRST, type }, signal)
  const edges = data?.user?.videos?.edges ?? []
  const out: ChannelVideo[] = []
  for (const edge of edges) {
    const v = toChannelVideo(edge?.node ?? null)
    if (v) out.push(v)
  }
  return out
}

export type ClipsPeriod = 'ALL_TIME' | 'LAST_WEEK'

/**
 * Fetch a channel's clips. `period` selects ALL_TIME (popular, VIEWS_DESC)
 * or LAST_WEEK (recent, still VIEWS_DESC — CREATED_AT_DESC fails with a
 * server error on anonymous GQL). Empty is a success — many channels have
 * no clips.
 */
export async function fetchChannelClips(
  login: string,
  period: ClipsPeriod = 'ALL_TIME',
  signal?: AbortSignal,
): Promise<ChannelClip[]> {
  const query = `
  query($login: String!, $first: Int!) {
    user(login: $login) {
      clips(first: $first, criteria: { period: ${period}, sort: VIEWS_DESC }) {
        edges {
          node {
            id
            slug
            title
            durationSeconds
            viewCount
            createdAt
            thumbnailURL(width: ${CLIP_THUMB_W}, height: ${CLIP_THUMB_H})
            game {
              id
              name
              displayName
            }
            curator {
              id
              login
              displayName
            }
          }
        }
      }
    }
  }
`
  const data = await gqlRequest<{
    user?: { clips?: { edges?: ({ node?: RawChannelClip | null } | null)[] | null } | null } | null
  }>(query, { login, first: CHANNEL_CLIPS_FIRST }, signal)
  const edges = data?.user?.clips?.edges ?? []
  const out: ChannelClip[] = []
  for (const edge of edges) {
    const c = toChannelClip(edge?.node ?? null)
    if (c) out.push(c)
  }
  return out
}

/**
 * Resolve a clip's direct MP4 media URLs (anonymous). streamlink 8.4.0 cannot
 * resolve clips (PersistedQueryNotFound), so clips play natively from these
 * sourceURLs. Qualities are returned highest-first (1080→360). Throws on an
 * unknown slug or transport failure; the caller surfaces an error.
 */
export async function fetchClipMedia(slug: string, signal?: AbortSignal): Promise<ClipMedia> {
  if (!isValidClipSlug(slug)) throw new Error('invalid clip slug')
  const data = await gqlRequest<{ clip?: RawClipMedia | null }>(
    CLIP_MEDIA_QUERY,
    { slug },
    signal,
  )
  const clip = data?.clip ?? null
  if (!clip || !clip.id) throw new Error('clip not found')
  const qualities: ClipQuality[] = []
  for (const q of clip.videoQualities ?? []) {
    if (q && q.sourceURL && q.quality) {
      qualities.push({
        quality: q.quality,
        frameRate: typeof q.frameRate === 'number' ? q.frameRate : 0,
        sourceUrl: q.sourceURL,
      })
    }
  }
  if (qualities.length === 0) throw new Error('clip has no playable media')
  // Highest numeric quality first (1080 before 360).
  qualities.sort((a, b) => Number(b.quality) - Number(a.quality))
  return {
    id: clip.id,
    title: clip.title ?? '',
    durationSeconds: typeof clip.durationSeconds === 'number' ? clip.durationSeconds : 0,
    qualities,
  }
}
