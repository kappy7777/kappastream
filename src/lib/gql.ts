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
 * error, and GQL is the ONLY data source, so such a failure leaves channels
 * on their last-known status until the next successful poll (see
 * favorites.svelte).
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
// short interval is cheap.
export const GQL_REFRESH_INTERVAL_MS = 150_000

const GQL_TIMEOUT_MS = 8_000

const USER_STATUS_QUERY = `
  query($logins: [String!]) {
    users(logins: $logins) {
      id
      login
      displayName
      profileImageURL(width: 70)
      followers { totalCount }
      stream {
        id
        title
        type
        viewersCount
        createdAt
        previewImageURL
        collaborationViewersCount
        costreamDetails {
          costreamersCount
          totalViewersCount
          topCostreamers {
            profileImageURL(width: 70)
          }
        }
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
  // Numeric Twitch user ID ('' for a nonexistent login). Needed as the key
  // for the collaboration roster query (channel(id:)), which has no
  // login-based variant.
  userId: string
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
  // "for free" in the same request.
  avatarUrl: string
  // Stream Together / costream state (live streams only). `collabViewers` is
  // the COMBINED viewership across the session's channels — non-null means
  // the channel is in a shared session (works for BOTH the guest-star-style
  // sessions and classic costreams). Participants carry it as
  // collaborationViewersCount; an ORGANIZER instead exposes it as
  // costreamDetails.totalViewersCount, so the mapping falls back to that —
  // mirroring how twitch.tv picks the number it displays. The full roster
  // (logins + avatars + roles) is NOT in this response: it lives behind
  // channel(id:).collaboration (see fetchCollaborators) and is fetched
  // separately, so collabOthers=0/collabAvatar='' from THIS mapping means
  // "roster not attached yet", never "not in a session" — check collabViewers.
  collabViewers: number | null
  // Other channels in the session (0 = roster unknown or no session).
  collabOthers: number
  // One co-streamer's avatar for the stacked mini badge ('' when unknown).
  collabAvatar: string
  // Channel follower count (null when the response omits it).
  followers: number | null
}

interface RawUser {
  id: string
  login: string
  displayName: string
  profileImageURL?: string | null
  followers?: { totalCount?: number | null } | null
  stream?: RawStream | null
}

interface RawStream {
  id: string
  title: string
  type: string
  viewersCount: number
  createdAt: string
  previewImageURL?: string | null
  collaborationViewersCount?: number | null
  costreamDetails?: {
    costreamersCount?: number | null
    totalViewersCount?: number | null
    topCostreamers?: ({ profileImageURL?: string | null } | null)[] | null
  } | null
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
 * keep last-known status + back off and retry"; the discovery callers
 * (search/browse) treat it as a visible, non-blocking error state.
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
  // Throws on non-2xx / network / timeout / oversized — string-typed errors.
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
    const reason = parsed?.errors ? gqlErrorReason(parsed.errors) : 'no data'
    throw new Error('gql: ' + reason)
  }
  return parsed.data as T
}

/**
 * Best-effort human reason from a GQL `errors[]` payload (unknown shape).
 * Returns the first entry's `message` when one is present, else a generic
 * label. Surfaced through the thrown Error so discovery callers can show WHY a
 * request failed instead of a bare "failed" — e.g. the real
 * "IntegrityCheckFailed" an anonymous-cursor attempt produces, which previously
 * took a multi-step curl to find because the flat `'gql errors'` hid it.
 */
function gqlErrorReason(errors: unknown): string {
  if (Array.isArray(errors)) {
    for (const e of errors) {
      if (e && typeof e === 'object' && 'message' in e) {
        const msg = (e as { message: unknown }).message
        if (typeof msg === 'string' && msg.length > 0) return msg
      }
    }
  }
  return 'gql errors'
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
      userId: '',
      displayName: '',
      live: false,
      title: '',
      game: '',
      viewersCount: 0,
      startedAt: '',
      thumbnailUrl: '',
      avatarUrl: '',
      collabViewers: null,
      collabOthers: 0,
      collabAvatar: '',
      followers: null,
    }
  }
  const stream = user.stream ?? null
  const details = stream?.costreamDetails ?? null
  // Participants expose the combined count directly; an organizer instead
  // carries it inside costreamDetails.totalViewersCount (its own
  // collaborationViewersCount is null). Mirror twitch.tv's display choice.
  const collabViewers =
    typeof stream?.collaborationViewersCount === 'number' && stream.collaborationViewersCount > 0
      ? stream.collaborationViewersCount
      : typeof details?.totalViewersCount === 'number' && details.totalViewersCount > 0
        ? details.totalViewersCount
        : null
  const collabOthers =
    details && typeof details.costreamersCount === 'number' && details.costreamersCount > 0
      ? details.costreamersCount
      : 0
  let collabAvatar = ''
  for (const c of details?.topCostreamers ?? []) {
    if (c && typeof c.profileImageURL === 'string' && c.profileImageURL) {
      collabAvatar = c.profileImageURL
      break
    }
  }
  const followersTotal = user.followers?.totalCount
  return {
    login: user.login,
    userId: user.id ?? '',
    displayName: user.displayName ?? user.login,
    live: !!stream,
    title: stream?.title ?? '',
    game: stream?.game?.displayName ?? stream?.game?.name ?? '',
    viewersCount: typeof stream?.viewersCount === 'number' ? stream.viewersCount : 0,
    startedAt: stream?.createdAt ?? '',
    thumbnailUrl: stream?.previewImageURL ?? '',
    avatarUrl: user.profileImageURL ?? '',
    collabViewers,
    collabOthers,
    collabAvatar,
    followers: typeof followersTotal === 'number' && Number.isFinite(followersTotal) ? followersTotal : null,
  }
}

/**
 * Resolve Twitch user IDs for a set of logins in one batched request (per
 * GQL_BATCH_SIZE logins). Used by emotes.ts to turn a channel login into the
 * numeric ID the 7TV/BTTV/FFZ channel endpoints expect. Nonexistent logins
 * (null entries) are omitted from the returned map.
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
    // A short `users` array (fewer entries than requested) is anomalous — a
    // legitimate batch always returns one positional entry per login (null for
    // unknown). Zipping positionally with `users[i] ?? null` would silently mark
    // every unreturned channel offline; throw so the caller treats it as a
    // transport failure (favorites keeps last-known status) rather than
    // committing a wrong status. (Note: `{"data":null}` is already rejected
    // upstream in gqlRequest via the `data === null` check.)
    if (users.length !== batch.length) {
      throw new Error('gql short response')
    }
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
 * GQL-ONLY and anonymous throughout (same public Client-ID, no auth). On
 * transport failure these throw and the caller must surface a visible,
 * non-blocking error state. An empty result set is ALWAYS a success (matches
 * the offline-vs-failure discipline above): never report "no results" when the
 * request actually errored.
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
 * Same anonymous + GQL-only transport as discovery. Like discovery, `after`
 * cursors are unusable (IntegrityCheckFailed), so each list over-fetches its
 * hard cap (100) in ONE request and the caller reveals more client-side (see
 * browse-reveal.ts). Empty is a SUCCESS.
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

/*
 * ============================================================================
 * VOD chat replay — past-broadcast comments, synced to the playhead.
 *
 * Same anonymous + GQL-only transport as everything above (same pinned
 * Client-ID, no new host). Cursor paging (`after`) is integrity-blocked and
 * `first`/`last` are ignored, so the ONLY useful argument is
 * `contentOffsetSeconds` — an anchor offset whose page is a contiguous slice of
 * the comment total-order. See `src/lib/vodchat.svelte.ts` for the measured
 * advance rule (`nextOffset = lastCommentOffset + 1`) and the sync engine.
 *
 * Field/argument names verified against the live endpoint:
 *   - comments(contentOffsetSeconds: Int!) — the argument is Int (a Float
 *     variable is rejected), and every returned contentOffsetSeconds is a whole
 *     number, so the offset advance is exact.
 *   - the message body is the concatenation of fragments[].text (there is no
 *     single `body`/`text` field on VideoCommentMessage); an emote fragment
 *     carries emote.emoteID.
 *   - pageInfo.hasNextPage is ALWAYS true (even past the VOD end) and so is
 *     useless — the engine pages until an EMPTY result instead.
 * ============================================================================
 */

export interface VodCommentNode {
  id: string
  // Broadcast-relative seconds (matches the playhead for unmuted VODs).
  contentOffsetSeconds: number
  createdAt: string
  commenter: { id: string; login: string; displayName: string } | null
  message: {
    userColor: string | null
    userBadges: { setID: string; version: string }[]
    fragments: { text: string; emote: { emoteID: string } | null }[]
  } | null
}

const VOD_COMMENTS_QUERY = `
  query($videoID: ID!, $offset: Int!) {
    video(id: $videoID) {
      id
      comments(contentOffsetSeconds: $offset) {
        edges {
          node {
            id
            contentOffsetSeconds
            createdAt
            commenter { id login displayName }
            message {
              userColor
              userBadges { setID version }
              fragments { text emote { emoteID } }
            }
          }
        }
      }
    }
  }
