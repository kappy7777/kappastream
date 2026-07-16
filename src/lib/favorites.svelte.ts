import { invoke, isTauri } from '@tauri-apps/api/core'
import { settings } from './settings.svelte.ts'
import { notifications } from './notifications.svelte.ts'

export interface FavoriteEntry {
  name: string
  addedAt: number
  order: number
}

export type LiveStatus =
  | { state: 'unknown' }
  | { state: 'live'; title: string; viewers: number; uptime: string; game: string; avatarUrl: string }
  | { state: 'offline'; avatarUrl: string }
  | { state: 'error'; message: string }

export interface FavoriteStatus {
  name: string
  status: LiveStatus
  lastFetched: number | null
  lastError: string | null
  updateDelayed: boolean
}

const STORAGE_KEY = 'twitch-favorites-v1'
const STATUS_CACHE_KEY = 'fav-status-cache-v1'
const STATUS_CACHE_TS_KEY = 'fav-status-cache-ts-v1'
const STATUS_CACHE_MAX_AGE_MS = 60 * 60 * 1000
const NOTIF_CHANNELS_KEY = 'fav-notif-channels-v1'
export const MAX_FAVORITES = 100

const POLL_INTERVAL_MS = 600_000
const OFFLINE_INITIAL_POLL_INTERVAL_MS = 120_000
// Small spread between channels at startup / on poll. The global DecAPI
// limiter (MIN_FETCH_GAP_MS) serializes all requests, so this no longer gates
// total sync time — it only avoids spawning every channel's async chain in the
// same tick and keeps the limiter queue from being slammed all at once (which
// would starve user-triggered refreshes for the whole drain window). Kept
// small so the tail channel doesn't wait minutes merely to *start*.
const PER_FAV_STAGGER_MS = 200
const REQUEST_TIMEOUT_MS = 8_000
const METADATA_REFRESH_MS = 10 * 60 * 1000
const NOTIFY_STARTUP_GRACE_MS = 10 * 60 * 1000
const CIRCUIT_BREAKER_MS = 30_000
const RETRY_TIMEOUT_MS = 3_000
const RETRY_DELAYS_MS: readonly number[] = [2_000, 5_000, 15_000, 30_000, 60_000, 120_000, 300_000]
const CONSECUTIVE_FAILURES_FOR_STALE = RETRY_DELAYS_MS.length + 1
const RETRY_JITTER_MS = 5_000

export const CHANNEL_NAME_RE = /^[a-z0-9_]{1,25}$/

export function normalizeChannelName(raw: string): string {
  return raw.trim().replace(/^#/, '').toLowerCase()
}

export function isValidChannelName(name: string): boolean {
  return CHANNEL_NAME_RE.test(name)
}

function loadFromStorage(): FavoriteEntry[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed)) return []
    const out: FavoriteEntry[] = []
    const seen = new Set<string>()
    for (const item of parsed) {
      if (
        item && typeof item === 'object' &&
        typeof (item as FavoriteEntry).name === 'string' &&
        typeof (item as FavoriteEntry).addedAt === 'number' &&
        isValidChannelName((item as FavoriteEntry).name)
      ) {
        const name = (item as FavoriteEntry).name
        if (seen.has(name)) continue
        seen.add(name)
        out.push({
          name,
          addedAt: (item as FavoriteEntry).addedAt,
          order: typeof (item as FavoriteEntry).order === 'number' ? (item as FavoriteEntry).order : (item as FavoriteEntry).addedAt,
        })
        if (out.length >= MAX_FAVORITES) break
      }
    }
    return out
  } catch {
    return []
  }
}

function saveToStorage(favorites: FavoriteEntry[]): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(favorites))
  } catch {
    /* quota or disabled */
  }
}

function isLiveOrOfflineStatus(s: unknown): boolean {
  return !!s && typeof s === 'object' && ((s as { state?: unknown }).state === 'live' || (s as { state?: unknown }).state === 'offline')
}

function loadStatusCache(): Map<string, FavoriteStatus> {
  const out = new Map<string, FavoriteStatus>()
  try {
    const tsRaw = localStorage.getItem(STATUS_CACHE_TS_KEY)
    const ts = tsRaw ? parseInt(tsRaw, 10) : NaN
    if (!Number.isFinite(ts) || Date.now() - ts > STATUS_CACHE_MAX_AGE_MS) {
      return out
    }
    const raw = localStorage.getItem(STATUS_CACHE_KEY)
    if (!raw) return out
    const parsed = JSON.parse(raw) as unknown
    if (!parsed || typeof parsed !== 'object') return out
    for (const [name, entry] of Object.entries(parsed as Record<string, unknown>)) {
      if (
        entry && typeof entry === 'object' &&
        typeof (entry as FavoriteStatus).name === 'string' &&
        isValidChannelName((entry as FavoriteStatus).name) &&
        isLiveOrOfflineStatus((entry as FavoriteStatus).status)
      ) {
        out.set(name, {
          name,
          status: (entry as FavoriteStatus).status,
          lastFetched: typeof (entry as FavoriteStatus).lastFetched === 'number'
            ? (entry as FavoriteStatus).lastFetched
            : Date.now(),
          lastError: null,
          updateDelayed: false,
        })
      }
    }
  } catch {
    /* ignore */
  }
  return out
}

