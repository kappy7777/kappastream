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

interface GqlResponse {
  data?: { users?: (RawUser | null)[] | null } | null
  errors?: unknown
}

/**
 * POST one query body to gql_fetch. Throws on ANY transport-level problem
 * (network error, non-2xx, malformed JSON, top-level GQL `errors`). The caller
 * (favorites) treats a throw as "GQL unavailable → DecAPI fallback".
 */
async function gqlRequest(
  query: string,
  variables: { logins: string[] },
  signal?: AbortSignal,
): Promise<GqlResponse['data']> {
  if (signal?.aborted) throw new Error('aborted')
  const body = JSON.stringify({ query, variables })
  // Throws on non-2xx / network / timeout / oversized — same string-typed
  // error convention as decapi_fetch.
  const raw = await invoke<string>('gql_fetch', { body, timeoutMs: GQL_TIMEOUT_MS })
  let parsed: GqlResponse
  try {
    parsed = JSON.parse(raw) as GqlResponse
  } catch {
    throw new Error('malformed gql response')
  }
  // A 200 with a top-level `errors` array means the query itself failed to
  // execute (schema drift, persistent-query issue, rate limit, …) — treat it
  // as a transport failure so the caller falls back rather than showing stale.
  if (!parsed || parsed.errors || typeof parsed.data !== 'object') {
    throw new Error('gql errors')
  }
  return parsed.data
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
    const data = await gqlRequest(USER_ID_QUERY, { logins: batch }, signal)
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
    const data = await gqlRequest(USER_STATUS_QUERY, { logins: batch }, signal)
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