`

interface RawVodMessage {
  userColor?: string | null
  userBadges?: ({ setID?: string; version?: string } | null)[] | null
  fragments?: ({ text?: string | null; emote?: { emoteID?: string | null } | null } | null)[] | null
}
interface RawVodCommentNode {
  id?: string
  contentOffsetSeconds?: number
  createdAt?: string
  commenter?: { id?: string; login?: string; displayName?: string } | null
  message?: RawVodMessage | null
}

/**
 * Fetch one comment page anchored at a broadcast offset. Returns the raw nodes
 * (transport only — normalization to ParsedMessage lives in vodchat.svelte.ts).
 * An empty result is a SUCCESS (offset past the last comment / quiet VOD); the
 * sync engine treats an empty page as end-of-comments. Throws on transport
 * failure (network / non-2xx / timeout / top-level GQL errors / abort).
 *
 * Measured page size with the full selection set is ~32 KB max (cap 256 KB →
 * 8× headroom), so a page always fits comfortably.
 */
export async function fetchVodCommentPage(
  videoId: string,
  offset: number,
  signal?: AbortSignal,
): Promise<VodCommentNode[]> {
  const data = await gqlRequest<{
    video?: { comments?: { edges?: ({ node?: RawVodCommentNode | null } | null)[] | null } | null } | null
  }>(VOD_COMMENTS_QUERY, { videoID: videoId, offset }, signal)
  const edges = data?.video?.comments?.edges ?? []
  const out: VodCommentNode[] = []
  for (const edge of edges) {
    const n = edge?.node ?? null
    if (!n || !n.id) continue
    const commenter =
      n.commenter && n.commenter.login
        ? {
            id: n.commenter.id ?? '',
            login: n.commenter.login,
            displayName: n.commenter.displayName ?? n.commenter.login,
          }
        : null
    const rawBadges = n.message?.userBadges ?? []
    const userBadges: { setID: string; version: string }[] = []
    for (const b of rawBadges) {
      if (b && b.setID) userBadges.push({ setID: b.setID, version: b.version ?? '' })
    }
    const rawFragments = n.message?.fragments ?? []
    const fragments: { text: string; emote: { emoteID: string } | null }[] = []
    for (const f of rawFragments) {
      if (!f) continue
      const eid = f.emote?.emoteID
      fragments.push({ text: f.text ?? '', emote: eid ? { emoteID: eid } : null })
    }
    const message = n.message
      ? { userColor: n.message.userColor ?? null, userBadges, fragments }
      : null
    out.push({
      id: n.id,
      contentOffsetSeconds: typeof n.contentOffsetSeconds === 'number' ? n.contentOffsetSeconds : 0,
      createdAt: n.createdAt ?? '',
      commenter,
      message,
    })
  }
  return out
}

/*
 * ============================================================================
 * Chat badges — global refresh + per-channel custom art.
 *
 * Same anonymous + GQL-only transport as everything above (same pinned
 * Client-ID, no new host). Two INDEPENDENT queries, both deliberately kept OFF
 * the batched `USER_STATUS_QUERY` used by favorites polling:
 *
 *   - GLOBAL (Query.badges): every global chat-badge set. ~74 KB, well under
 *     the gql_fetch 256 KB cap (measured via the real path; see
 *     scripts/generate-badges.mjs). Powers the weekly in-app refresh
 *     (src/lib/badges.svelte.ts) on top of the shipped baseline. Must NOT ride
 *     the favorites batch — it's a single big response, not per-channel.
 *
 *   - PER-CHANNEL (User.broadcastBadges): one channel's custom subscriber /
 *     founder art. A SEPARATE single-channel request so the 1000-channel
 *     favorites batch never carries broadcastBadges (which would blow the cap).
 *     fetchLiveStatus still uses the shared batch path unchanged.
 * ============================================================================
 */

/** One global badge version row from `Query.badges`. */
export interface GlobalBadgeRow {
  setID: string
  version: string
  title: string
  imageURL: string
}

const GLOBAL_BADGES_QUERY = `
  query {
    badges {
      setID
      version
      title
      imageURL(size: NORMAL)
    }
  }