function saveStatusCache(statuses: Map<string, FavoriteStatus>): void {
  try {
    const obj: Record<string, unknown> = {}
    for (const [name, s] of statuses) {
      if (s.status.state === 'live' || s.status.state === 'offline') {
        obj[name] = {
          name: s.name,
          status: s.status,
          lastFetched: s.lastFetched,
        }
      }
    }
    localStorage.setItem(STATUS_CACHE_KEY, JSON.stringify(obj))
    localStorage.setItem(STATUS_CACHE_TS_KEY, String(Date.now()))
  } catch {
    /* quota or disabled */
  }
}

function loadNotifChannels(): Set<string> {
  const set = new Set<string>()
  try {
    const raw = localStorage.getItem(NOTIF_CHANNELS_KEY)
    if (!raw) return set
    const parsed = JSON.parse(raw) as unknown
    if (Array.isArray(parsed)) {
      for (const name of parsed) {
        if (typeof name === 'string' && isValidChannelName(name)) {
          set.add(name)
        }
      }
    }
  } catch {
    /* ignore */
  }
  return set
}

function saveNotifChannels(set: Set<string>): void {
  try {
    localStorage.setItem(NOTIF_CHANNELS_KEY, JSON.stringify([...set]))
  } catch {
    /* quota or disabled */
  }
}

// Minimum gap between consecutive DecAPI requests, serialized globally via
// waitForFetchSlot(). DecAPI documents a limit of ~100 requests / 60s across
// /twitch/* endpoints. A strict minimum inter-request gap provably bounds the
// rate over ANY window (≤ floor(60000/GAP)+1 per 60s), including bursts, which
// a token bucket would NOT — and bursts are exactly what was tripping 429s.
// 650ms → ≤ ~92 req/min.
//
// SCOPE: this limiter covers ALL favorites traffic (polling, metadata,
// retries, manual refreshes). It does NOT cover emotes.ts' getTwitchUserId()
// (`/twitch/id/<user>`), which calls `invoke('decapi_fetch')` directly — that
// fires ~once per channel-join (not per favorite), so its volume is negligible
// against the ~8 req/min headroom here. Do not assume this makes the *whole
// app* provably under the limit; it makes the favorites burst safe and leaves
// generous room for the occasional bypass call.
const MIN_FETCH_GAP_MS = 650
let lastFetchAt = 0
let fetchThrottle = Promise.resolve()

async function waitForFetchSlot(): Promise<void> {
  const turn = fetchThrottle.then(async () => {
    const wait = Math.max(0, lastFetchAt + MIN_FETCH_GAP_MS - Date.now())
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait))
    lastFetchAt = Date.now()
  })
  fetchThrottle = turn.catch(() => { /* keep the queue usable */ })
  await turn
}

async function fetchText(path: string, timeoutMs: number = REQUEST_TIMEOUT_MS): Promise<string> {
  // Global rate limiter — serializes ALL DecAPI traffic (favorites polling,
  // metadata, retries, manual refreshes) so the combined request rate stays
  // safely below DecAPI's ~100 req/60s limit (see MIN_FETCH_GAP_MS).
  await waitForFetchSlot()

  // All DecAPI calls go through the Rust `decapi_fetch` command. The
  // direct fetch() path was removed when the browser build was dropped:
  // even in Tauri, `fetch()` against decapi.me is blocked by CORS when
  // DecAPI returns 429 (no Access-Control-Allow-Origin for
  // tauri://localhost). The Rust proxy uses reqwest and bypasses CORS.
  const trimmed = path.replace(/^\/+/, '')
  try {
    const result = await invoke<string>('decapi_fetch', { path: trimmed, timeoutMs })
    return result
  } catch (err) {
    const msg = typeof err === 'string' ? err : (err as Error)?.message ?? 'invoke failed'
    throw new Error(msg)
  }
}

function isOfflineMessage(channel: string, body: string): boolean {
  return body.toLowerCase().endsWith(channel.toLowerCase() + ' is offline')
}

export interface FetchLiveStatusOptions {
  cachedAvatarUrl?: string
  fetchMetadata?: boolean
  timeoutMs?: number
}

