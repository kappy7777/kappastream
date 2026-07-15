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
const PER_FAV_STAGGER_MS = 1500
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

const MIN_FETCH_GAP_MS = 200
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
  // Global throttle — keeps DecAPI request rate at ~5 req/s sustained
  // (no bursts) regardless of how many channels are in-flight at once.
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
  const timeoutMs = options?.timeoutMs ?? REQUEST_TIMEOUT_MS
  let avatarUrl = options?.cachedAvatarUrl ?? ''
  if (!avatarUrl) {
    try {
      avatarUrl = await fetchText('/twitch/avatar/' + channel, timeoutMs)
    } catch (_e) {
      /* avatar is non-essential */
    }
  }

  let uptimeBody: string
  try {
    uptimeBody = await fetchText('/twitch/uptime/' + channel, timeoutMs)
  } catch (err) {
    return { state: 'error', message: 'uptime: ' + (err as Error).message }
  }

  if (isOfflineMessage(channel, uptimeBody)) {
    return { state: 'offline', avatarUrl }
  }

  if (options?.fetchMetadata === false) {
    return { state: 'live', title: '', viewers: 0, uptime: uptimeBody, game: '', avatarUrl }
  }

  let title = ''
  let viewers = 0
  let game = ''
  const errors: string[] = []

  const results = await Promise.allSettled([
    fetchText('/twitch/title/' + channel, timeoutMs),
    fetchText('/twitch/viewercount/' + channel, timeoutMs),
    fetchText('/twitch/game/' + channel, timeoutMs),
  ])
  if (results[0].status === 'fulfilled') title = results[0].value
  else errors.push('title: ' + (results[0].reason as Error).message)
  if (results[1].status === 'fulfilled') {
    const v = parseInt(results[1].value, 10)
    viewers = Number.isFinite(v) ? v : 0
  } else {
    errors.push('viewers: ' + (results[1].reason as Error).message)
  }
  if (results[2].status === 'fulfilled') game = results[2].value
  else errors.push('game: ' + (results[2].reason as Error).message)

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
      for (let i = 0; i < newEntries.length; i++) {
        void this.fetchOne(newEntries[i].name, i * PER_FAV_STAGGER_MS)
      }
    }
    return { added, skipped, invalid }
  }

  start(): void {
    if (this.disposed) return
    for (let i = 0; i < this.entries.length; i++) {
      const name = this.entries[i].name
      void this.fetchOne(name, i * PER_FAV_STAGGER_MS)
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
        return st?.state === 'offline'
      })
      for (let i = 0; i < targets.length; i++) {
        void this.fetchOne(targets[i].name, i * PER_FAV_STAGGER_MS)
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

  private async fetchOne(name: string, delayMs: number, isRetry = false): Promise<void> {
    if (this.disposed) return
    const version = this.entryVersions.get(name)
    if (version === undefined || !this.has(name)) return
    if (this.inFlight.get(name) === version) return
    this.inFlight.set(name, version)
    if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs))
    if (this.disposed || !this.isCurrentEntry(name, version)) {
      if (this.inFlight.get(name) === version) this.inFlight.delete(name)
      return
    }
    this.clearCircuitBreakerIfExpired()
    if (this.isOnCooldown()) {
      if (this.inFlight.get(name) === version) this.inFlight.delete(name)
      if (isRetry && (this.consecutiveFailures.get(name) ?? 0) > 0 && (this.consecutiveFailures.get(name) ?? 0) < CONSECUTIVE_FAILURES_FOR_STALE) {
        this.scheduleRetry(name, this.consecutiveFailures.get(name) ?? 1)
      }
      return
    }
    const prev = this.statuses.get(name)
    const prevStatus = prev?.status
    try {
      const cachedAvatar = this.avatarCache.get(name)
      const shouldFetchMeta = this.shouldFetchMetadata(name)
      const timeoutMs = isRetry ? RETRY_TIMEOUT_MS : REQUEST_TIMEOUT_MS

      let status = await fetchLiveStatus(name, {
        cachedAvatarUrl: cachedAvatar,
        fetchMetadata: shouldFetchMeta,
        timeoutMs,
      })
      if (!this.isCurrentEntry(name, version)) return

      // fetchLiveStatus returns { state: 'error' } when an individual endpoint
      // (usually uptime) fails — e.g. HTTP 429. This is NOT an exception, so
      // without this re-throw the success path below would delete the failure
      // counter, clear the retry timer, and leave the channel stuck in error
      // state with zero retries scheduled. Route it through the catch block
      // so circuit-breaker detection and retry scheduling actually fire.
      if (status.state === 'error') {
        throw new Error(status.message)
      }

      if ((status.state === 'live' || status.state === 'offline') && status.avatarUrl && status.avatarUrl !== cachedAvatar) {
        this.avatarCache.set(name, status.avatarUrl)
      }

      if (status.state === 'live') {
        if (shouldFetchMeta) {
          this.metadataCache.set(name, {
            title: status.title,
            viewers: status.viewers,
            game: status.game,
          })
          this.metadataFetchedAt.set(name, Date.now())
        } else {
          const cachedMeta = this.metadataCache.get(name)
          if (cachedMeta) {
            status = {
              ...status,
              title: cachedMeta.title,
              viewers: cachedMeta.viewers,
              game: cachedMeta.game,
            }
          }
        }
      }

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
    } catch (err) {
      if (!this.isCurrentEntry(name, version)) return
      const errorMessage = (err as Error).message
      if (errorMessage.includes('429')) {
        this.tripCircuitBreaker()
      }

      const priorFailures = this.consecutiveFailures.get(name) ?? 0
      const nextFailures = priorFailures + 1
      this.consecutiveFailures.set(name, nextFailures)

      const isStale = nextFailures >= CONSECUTIVE_FAILURES_FOR_STALE
      if (isStale) {
        this.clearRetryTimer(name)
      } else {
        this.scheduleRetry(name, nextFailures)
      }

      this.statuses.set(name, {
        name,
        status: prevStatus ?? { state: 'unknown' },
        lastFetched: prev?.lastFetched ?? null,
        lastError: errorMessage,
        updateDelayed: isStale,
      })
    } finally {
      if (this.inFlight.get(name) === version) this.inFlight.delete(name)
      if (this.isCurrentEntry(name, version)) {
        saveStatusCache(this.statuses)
        this.notify()
      }
    }
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
