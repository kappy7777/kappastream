import { isTauri } from '@tauri-apps/api/core'
import { settings } from './settings.svelte.ts'
import { notifications } from './notifications.svelte.ts'
import { fetchChannelStatuses, GQL_REFRESH_INTERVAL_MS, type ChannelStatus } from './gql'
import { t } from './i18n/index.svelte'

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
const NOTIF_CHANNELS_KEY = 'fav-notif-channels-v1'
export const MAX_FAVORITES = 1000

// Favorites resolve from ONE source: Twitch's anonymous GQL endpoint, polled as
// a single batched `users(logins:)` request per refresh (see gql.ts). That one
// request carries live/offline + title/game/viewers/avatar/stream-start for the
// whole list, so there is no per-channel enrichment pass and no second data
// source to fall over to.
//
// On a GQL transport failure (network / non-2xx / timeout / malformed body)
// there is NO fallback service. The store keeps every channel's LAST-KNOWN
// status (it is never reset to error/unknown on an outage), trips a circuit
// breaker so the sidebar can show a "having trouble reaching Twitch" banner,
// and schedules an exponential-backoff retry of the SAME GQL batch. Channels
// simply stop updating until the next successful poll.
const NOTIFY_STARTUP_GRACE_MS = 10 * 60 * 1000
const CIRCUIT_BREAKER_MS = 30_000
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

// Convert a GQL stream `createdAt` (ISO-8601) into a human-readable uptime
// string for the LiveStatus type. The sidebar doesn't render uptime (only the
// active-channel path does, via fetchLiveStatus); this keeps the field
// populated + sane for the status cache and any future caller. Stale by up to
// one refresh interval (GQL_REFRESH_INTERVAL_MS) — acceptable since it isn't
// displayed for favorites.
function formatUptime(startedAtIso: string): string {
  if (!startedAtIso) return ''
  const start = Date.parse(startedAtIso)
  if (!Number.isFinite(start)) return ''
  let s = Math.max(0, Math.floor((Date.now() - start) / 1000))
  const h = Math.floor(s / 3600)
  s -= h * 3600
  const m = Math.floor(s / 60)
  s -= m * 60
  if (h > 0) return `${h}h ${m}m`
  if (m > 0) return `${m}m ${s}s`
  return `${s}s`
}

// Atomic single-channel resolution used by App.svelte for the ACTIVE channel's
// status bar (a user-driven freshen where waiting on the full title/viewers/
// game/avatar set is fine). Resolves through the same batched GQL transport as
// the favorites poll, just scoped to one login. On a transport failure it
// returns an error status — App.svelte already shows the cached favorites
// status first, so an error here merely fails to refresh it.
export async function fetchLiveStatus(channel: string): Promise<LiveStatus> {
  try {
    const statuses = await fetchChannelStatuses([channel])
    const cs = statuses[0]
    if (!cs) return { state: 'error', message: 'no response' }
    if (cs.live) {
      return {
        state: 'live',
        title: cs.title,
        viewers: cs.viewersCount,
        uptime: formatUptime(cs.startedAt),
        game: cs.game,
        avatarUrl: cs.avatarUrl,
      }
    }
    return { state: 'offline', avatarUrl: cs.avatarUrl }
  } catch (err) {
    return { state: 'error', message: (err as Error).message }
  }
}

export type StatusListener = (snapshot: FavoriteStatus[]) => void

export class FavoritesStore {
  private entries: FavoriteEntry[] = []
  private statuses = new Map<string, FavoriteStatus>()
  private listeners = new Set<StatusListener>()
  private pollTimer: ReturnType<typeof setTimeout> | null = null
  private disposed = false
  private notifChannels: Set<string> = new Set()
  private readonly startedAt = Date.now()
  // Per-channel version counter. Bumped on add/remove/import so a batch GQL
  // response that was snapshotted BEFORE a channel was removed (+ possibly
  // re-added) can be detected and skipped in applyGqlStatuses — the newer
  // fetch owns the channel. Without this, a late response from a poll that no
  // longer represents the current entry would overwrite a fresher status.
  private entryVersions = new Map<string, number>()
  // Circuit breaker governing GQL batch retries. On a transport failure this
  // backs off (exponential: 30s → 60s → 120s → 240s, capped at 5 min) and the
  // `rateLimited` flag drives the sidebar's "having trouble reaching Twitch"
  // banner. A successful GQL batch clears it.
  private gqlCooldownUntil = 0
  private circuitBreakerStreak = 0
  // A single batch-retry timer. Set when a GQL poll fails (after tripping the
  // breaker) and fires pollOnce() again once the cooldown + jitter elapses.
  private batchRetryTimer: ReturnType<typeof setTimeout> | null = null
  // Guards against overlapping batch GQL polls (start() + a fired poll timer +
  // an import all racing). If a second pollOnce is requested while one is in
  // flight (e.g. an import lands mid-poll, adding entries the in-flight request
  // won't cover), pollRequested triggers one re-run after the current poll
  // settles.
  private polling = false
  private pollRequested = false