export async function fetchLiveStatus(
  channel: string,
  options?: FetchLiveStatusOptions,
): Promise<LiveStatus> {
  // Atomic live/offline resolution used by App.svelte for the ACTIVE channel
  // (a single, user-driven fetch where waiting for avatar/metadata is fine).
  // The favorites store does NOT use this — it classifies via uptime first
  // and commits status before launching cosmetic enrichment (see fetchOne() +
  // enrich()). Kept for order: uptime -> avatar -> live metadata.
  const timeoutMs = options?.timeoutMs ?? REQUEST_TIMEOUT_MS
  let avatarUrl = options?.cachedAvatarUrl ?? ''

  // 1) Determine live/offline FIRST. This is the status users actually need,
  //    and it must not be queued behind (or blocked by) a cosmetic avatar
  //    request. If uptime fails we bail before fetching anything else, which
  //    also saves a request on the failure path.
  let uptimeBody: string
  try {
    uptimeBody = await fetchText('/twitch/uptime/' + channel, timeoutMs)
  } catch (err) {
    return { state: 'error', message: 'uptime: ' + (err as Error).message }
  }

  const offline = isOfflineMessage(channel, uptimeBody)

  // 2) Avatar only if not already cached. It's non-essential and fetched
  //    after status is known so it can never delay live/offline resolution.
  if (!avatarUrl) {
    try {
      avatarUrl = await fetchText('/twitch/avatar/' + channel, timeoutMs)
    } catch (_e) {
      /* avatar is non-essential */
    }
  }

  if (offline) {
    return { state: 'offline', avatarUrl }
  }

  if (options?.fetchMetadata === false) {
    return { state: 'live', title: '', viewers: 0, uptime: uptimeBody, game: '', avatarUrl }
  }

  // 3) Live-only metadata (title/viewers/game). Partial failures leave the
  // field at its default (this is the atomic active-channel path).
  let title = ''
  let viewers = 0
  let game = ''

  const results = await Promise.allSettled([
    fetchText('/twitch/title/' + channel, timeoutMs),
    fetchText('/twitch/viewercount/' + channel, timeoutMs),
    fetchText('/twitch/game/' + channel, timeoutMs),
  ])
  if (results[0].status === 'fulfilled') title = results[0].value
  if (results[1].status === 'fulfilled') {
    const v = parseInt(results[1].value, 10)
    viewers = Number.isFinite(v) ? v : 0
  }
  if (results[2].status === 'fulfilled') game = results[2].value

  return {
    state: 'live',
    title,
    viewers,
    uptime: uptimeBody,
    game,
    avatarUrl,
  }
}

export type StatusListener = (snapshot: FavoriteStatus[]) => void

export class FavoritesStore {
  private entries: FavoriteEntry[] = []
  private statuses = new Map<string, FavoriteStatus>()
  private listeners = new Set<StatusListener>()
  private pollTimer: ReturnType<typeof setTimeout> | null = null
  private inFlight = new Map<string, number>()
  private entryVersions = new Map<string, number>()
  private disposed = false
  private notifChannels: Set<string> = new Set()
  private consecutiveFailures: Map<string, number> = new Map()
  private retryTimers: Map<string, ReturnType<typeof setTimeout>> = new Map()
  private avatarCache: Map<string, string> = new Map()
  private metadataCache: Map<string, { title: string; viewers: number; game: string }> = new Map()
  private metadataFetchedAt: Map<string, number> = new Map()
  private decapiCooldownUntil = 0
  private circuitBreakerStreak = 0
  private readonly startedAt = Date.now()
  // Enrichment (avatar + live metadata) is decoupled from status
  // classification and split into two independent task types so a deferred
  // batch can prioritize them: live metadata first, then avatars. Each type
  // has its own in-flight guard (a channel may have metadata and avatar
  // enrichment queued concurrently without one cancelling the other).
  private metadataInFlight = new Set<string>()
  private avatarInFlight = new Set<string>()
  // During the initial startup classification pass, enrichment is deferred so
  // every channel's uptime request is queued ahead of cosmetic avatar /
  // metadata requests (the limiter is FIFO). Once all initial classifications
  // settle, the deferred enrichment is flushed.
  private classifyBatchPending = 0
  private deferredEnrich = new Map<string, number>()

  rateLimited: boolean = $state(false)

  constructor() {
    this.entries = loadFromStorage()
    this.notifChannels = loadNotifChannels()
    const cached = loadStatusCache()
    for (const e of this.entries) {
      this.entryVersions.set(e.name, 1)
      const c = cached.get(e.name)
      if (c) {
        this.statuses.set(e.name, c)
        // Reuse persisted avatar + live metadata so the first poll after
        // restart does not re-request them. The status cache is at most
        // STATUS_CACHE_MAX_AGE_MS (1h) old, so these are fresh enough to show
        // immediately; live metadata is refreshed again after
        // METADATA_REFRESH_MS via shouldFetchMetadata().
        const cs = c.status
        if ((cs.state === 'live' || cs.state === 'offline') && cs.avatarUrl) {
          this.avatarCache.set(e.name, cs.avatarUrl)
        }
        if (cs.state === 'live') {
          this.metadataCache.set(e.name, { title: cs.title, viewers: cs.viewers, game: cs.game })
          this.metadataFetchedAt.set(e.name, c.lastFetched ?? Date.now())
        }
      } else {
        this.statuses.set(e.name, {
          name: e.name,
          status: { state: 'unknown' },
          lastFetched: null,
          lastError: null,
          updateDelayed: false,
        })
      }
    }
  }

