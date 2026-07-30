/*
 * Global chat-badge refresh (PHASE 2 of generated-baseline badge support).
 *
 * The shipped baseline (src/lib/badges.generated.ts, compiled into the binary)
 * renders every known badge on a cold start / GQL failure. This module updates
 * it in the background: on startup the cached map is installed if fresh, else
 * the baseline (or a stale cache) is used and a refresh is fired off.
 *
 * Resolution order for a GLOBAL badge (per-channel override applied separately
 * at render in App.svelte): cached/refreshed global map -> BASELINE -> drop.
 *
 * Privacy / no-new-host: this hits gql.twitch.tv with the SAME pinned Client-ID
 * already contacted every 150s by favorites polling — no new host, no new
 * identifier, one extra request per WEEK. There is intentionally NO settings
 * toggle (unlike the update check, which added a brand-new host on every
 * startup); the marginal privacy footprint here is negligible.
 *
 * Failures are SILENT (console.warn only) — same discipline as the update
 * check: a failed refresh degrades to the baseline, never to nothing.
 */

import { BASELINE_BADGES, BASELINE_GENERATED_AT } from './badges.generated'
import { setGlobalBadges, type BadgeMeta } from './irc'
import { fetchGlobalBadgeSets, type GlobalBadgeRow } from './gql'

// localStorage cache key + schema version. The cache also stores the
// BASELINE_GENERATED_AT it was built against: if the app ships a newer
// baseline (new badges added), an older cache is discarded on load so the new
// baseline badges show immediately instead of waiting for the weekly refresh.
// Bump BADGE_CACHE_VERSION on any cache SHAPE change; the version + baseline
// checks together mean stale or shape-mismatched data is discarded, never
// crashes the parse.
const BADGE_CACHE_KEY = 'app-badge-cache-v1'
const BADGE_CACHE_VERSION = 1

// Weekly refresh cadence. Global badge art changes rarely; a week balances
// freshness against needless requests. Tuned against the same gql.twitch.tv
// host + pinned Client-ID already hit every 150s by favorites polling.
export const BADGE_REFRESH_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000

interface BadgeCache {
  v: number
  fetchedAt: number
  baselineAt: string
  badges: Record<string, BadgeMeta>
}

// Extract the per-version image UUID from a GQL imageURL
// (https://static-cdn.jtvnw.net/badges/v1/<uuid>/1).
function uuidFromURL(url: string): string | null {
  const m = url.match(/\/badges\/v1\/([0-9a-fA-F-]{36})\//)
  return m ? m[1] : null
}

function prettify(setID: string): string {
  return setID
    .replace(/[_-]+/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .trim()
}

/**
 * Build a fresh global map from GQL rows, INHERITING the baseline's curated
 * labels (and per-version labels) and refreshing UUIDs / adding new sets. The
 * merge starts from a copy of the baseline so legacy alias setIDs (kept only in
 * the baseline, e.g. `artist`, `hype`) survive in the cached map. Baseline
 * entries Twitch no longer serves are harmless to keep — IRC simply won't send
 * them. Exposed for testing.
 */
export function mergeRefreshedBadges(
  baseline: Record<string, BadgeMeta>,
  rows: GlobalBadgeRow[],
): Record<string, BadgeMeta> {
  const grouped = new Map<string, Map<string, string>>()
  for (const r of rows) {
    const uuid = uuidFromURL(r.imageURL)
    if (!uuid) continue
    let byVer = grouped.get(r.setID)
    if (!byVer) {
      byVer = new Map()
      grouped.set(r.setID, byVer)
    }
    byVer.set(r.version, uuid)
  }
  const out: Record<string, BadgeMeta> = { ...baseline }
  for (const [setID, versions] of grouped) {
    const base = baseline[setID]
    const entries = [...versions.entries()]
    const defaultUuid = versions.get('1') ?? entries[0]?.[1]
    if (!defaultUuid) continue
    const meta: BadgeMeta = {
      label: base?.label ?? prettify(setID),
      uuid: defaultUuid,
    }
    if (entries.length > 1) {
      meta.perVersion = Object.fromEntries(entries)
      // Keep the baseline's curated per-version labels; versions not covered
      // fall back to the set label at render time (badgeLabel).
      if (base?.perVersionLabel) meta.perVersionLabel = { ...base.perVersionLabel }
    }
    out[setID] = meta
  }
  return out
}

function isValidCache(c: unknown): c is BadgeCache {
  return (
    !!c &&
    typeof c === 'object' &&
    (c as BadgeCache).v === BADGE_CACHE_VERSION &&
    (c as BadgeCache).baselineAt === BASELINE_GENERATED_AT &&
    typeof (c as BadgeCache).fetchedAt === 'number' &&
    !!(c as BadgeCache).badges &&
    typeof (c as BadgeCache).badges === 'object'
  )
}

function readCache(): BadgeCache | null {
  try {
    const raw = localStorage.getItem(BADGE_CACHE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw)
    return isValidCache(parsed) ? parsed : null
  } catch {
    return null
  }
}

function writeCache(badges: Record<string, BadgeMeta>): void {
  try {
    const cache: BadgeCache = {
      v: BADGE_CACHE_VERSION,
      fetchedAt: Date.now(),
      baselineAt: BASELINE_GENERATED_AT,
      badges,
    }
    localStorage.setItem(BADGE_CACHE_KEY, JSON.stringify(cache))
  } catch {
    // Quota / serialization failure — ignore; the in-memory map is still set.
  }
}

// Guard against overlapping refreshes.
let refreshInFlight = false

async function refreshInBackground(): Promise<void> {
  if (refreshInFlight) return
  refreshInFlight = true
  try {
    const rows = await fetchGlobalBadgeSets()
    const merged = mergeRefreshedBadges(BASELINE_BADGES, rows)
    setGlobalBadges(merged)
    writeCache(merged)
  } catch (e) {
    // Silent (log only): a failed refresh degrades to whatever globalBadges
    // currently holds (baseline or last cache), never to nothing.
    console.warn('[badges] refresh failed, using existing global map', e)
  } finally {
    refreshInFlight = false
  }
}

/**
 * Initialise the global badge map from cache or baseline, then refresh in the
 * background if the cache is older than the weekly interval (or absent / stale
 * relative to the shipped baseline). Never blocks chat rendering or startup —
 * the baseline is already installed (irc.ts initialises globalBadges to it)
 * and the refresh is fire-and-forget. Safe to call once on app mount.
 *
 * A present-but-stale cache is still installed immediately (it beats the
 * baseline), then refreshed. Resolution: cached global map -> baseline -> drop.
 */
export function initBadgeRefresh(): void {
  const cached = readCache()
  const now = Date.now()
  if (cached) {
    setGlobalBadges(cached.badges)
    if (now - cached.fetchedAt >= BADGE_REFRESH_INTERVAL_MS) void refreshInBackground()
    return
  }
  // No valid cache: the baseline is already globalBadges' default; refresh.
  void refreshInBackground()
}

// Exported for tests that need to reset module-level state between cases.
export const __test = { BADGE_CACHE_KEY, BADGE_CACHE_VERSION, isValidCache }