  rateLimited: boolean = $state(false)

  constructor() {
    this.entries = loadFromStorage()
    this.notifChannels = loadNotifChannels()
    // No persisted status cache: every channel starts 'unknown' and is
    // resolved fresh by the first GQL poll (~1s after launch). The previous
    // 1h localStorage cache (fav-status-cache-v1 / -ts-v1) was removed — GQL
    // repopulates the whole list fast enough that a brief "Loading…" flash is
    // preferable to showing up-to-1h-stale live/title/viewers state.
    for (const e of this.entries) {
      this.entryVersions.set(e.name, 1)
      this.statuses.set(e.name, {
        name: e.name,
        status: { state: 'unknown' },
        lastFetched: null,
        lastError: null,
        updateDelayed: false,
      })
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
    if (!this.has(n)) return
    // There is no per-channel fetch anymore — one GQL batch resolves the whole
    // list. A "retry" is therefore just a forced poll, which covers this
    // channel too. (Respects the breaker: if GQL is backed off, pollOnce
    // defers to the scheduled batch retry.)
    void this.pollOnce()
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
    this.notify()
    void this.resolveSingle(n)
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
    // Bump the version so any in-flight batch whose snapshot still includes
    // this channel skips it in applyGqlStatuses.
    this.entryVersions.set(n, (this.entryVersions.get(n) ?? 0) + 1)
    this.entries = this.entries.filter((e) => e.name !== n)
    saveToStorage(this.entries)
    this.statuses.delete(n)
    this.notifChannels.delete(n)
    saveNotifChannels(this.notifChannels)
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
      added++
    }
    if (added > 0) {
      this.entries = [...this.entries, ...newEntries]
      saveToStorage(this.entries)
      this.notify()
      // Resolve via the GQL batch poll (covers the whole list in one request).
      this.scheduleNextPoll()
      void this.pollOnce()
    }
    return { added, skipped, invalid }
  }

  start(): void {
    if (this.disposed) return
    // Initial pass: one GQL request classifies the whole favorites list. On a
    // transport failure the breaker trips and a backoff retry is scheduled.
    if (this.entries.length > 0) void this.pollOnce()
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
    if (this.batchRetryTimer) {
      clearTimeout(this.batchRetryTimer)
      this.batchRetryTimer = null
    }
    this.listeners.clear()
  }

  private scheduleNextPoll(): void {
    if (this.disposed) return
    if (this.pollTimer) clearTimeout(this.pollTimer)
    // One GQL request per refresh covers the WHOLE favorites list, so every
    // channel is cheaply re-resolved every GQL_REFRESH_INTERVAL_MS.
    this.pollTimer = setTimeout(() => {
      this.pollTimer = null
      if (this.disposed) return
      void this.pollOnce()
      this.scheduleNextPoll()
    }, GQL_REFRESH_INTERVAL_MS)
  }

  // The primary refresh path: ONE batched GQL request resolves every
  // favorite's live/offline + title/game/viewers/avatar in a single round
  // trip. On any transport-level failure (network, non-2xx, malformed body,
  // timeout) there is no fallback — the breaker trips (rateLimited banner),
  // every channel keeps its last-known status, and a backoff retry of this
  // same batch is scheduled. A channel that's simply OFFLINE (stream: null)
  // or nonexistent (null entry) is a SUCCESS here and must never trip the
  // breaker.
  private async pollOnce(): Promise<void> {
    if (this.disposed) return
    if (this.polling) {
      // A poll is in flight (its snapshot already left us). Remember to re-run
      // so newly-added/imported entries are covered instead of waiting a full
      // GQL_REFRESH_INTERVAL_MS for the next scheduled poll.
      this.pollRequested = true
      return
    }
    const names = this.entries.map((e) => e.name)
    if (names.length === 0) return
    // Snapshot per-channel versions so a channel removed (+ maybe re-added)
    // while this batch is in flight can be detected and skipped on apply.
    const versions = this.snapshotVersions(names)
    // GQL is in a backed-off cooldown (a recent transport failure). Defer this
    // poll to the scheduled batch retry rather than hammering the endpoint.
    if (this.isOnCooldown()) return
    this.polling = true
    try {
      const statuses = await fetchChannelStatuses(names)
      if (this.disposed) return
      this.applyGqlStatuses(statuses, versions)
    } catch {
      if (this.disposed) return
      this.tripCircuitBreaker()
      this.scheduleBatchRetry()
    } finally {
      this.polling = false
      if (this.pollRequested && !this.disposed) {
        this.pollRequested = false
        void this.pollOnce()
      }
    }
  }