`

/**
 * Fetch every global chat-badge set Twitch serves today. Used by the weekly
 * in-app badge refresh to update UUIDs / add new sets on top of the shipped
 * baseline. Throws on transport failure; the caller fails silently and falls
 * back to the baseline.
 */
export async function fetchGlobalBadgeSets(signal?: AbortSignal): Promise<GlobalBadgeRow[]> {
  const data = await gqlRequest<{
    badges?: ({ setID?: string; version?: string; title?: string; imageURL?: string } | null)[] | null
  }>(GLOBAL_BADGES_QUERY, {}, signal)
  const rows: GlobalBadgeRow[] = []
  for (const b of data?.badges ?? []) {
    if (!b || !b.setID || b.version == null || !b.imageURL) continue
    rows.push({ setID: b.setID, version: String(b.version), title: b.title ?? '', imageURL: b.imageURL })
  }
  return rows
}

const CHANNEL_BADGES_QUERY = `
  query($login: String!) {
    user(login: $login) {
      broadcastBadges {
        setID
        version
        imageURL(size: NORMAL)
      }
    }
  }
`

/**
 * Fetch a channel's custom chat badges (subscriber / founder / etc. art) via
 * `User.broadcastBadges`. Returns setID -> { version -> image uuid }, used as a
 * per-channel RENDER-TIME override on top of the global map. SEPARATE from the
 * batched favorites query (USER_STATUS_QUERY is untouched). `title` is omitted:
 * the override only swaps the image; the label still comes from the global map.
 * Throws on transport failure; the caller leaves the override empty so the
 * global default shows.
 */
export async function fetchChannelBadges(
  login: string,
  signal?: AbortSignal,
): Promise<Record<string, Record<string, string>>> {
  const data = await gqlRequest<{
    user?: { broadcastBadges?: ({ setID?: string; version?: string; imageURL?: string } | null)[] | null } | null
  }>(CHANNEL_BADGES_QUERY, { login }, signal)
  const out: Record<string, Record<string, string>> = {}
  for (const b of data?.user?.broadcastBadges ?? []) {
    if (!b || !b.setID || b.version == null || !b.imageURL) continue
    const m = b.imageURL.match(/\/badges\/v1\/([0-9a-fA-F-]{36})\//)
    if (!m) continue
    const byVer = out[b.setID] ?? (out[b.setID] = {})
    byVer[String(b.version)] = m[1]
  }
  return out
}

/*
 * ============================================================================
 * VOD playback extras — chapters, muted segments, seek-hover storyboard URL.
 *
 * One lightweight per-VOD query. Field/argument names verified against the
 * live endpoint (2026-08-20); note two places the live schema has DRIFTED
 * from the community schema dump used elsewhere in this file:
 *   - `moments` requires `momentRequestType: VIDEO_CHAPTER_MARKERS` to return
 *     the viewer-facing chapter list (without it the field "server error"s;
 *     HIGHLIGHTER_SUGGESTIONS is the creator-side variant).
 *   - `muteInfo.mutedSegmentConnection` exposes `nodes` (no pagination), NOT
 *     `edges`.
 * A chapter's label prefers the moment description, then the game-change
 * game name, then a positional fallback. All extras are OPTIONAL data: the
 * caller fails silently and the scrubber simply renders without them.
 * ============================================================================
 */

export interface VodChapter {
  // Whole seconds from VOD start where the chapter begins.
  startSec: number
  label: string
}

export interface VodMuteSpan {
  startSec: number
  endSec: number
}

export interface VideoExtras {
  chapters: VodChapter[]
  mutedSpans: VodMuteSpan[]
  // Storyboard document URL (see vod-extras.ts); null when Twitch served none.
  seekPreviewsUrl: string | null
}

interface RawMomentDetails {
  game?: { displayName?: string | null } | null
}

interface RawMomentNode {
  positionMilliseconds?: number | null
  description?: string | null
  details?: RawMomentDetails | null
}

interface RawMutedSegment {
  duration?: number | null
  offset?: number | null
}

interface RawVideoExtras {
  seekPreviewsURL?: string | null
  muteInfo?: {
    mutedSegmentConnection?: { nodes?: (RawMutedSegment | null)[] | null } | null
  } | null
  moments?: { edges?: ({ node?: RawMomentNode | null } | null)[] | null } | null
}

const VIDEO_EXTRAS_QUERY = `
  query($id: ID!) {
    video(id: $id) {
      id
      seekPreviewsURL
      muteInfo {
        mutedSegmentConnection {
          nodes { duration offset }
        }
      }
      moments(first: 100, momentRequestType: VIDEO_CHAPTER_MARKERS) {
        edges {
          node {
            type
            positionMilliseconds
            durationMilliseconds
            description
            details {
              ... on GameChangeMomentDetails { game { displayName } }
            }
          }
        }
      }
    }
  }