  snapshot(): FavoriteStatus[] {
    const byName = new Map<string, FavoriteStatus>()
    for (const e of this.entries) {
      const s = this.statuses.get(e.name)
      if (s) byName.set(e.name, s)
    }
    const arr = Array.from(byName.values())
    arr.sort((a, b) => {
      const aLive = a.status.state === 'live' ? 0 : 1
      const bLive = b.status.state === 'live' ? 0 : 1
      if (aLive !== bLive) return aLive - bLive
      const ea = this.entries.find((e) => e.name === a.name)
      const eb = this.entries.find((e) => e.name === b.name)
      if (settings.sortMode === 'auto') {
        if (aLive === 0) {
          const av = a.status.state === 'live' ? a.status.viewers : 0
          const bv = b.status.state === 'live' ? b.status.viewers : 0
          if (bv !== av) return bv - av
        }
      } else {
        const oa = ea?.order ?? 0
        const ob = eb?.order ?? 0
        if (oa !== ob) return oa - ob
      }
      return a.name.localeCompare(b.name)
    })
    return arr
  }

  subscribe(fn: StatusListener): () => void {
    this.listeners.add(fn)
    fn(this.snapshot())
    return () => {
      this.listeners.delete(fn)
    }
  }

  private notify(): void {
    const snap = this.snapshot()
    for (const fn of this.listeners) fn(snap)
  }

  refresh(): void {
    this.notify()
  }

  retryFetch(name: string): void {
    if (this.disposed) return
    const n = normalizeChannelName(name)
    if (!isValidChannelName(n)) return
    if (!this.has(n) || this.inFlight.get(n) === this.entryVersions.get(n)) return
    this.consecutiveFailures.delete(n)
    this.clearRetryTimer(n)
    void this.fetchOne(n, 0, true)
  }

  has(name: string): boolean {
    return this.entries.some((e) => e.name === name)
  }

  add(name: string): boolean {
    const n = normalizeChannelName(name)
    if (!isValidChannelName(n)) return false
    if (this.has(n)) return false
    if (this.entries.length >= MAX_FAVORITES) return false
    const now = Date.now()
    this.entryVersions.set(n, (this.entryVersions.get(n) ?? 0) + 1)
    this.entries = [...this.entries, { name: n, addedAt: now, order: now }]
    saveToStorage(this.entries)
    this.statuses.set(n, {
      name: n,
      status: { state: 'unknown' },
      lastFetched: null,
      lastError: null,
      updateDelayed: false,
    })
    this.consecutiveFailures.delete(n)
    this.clearRetryTimer(n)
    this.notify()
    void this.fetchOne(n, 0)
    this.scheduleNextPoll()
    return true
  }

  reorder(fromName: string, toName: string): void {
    const from = this.entries.findIndex((e) => e.name === fromName)
    const to = this.entries.findIndex((e) => e.name === toName)
    if (from === -1 || to === -1 || from === to) return
    const next = [...this.entries]
    const [moved] = next.splice(from, 1)
    next.splice(to, 0, moved)
    next.forEach((e, i) => { e.order = i + 1 })
    this.entries = next
    saveToStorage(this.entries)
    this.notify()
  }

  remove(name: string): void {
    const n = normalizeChannelName(name)
    this.entryVersions.set(n, (this.entryVersions.get(n) ?? 0) + 1)
    this.entries = this.entries.filter((e) => e.name !== n)
    saveToStorage(this.entries)
    this.statuses.delete(n)
    this.notifChannels.delete(n)
    this.consecutiveFailures.delete(n)
    this.clearRetryTimer(n)
    saveNotifChannels(this.notifChannels)
    saveStatusCache(this.statuses)
    this.notify()
  }

  hasNotifEnabled(channel: string): boolean {
    return this.notifChannels.has(normalizeChannelName(channel))
  }

  setNotifEnabled(channel: string, enabled: boolean): boolean {
    const n = normalizeChannelName(channel)
    const wasOn = this.notifChannels.has(n)
    if (enabled === wasOn) return wasOn
    if (enabled) this.notifChannels.add(n)
    else this.notifChannels.delete(n)
    saveNotifChannels(this.notifChannels)
    this.notify()
    return enabled
  }

  exportJson(): string {
    const payload = { version: 1, favorites: this.entries }
    return JSON.stringify(payload, null, 2)
  }