  private snapshotVersions(names: string[]): Map<string, number> {
    const m = new Map<string, number>()
    for (const n of names) m.set(n, this.entryVersions.get(n) ?? 0)
    return m
  }

  // Single-channel GQL resolve for a freshly-added favorite (good UX: the new
  // channel resolves immediately instead of waiting up to GQL_REFRESH_INTERVAL
  // for the next batch). On transport failure it trips the breaker + schedules
  // a batch retry (which covers this channel) — there is no second source.
  private async resolveSingle(name: string): Promise<void> {
    if (this.disposed) return
    if (this.isOnCooldown()) return
    const version = this.entryVersions.get(name) ?? 0
    try {
      const statuses = await fetchChannelStatuses([name])
      if (this.disposed) return
      this.applyGqlStatuses(statuses, new Map([[name, version]]))
    } catch {
      if (this.disposed) return
      this.tripCircuitBreaker()
      this.scheduleBatchRetry()
    }
  }

  // Apply a successful GQL batch. The one response carries avatar + title +
  // viewers + game + stream-start for every channel, so there is nothing left
  // to enrich. Offline (stream: null) and nonexistent (null entry) channels
  // are both successes — never a breaker trigger. `versions` is the
  // per-channel version snapshot taken when the batch was issued; a channel
  // whose version has since changed (removed + re-added mid-flight) is skipped.
  private applyGqlStatuses(statuses: ChannelStatus[], versions?: Map<string, number>): void {
    if (this.disposed) return
    let changed = false
    for (const cs of statuses) {
      if (this.disposed) return
      if (!cs.login || !isValidChannelName(cs.login)) continue
      if (!this.has(cs.login)) continue // removed mid-flight
      if (versions && (this.entryVersions.get(cs.login) ?? 0) !== (versions.get(cs.login) ?? 0)) {
        continue // a newer fetch owns this channel now
      }
      const prev = this.statuses.get(cs.login)
      const wasLive = prev?.status.state === 'live'

      const status: LiveStatus = cs.live
        ? {
            state: 'live',
            title: cs.title,
            viewers: cs.viewersCount,
            uptime: formatUptime(cs.startedAt),
            game: cs.game,
            avatarUrl: cs.avatarUrl,
          }
        : { state: 'offline', avatarUrl: cs.avatarUrl }

      this.statuses.set(cs.login, {
        name: cs.login,
        status,
        lastFetched: Date.now(),
        lastError: null,
        updateDelayed: false,
      })
      if (!wasLive && cs.live && Date.now() - this.startedAt >= NOTIFY_STARTUP_GRACE_MS) {
        void this.fireLiveNotification(cs.login, status)
      }
      changed = true
    }
    // A clean GQL batch is proof the endpoint recovered, so let a lapsed
    // breaker clear (it can only have been tripped by a prior failure).
    this.clearCircuitBreakerIfExpired()
    if (changed) {
      this.notify()
    }
  }

  private isOnCooldown(): boolean {
    return Date.now() < this.gqlCooldownUntil
  }

  private tripCircuitBreaker(): void {
    if (!this.rateLimited) {
      this.rateLimited = true
      this.notify()
    }
    this.circuitBreakerStreak++
    // Proper exponential backoff on a GQL transport failure: 30s, 60s, 120s,
    // 240s, capped at 5 min. Streak resets when a successful batch clears the
    // breaker (clearCircuitBreakerIfExpired).
    const ms = Math.min(CIRCUIT_BREAKER_MS * Math.pow(2, this.circuitBreakerStreak - 1), 5 * 60 * 1000)
    this.gqlCooldownUntil = Date.now() + ms
  }

  private clearCircuitBreakerIfExpired(): void {
    if (this.rateLimited && Date.now() >= this.gqlCooldownUntil) {
      this.rateLimited = false
      this.gqlCooldownUntil = 0
      this.circuitBreakerStreak = 0
      this.notify()
    }
  }

  // Schedule a single backoff retry of the GQL batch. One timer at a time: if a
  // retry is already pending, the in-flight one will re-run the poll (which
  // covers any channels added since). Fires at cooldownEnd + jitter so repeated
  // failures don't all retry on the exact same tick.
  private scheduleBatchRetry(): void {
    if (this.disposed) return
    if (this.batchRetryTimer) return
    const now = Date.now()
    const delay = Math.max(0, this.gqlCooldownUntil - now) + 250 + Math.random() * RETRY_JITTER_MS
    this.batchRetryTimer = setTimeout(() => {
      this.batchRetryTimer = null
      if (this.disposed) return
      void this.pollOnce()
    }, delay)
  }

  private async fireLiveNotification(channel: string, status: LiveStatus): Promise<void> {
    if (status.state !== 'live') return
    if (!this.hasNotifEnabled(channel)) return
    const title = t('notif_live', { channel })
    const body = status.title || status.game || t('notif_clickToWatch')
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