`

// VOD ids are numeric strings (e.g. "2849957264"). Validated before the id is
// sent in a GQL variable so a malformed/external value can never be issued.
const VOD_ID_RE = /^\d{1,20}$/

export function isValidVodId(id: string): boolean {
  return VOD_ID_RE.test(id)
}

function toVodExtras(raw: RawVideoExtras | null | undefined): VideoExtras {
  const chapters: VodChapter[] = []
  let i = 0
  for (const edge of raw?.moments?.edges ?? []) {
    const n = edge?.node
    i++
    if (!n) continue
    const startMs = typeof n.positionMilliseconds === 'number' ? n.positionMilliseconds : NaN
    if (!Number.isFinite(startMs) || startMs < 0) continue
    const label =
      (typeof n.description === 'string' && n.description.trim()) ||
      n.details?.game?.displayName?.trim() ||
      ''
    chapters.push({ startSec: Math.floor(startMs / 1000), label: label || `Chapter ${i}` })
  }
  chapters.sort((a, b) => a.startSec - b.startSec)
  const mutedSpans: VodMuteSpan[] = []
  for (const seg of raw?.muteInfo?.mutedSegmentConnection?.nodes ?? []) {
    const offset = typeof seg?.offset === 'number' ? seg.offset : NaN
    const duration = typeof seg?.duration === 'number' ? seg.duration : NaN
    if (!Number.isFinite(offset) || !Number.isFinite(duration) || duration <= 0 || offset < 0) continue
    mutedSpans.push({ startSec: Math.floor(offset), endSec: Math.floor(offset + duration) })
  }
  mutedSpans.sort((a, b) => a.startSec - b.startSec)
  return {
    chapters,
    mutedSpans,
    seekPreviewsUrl: typeof raw?.seekPreviewsURL === 'string' && raw.seekPreviewsURL ? raw.seekPreviewsURL : null,
  }
}

/**
 * Fetch a VOD's chapter markers, muted segments, and seek-hover storyboard
 * URL in one request. Throws on transport failure; the caller treats every
 * extra as optional (no chapters/mutes/previews is a valid render state).
 */
export async function fetchVideoExtras(
  videoId: string,
  signal?: AbortSignal,
): Promise<VideoExtras> {
  if (!isValidVodId(videoId)) throw new Error('invalid vod id')
  const data = await gqlRequest<{ video?: RawVideoExtras | null }>(
    VIDEO_EXTRAS_QUERY,
    { id: videoId },
    signal,
  )
  return toVodExtras(data?.video ?? null)
}


/*
 * ============================================================================
 * Stream Together / costream collaboration roster.
 *
 * The full participant list (logins, display names, avatars, roles) is NOT
 * part of the users(logins:) status batch — it lives behind the
 * `channel(id:).collaboration` field, the operation the twitch.tv channel
 * page itself uses (CollaboratorListQuery in the web client). It is fully
 * anonymous: verified live 2026-08-21 on an active Stream Together session
 * (ronnyberger + nicistemmler) with the plain anonymous Client-ID.
 *
 * The field takes a numeric channel ID (no login variant), so callers pass
 * ChannelStatus.userId. Multiple channels are fetched in ONE request via
 * GraphQL aliases (c0:, c1:, ... — also verified live). A channel that is
 * not in a session returns collaboration: null, which is simply absent from
 * the result map.
 */

export interface Collaborator {
  login: string
  displayName: string
  avatarUrl: string
  role: string
}

// Cap aliases per request so one huge favorites list can't build a giant
// document; realistically a poll has at most a handful of session channels.
const COLLABORATION_CHUNK = 30

interface RawCollaborator {
  role?: string | null
  status?: string | null
  user?: {
    login?: string | null
    displayName?: string | null
    profileImageURL?: string | null
  } | null
}

const CHANNEL_ID_RE = /^\d{1,20}$/

function collaborationQuery(count: number): string {
  const fields: string[] = []
  for (let i = 0; i < count; i++) {
    fields.push(
      `c${i}: channel(id: $id${i}) { collaboration { collaborators { role status user { login displayName profileImageURL(width: 70) } } } }`,
    )
  }
  const vars: string[] = []
  for (let i = 0; i < count; i++) vars.push(`$id${i}: ID!`)
  return `query CollaborationRoster(${vars.join(', ')}) { ${fields.join(' ')} }`
}

/**
 * Fetch the ACTIVE collaboration roster for each channel ID in one batched
 * (aliased) request per 30 IDs. Returns a map channelId -> collaborators
 * (self included); channels without an active session are absent. Throws on
 * transport failure — callers treat that as "no roster" (never as an outage
 * of the main status poll).
 */
export async function fetchCollaborators(
  channelIds: string[],
  signal?: AbortSignal,
): Promise<Map<string, Collaborator[]>> {
  const out = new Map<string, Collaborator[]>()
  const ids = channelIds.filter((id) => CHANNEL_ID_RE.test(id))
  for (const group of chunk(ids, COLLABORATION_CHUNK)) {
    const variables: Record<string, string> = {}
    group.forEach((id, i) => {
      variables[`id${i}`] = id
    })
    const data = await gqlRequest<Record<string, { collaboration?: { collaborators?: (RawCollaborator | null)[] | null } | null } | null>>(
      collaborationQuery(group.length),
      variables,
      signal,
    )
    group.forEach((id, i) => {
      const collaborators = data?.[`c${i}`]?.collaboration?.collaborators ?? []
      const members: Collaborator[] = []
      for (const c of collaborators) {
        if (!c || c.status !== 'ACTIVE' || !c.user?.login) continue
        members.push({
          login: c.user.login,
          displayName: c.user.displayName ?? c.user.login,
          avatarUrl: c.user.profileImageURL ?? '',
          role: c.role ?? '',
        })
      }
      if (members.length > 0) out.set(id, members)
    })
  }
  return out
}