  importJson(text: string): { added: number; skipped: number; invalid: number } {
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch {
      return { added: 0, skipped: 0, invalid: -1 }
    }
    let list: unknown
    if (parsed && typeof parsed === 'object' && Array.isArray((parsed as { favorites?: unknown }).favorites)) {
      list = (parsed as { favorites: unknown[] }).favorites
    } else if (Array.isArray(parsed)) {
      list = parsed
    } else {
      return { added: 0, skipped: 0, invalid: -1 }
    }
    const existing = new Set(this.entries.map((e) => e.name))
    let added = 0
    let skipped = 0
    let invalid = 0
    const newEntries: FavoriteEntry[] = []
    const now = Date.now()
    let importIndex = 0
    for (const item of list as unknown[]) {
      if (!item || typeof item !== 'object') { invalid++; continue }
      const name = (item as { name?: unknown }).name
      if (typeof name !== 'string') { invalid++; continue }
      const n = normalizeChannelName(name)
      if (!isValidChannelName(n)) { invalid++; continue }
      if (existing.has(n)) { skipped++; continue }
      if (this.entries.length + newEntries.length >= MAX_FAVORITES) { skipped++; continue }
      const addedAt = typeof (item as { addedAt?: unknown }).addedAt === 'number'
        ? (item as { addedAt: number }).addedAt
        : now
      const order = typeof (item as { order?: unknown }).order === 'number'
        ? (item as { order: number }).order
        : now + importIndex++
      newEntries.push({ name: n, addedAt, order })
      existing.add(n)
      this.entryVersions.set(n, (this.entryVersions.get(n) ?? 0) + 1)
      this.statuses.set(n, {
        name: n,
        status: { state: 'unknown' },
        lastFetched: null,
        lastError: null,
        updateDelayed: false,
      })
      this.consecutiveFailures.delete(n)
      this.clearRetryTimer(n)
      added++
    }
    if (added > 0) {
      this.entries = [...this.entries, ...newEntries]
      saveToStorage(this.entries)
      this.notify()
      this.scheduleNextPoll()
      // Batch-classify like start(): enqueue every uptime before any
      // enrichment so a large restore doesn't let avatars delay later
      // channels' status resolution.
      this.classifyBatchPending = newEntries.length
      for (let i = 0; i < newEntries.length; i++) {
        void this.fetchOne(newEntries[i].name, i * PER_FAV_STAGGER_MS, false, true)
      }
    }
    return { added, skipped, invalid }
  }

  start(): void {
    if (this.disposed) return
    // The initial pass classifies every favorite (uptime first). Enrichment
    // (avatar + live metadata) is deferred until all uptime requests have been
    // queued, so cosmetic calls can't push a later channel's uptime down the
    // FIFO limiter queue.
    if (this.entries.length > 0) {
      this.classifyBatchPending = this.entries.length
      for (let i = 0; i < this.entries.length; i++) {
        void this.fetchOne(this.entries[i].name, i * PER_FAV_STAGGER_MS, false, true)
      }
    }
    this.scheduleNextPoll()
  }

  getStatus(channel: string): FavoriteStatus | undefined {
    const n = normalizeChannelName(channel)
    return this.statuses.get(n)
  }

  stop(): void {
    if (this.pollTimer) {
      clearTimeout(this.pollTimer)
      this.pollTimer = null
    }
  }

  dispose(): void {
    this.disposed = true
    this.stop()
    for (const t of this.retryTimers.values()) clearTimeout(t)
    this.retryTimers.clear()
    this.deferredEnrich.clear()
    this.metadataInFlight.clear()
    this.avatarInFlight.clear()
    this.classifyBatchPending = 0
    this.listeners.clear()
  }

  private isInAggressivePhase(): boolean {
    return Date.now() - this.startedAt < NOTIFY_STARTUP_GRACE_MS
  }

  private scheduleNextPoll(): void {
    if (this.disposed) return
    if (this.pollTimer) clearTimeout(this.pollTimer)
    const aggressiveAtSchedule = this.isInAggressivePhase()
    const interval = aggressiveAtSchedule ? OFFLINE_INITIAL_POLL_INTERVAL_MS : POLL_INTERVAL_MS
    this.pollTimer = setTimeout(() => {
      this.pollTimer = null
      if (this.disposed) return
      const aggressiveAtFire = this.isInAggressivePhase()
      const targets = this.entries.filter((e) => {
        if (!aggressiveAtFire) return true
        const st = this.statuses.get(e.name)?.status
        // During the startup grace period, re-poll every channel that is NOT
        // confirmed live — offline, unknown (never resolved, e.g. skipped
        // during an earlier cooldown), and transient error states all need
        // another attempt. Live channels already poll on the normal cadence
        // (and refresh metadata), so they are excluded to avoid waste.
        return st?.state !== 'live'
      })
      // Batch-classify so cosmetic enrichment from earlier targets can't push
      // a later target's uptime down the FIFO limiter queue.
      if (targets.length > 0) this.classifyBatchPending = targets.length
      for (let i = 0; i < targets.length; i++) {
        void this.fetchOne(targets[i].name, i * PER_FAV_STAGGER_MS, false, true)
      }
      this.scheduleNextPoll()
    }, interval)
  }

  private clearRetryTimer(name: string): void {
    const t = this.retryTimers.get(name)
    if (t) {
      clearTimeout(t)
      this.retryTimers.delete(name)
    }
  }

  private scheduleRetry(name: string, attempt: number): void {
    this.clearRetryTimer(name)
    const idx = attempt - 1
    if (idx < 0 || idx >= RETRY_DELAYS_MS.length) return
    let delay = RETRY_DELAYS_MS[idx]
    const now = Date.now()
    if (this.decapiCooldownUntil > now) {
      // Past cooldown: defer until just after it ends, plus jitter so 100 channels
      // don't all hammer DecAPI the instant the breaker resets.
      delay = this.decapiCooldownUntil - now + 250 + Math.random() * RETRY_JITTER_MS
    } else {
      delay = delay + Math.random() * (RETRY_JITTER_MS / 2)
    }
    const t = setTimeout(() => {
      this.retryTimers.delete(name)
      if (this.disposed) return
      if (!this.entries.some((e) => e.name === name)) return
      void this.fetchOne(name, 0, true)
    }, delay)
    this.retryTimers.set(name, t)
  }

  private isOnCooldown(): boolean {
    return Date.now() < this.decapiCooldownUntil
  }

  private tripCircuitBreaker(): void {
    if (!this.rateLimited) {
      this.rateLimited = true
      this.notify()
    }
    this.circuitBreakerStreak++
    // Proper exponential: 30s, 60s, 120s, 240s, capped at 5 min.
    // Streak resets when the cooldown fully expires (see clearCircuitBreakerIfExpired).
    const ms = Math.min(CIRCUIT_BREAKER_MS * Math.pow(2, this.circuitBreakerStreak - 1), 5 * 60 * 1000)
    this.decapiCooldownUntil = Date.now() + ms
  }

  private clearCircuitBreakerIfExpired(): void {
    if (this.rateLimited && Date.now() >= this.decapiCooldownUntil) {
      this.rateLimited = false
      this.decapiCooldownUntil = 0
      this.circuitBreakerStreak = 0
      this.notify()
    }
  }

  private shouldFetchMetadata(name: string): boolean {
    const last = this.metadataFetchedAt.get(name) ?? 0
    return Date.now() - last > METADATA_REFRESH_MS
  }

  private async fetchOne(
    name: string,
    delayMs: number,
    isRetry = false,
    batch = false,
  ): Promise<void> {
    if (this.disposed) return
    const version = this.entryVersions.get(name)
    if (version === undefined || !this.has(name)) return
    if (this.inFlight.get(name) === version) return
    this.inFlight.set(name, version)
    if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs))
    if (this.disposed || !this.isCurrentEntry(name, version)) {
      if (this.inFlight.get(name) === version) this.inFlight.delete(name)
      if (batch) this.classifyBatchDone()
      return
    }
    try {
      this.clearCircuitBreakerIfExpired()
      if (this.isOnCooldown()) {
        if (this.inFlight.get(name) === version) this.inFlight.delete(name)
        // A global DecAPI cooldown is active but THIS request never reached
        // the network, so it is not a channel failure: it must not increment
        // consecutiveFailures, apply per-channel backoff, or mark the channel
        // stale. Just reschedule for after the cooldown ends (+ jitter). The
        // breaker can only stay active while real 429s occur elsewhere, and
        // those failures are capped independently.
        this.scheduleCooldownDefer(name)
        return
      }

      // ---- Phase 1: classification (uptime) ----
      // Resolve live/offline first and commit it, so the loading indicator
      // disappears as soon as uptime is known — before any cosmetic avatar /
      // metadata request. Avatar + metadata are Phase 2 (enrich()).
      const cachedAvatar = this.avatarCache.get(name) ?? ''
      const timeoutMs = isRetry ? RETRY_TIMEOUT_MS : REQUEST_TIMEOUT_MS
      let uptimeBody: string
      try {
        uptimeBody = await fetchText('/twitch/uptime/' + name, timeoutMs)
      } catch (err) {
        throw new Error('uptime: ' + (err as Error).message)
      }
      if (!this.isCurrentEntry(name, version)) return

      const prev = this.statuses.get(name)
      const prevStatus = prev?.status
      const offline = isOfflineMessage(name, uptimeBody)
      const cachedMeta = this.metadataCache.get(name)
      const status: LiveStatus = offline
        ? { state: 'offline', avatarUrl: cachedAvatar }
        : {
            state: 'live',
            title: cachedMeta?.title ?? '',
            viewers: cachedMeta?.viewers ?? 0,
            uptime: uptimeBody,
            game: cachedMeta?.game ?? '',
            avatarUrl: cachedAvatar,
          }

      // Re-entering live (was offline/error/unknown): force a metadata
      // refresh so we don't keep showing title/viewers from a previous live
      // session that may have gone stale while offline.
      if (!offline && prevStatus?.state !== 'live') {
        this.metadataFetchedAt.delete(name)
      }

      // Commit classification. This is a real success for the uptime call.
      this.consecutiveFailures.delete(name)
      this.clearRetryTimer(name)
      this.statuses.set(name, {
        name,
        status,
        lastFetched: Date.now(),
        lastError: null,
        updateDelayed: false,
      })
      const wasLive = prevStatus?.state === 'live'
      const nowLive = status.state === 'live'
      if (!wasLive && nowLive && Date.now() - this.startedAt >= NOTIFY_STARTUP_GRACE_MS) {
        this.fireLiveNotification(name, status)
      }
      if (this.isCurrentEntry(name, version)) {
        saveStatusCache(this.statuses)
        this.notify()
      }

      // ---- Phase 2: enrichment (avatar + live metadata) ----
      // Deferred during the initial batch so every uptime request is queued
      // ahead of cosmetic calls; launched immediately otherwise.
      if (batch) {
        this.deferredEnrich.set(name, version)
      } else {
        void this.enrich(name, version)
      }
    } catch (err) {
      // Real network failure (e.g. a 429 that reached the server, or a
      // timeout). This IS a channel failure: bump the counter, apply backoff.
      const errorMessage = (err as Error).message
      const prev = this.statuses.get(name)
      if (this.isCurrentEntry(name, version)) {
        if (errorMessage.includes('429')) {
          this.tripCircuitBreaker()
        }
        const priorFailures = this.consecutiveFailures.get(name) ?? 0
        const nextFailures = priorFailures + 1
        this.consecutiveFailures.set(name, nextFailures)
        const isStale = nextFailures >= CONSECUTIVE_FAILURES_FOR_STALE
        if (isStale) this.clearRetryTimer(name)
        else this.scheduleRetry(name, nextFailures)
        this.statuses.set(name, {
          name,
          status: prev?.status ?? { state: 'unknown' },
          lastFetched: prev?.lastFetched ?? null,
          lastError: errorMessage,
          updateDelayed: isStale,
        })
        saveStatusCache(this.statuses)
        this.notify()
      }
    } finally {
      if (this.inFlight.get(name) === version) this.inFlight.delete(name)
      if (batch) this.classifyBatchDone()
    }
  }

  private classifyBatchDone(): void {
    if (this.classifyBatchPending <= 0) return
    this.classifyBatchPending--
    if (this.classifyBatchPending === 0 && this.deferredEnrich.size > 0) {
      this.flushDeferredEnrich()
    }
  }

  private flushDeferredEnrich(): void {
    if (this.disposed) {
      this.deferredEnrich.clear()
      return
    }
    const todo = this.deferredEnrich
    this.deferredEnrich = new Map()
    // Partition by CURRENT status and launch in priority order so no offline
    // avatar can delay useful information for a confirmed-live channel. The
    // shared DecAPI limiter is FIFO, so launching in this order queues the
    // requests in this order. Within each phase the original favorite order
    // (Map insertion order) is preserved. Per-method state checks re-verify
    // liveness/offline at execution time, so a transition while queued is safe.
    //   1. live metadata (title / game / viewers)
    //   2. missing avatars for live channels
    //   3. missing avatars for offline channels
    // Unknown/error entries get no cosmetic enrichment (the per-method checks
    // skip channels that aren't classified live/offline).
    const live: [string, number][] = []
    const offline: [string, number][] = []
    for (const [name, version] of todo) {
      const st = this.statuses.get(name)?.status
      if (st?.state === 'live') live.push([name, version])
      else if (st?.state === 'offline') offline.push([name, version])
    }
    for (const [name, version] of live) void this.enrichMetadata(name, version)
    for (const [name, version] of live) void this.enrichAvatar(name, version)
    for (const [name, version] of offline) void this.enrichAvatar(name, version)
  }

  private scheduleCooldownDefer(name: string): void {
    // One deferral timer per channel (clearRetryTimer). NOT a failure: the
    // request never reached the network, so consecutiveFailures is untouched.
    this.clearRetryTimer(name)
    if (this.disposed) return
    const now = Date.now()
    const base = Math.max(this.decapiCooldownUntil, now)
    const delay = base - now + 250 + Math.random() * RETRY_JITTER_MS
    const t = setTimeout(() => {
      this.retryTimers.delete(name)
      if (this.disposed) return
      if (!this.entries.some((e) => e.name === name)) return
      void this.fetchOne(name, 0, true)
    }, delay)
    this.retryTimers.set(name, t)
  }

  // Phase 2 entry point for NON-deferred (single-channel) enrichment paths
  // (add / retryFetch / non-batch fetchOne). Metadata first (live information
  // matters more than the avatar), then the avatar. The deferred batch path
  // does NOT use this — it launches enrichMetadata / enrichAvatar in priority
  // phases via flushDeferredEnrich().
  private async enrich(name: string, version: number): Promise<void> {
    await this.enrichMetadata(name, version)
    await this.enrichAvatar(name, version)
  }

  // Live metadata enrichment: title / game / viewers. Re-verifies the channel
  // is STILL live immediately before fetching and again before applying, so a
  // live->offline transition while queued can't receive or store stale live
  // metadata. Never reverts a classification; failure leaves cached values.
  private async enrichMetadata(name: string, version: number): Promise<void> {
    if (this.disposed || !this.isCurrentEntry(name, version)) return
    if (this.metadataInFlight.has(name)) return
    if (this.statuses.get(name)?.status.state !== 'live') return
    if (!this.shouldFetchMetadata(name)) return
    this.metadataInFlight.add(name)
    try {
      if (this.disposed || !this.isCurrentEntry(name, version)) return
      if (this.statuses.get(name)?.status.state !== 'live') return
      const results = await Promise.allSettled([
        fetchText('/twitch/title/' + name, REQUEST_TIMEOUT_MS),
        fetchText('/twitch/viewercount/' + name, REQUEST_TIMEOUT_MS),
        fetchText('/twitch/game/' + name, REQUEST_TIMEOUT_MS),
      ])
      if (this.disposed || !this.isCurrentEntry(name, version)) return
      // Re-check liveness before caching/applying: don't store live metadata
      // for a channel that went offline while the requests were in flight.
      if (this.statuses.get(name)?.status.state !== 'live') return
      const prevMeta = this.metadataCache.get(name) ?? { title: '', viewers: 0, game: '' }
      const parsedViewers =
        results[1].status === 'fulfilled' && Number.isFinite(parseInt(results[1].value, 10))
          ? parseInt(results[1].value, 10)
          : prevMeta.viewers
      this.metadataCache.set(name, {
        title: results[0].status === 'fulfilled' ? results[0].value : prevMeta.title,
        viewers: parsedViewers,
        game: results[2].status === 'fulfilled' ? results[2].value : prevMeta.game,
      })
      this.metadataFetchedAt.set(name, Date.now())
      this.reflectCaches(name)
    } finally {
      this.metadataInFlight.delete(name)
    }
  }

  // Avatar enrichment: fetch a missing profile picture for an already-classified
  // (live or offline) channel. An avatar is valid for either state, so no
  // live/offline re-check is needed beyond "still classified"; the live-first
  // ordering is handled by flushDeferredEnrich()'s phase launch. Failure is
  // non-fatal and never erases a cached avatar.
  private async enrichAvatar(name: string, version: number): Promise<void> {
    if (this.disposed || !this.isCurrentEntry(name, version)) return
    if (this.avatarInFlight.has(name)) return
    if (this.avatarCache.get(name)) return // already have one
    const cs = this.statuses.get(name)?.status
    if (cs?.state !== 'live' && cs?.state !== 'offline') return
    this.avatarInFlight.add(name)
    try {
      if (this.disposed || !this.isCurrentEntry(name, version)) return
      try {
        const av = await fetchText('/twitch/avatar/' + name, REQUEST_TIMEOUT_MS)
        if (this.disposed || !this.isCurrentEntry(name, version)) return
        if (av) {
          this.avatarCache.set(name, av)
          this.reflectCaches(name)
        }
      } catch {
        /* non-essential: keep existing (cached or empty) avatar */
      }
    } finally {
      this.avatarInFlight.delete(name)
    }
  }

  // Reflect the avatar/metadata caches into the already-classified status.
  // Never reverts a classification: only live statuses get metadata, and only
  // live/offline statuses get an avatar. Guarded so a disposed/removed store
  // or a state change is respected.
  private reflectCaches(name: string): void {
    if (this.disposed) return
    const existing = this.statuses.get(name)
    if (!existing) return
    const es = existing.status
    if (es.state !== 'live' && es.state !== 'offline') return
    const next: LiveStatus = { ...es, avatarUrl: this.avatarCache.get(name) ?? es.avatarUrl }
    if (es.state === 'live' && next.state === 'live') {
      const m = this.metadataCache.get(name)
      if (m) {
        next.title = m.title
        next.viewers = m.viewers
        next.game = m.game
      }
    }
    this.statuses.set(name, { ...existing, status: next, lastFetched: Date.now() })
    saveStatusCache(this.statuses)
    this.notify()
  }

  private isCurrentEntry(name: string, version: number): boolean {
    return this.entryVersions.get(name) === version && this.entries.some((e) => e.name === name)
  }

  private async fireLiveNotification(channel: string, status: LiveStatus): Promise<void> {
    if (status.state !== 'live') return
    if (!this.hasNotifEnabled(channel)) return
    const title = channel + ' is live'
    const body = status.title || status.game || 'Click to watch'
    notifications.record('live', title, body, channel)
    if (typeof window !== 'undefined' && isTauri()) {
      try {
        const mod = await import('@tauri-apps/plugin-notification')
        let h = 0
        const key = 'fav-live-' + channel
        for (let i = 0; i < key.length; i++) h = ((h << 5) - h + key.charCodeAt(i)) | 0
        mod.sendNotification({ title, body, id: h })
      } catch {
        /* plugin unavailable */
      }
      return
    }
    if (typeof Notification === 'undefined') return
    if (Notification.permission !== 'granted') return
    try {
      const icon = status.avatarUrl || undefined
      const n = new Notification(title, {
        body,
        tag: 'fav-live-' + channel,
        icon,
      })
      n.onclick = () => {
        try {
          window.focus()
          window.location.hash = '#/c/' + channel
        } catch {
          /* ignore */
        }
        n.close()
      }
    } catch {
      /* some browsers throw on construction */
    }
  }
}

export const favoritesStore = new FavoritesStore()
