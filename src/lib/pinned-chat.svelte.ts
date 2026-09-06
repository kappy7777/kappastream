// Pinned chat messages — display model, dismissal, expiry, and the fetch
// controller. The GQL transport lives in gql.ts (fetchPinnedChatMessages);
// this module owns everything around it:
//
//   - toDisplayPin: transport row → render-ready pin. Badges go through the
//     SAME parseBadges path IRC messages use (setID/version keys, global map
//     + baseline + labels), the sender color through normalizeColor, and the
//     native Twitch emote positions become EmoteRanges so the banner renders
//     through the existing renderMessage pipeline — not a second renderer.
//   - Dismissal: keyed to the PIN id (node.id), persisted in localStorage, so
//     the 150s poll never resurrects a dismissed pin and a NEW pin (new id)
//     still appears. Deliberately survives an app restart: mod pins stay up
//     for hours, and re-showing a dismissed one after every launch would make
//     the dismiss button feel broken. Bounded to MAX_DISMISSED_PINS ids
//     (oldest evicted first) so the store cannot grow forever.
//   - Expiry: endsAt is checked against a slowly ticking clock, so a pin that
//     lapses BETWEEN polls disappears without waiting for the next refresh.
//   - PinnedChatStore: the fetch controller. It rides the existing favorites
//     poll cadence (GQL_REFRESH_INTERVAL_MS) — tick() is called from the
//     favorites subscribe callback, and an internal throttle caps any single
//     channel at one request per cycle no matter how often notify() fires.
//     The toggle gates the FETCH, not the rendering: with settings.chatPinned
//     off, refresh() returns before any request is issued (and drops the
//     current pin), unlike the Tier 2 toggles which parse always and gate
//     only presentation.
//
// Single-view App.svelte targets the joined channel and passes the numeric
// userId the favorites status batch already carries. MultiView targets ONLY
// the active chat tab's channel (the banner lives in the chat pane, so pins
// for background tiles would never be seen; fetching them would quadruple the
// requests). MultiView has no status batch, so the controller falls back
// to a memoized login→id resolution per channel (getTwitchUserId — the
// same anonymous GQL helper the emote loader uses): successes for the app's
// lifetime, failures retried at most once per USER_ID_RETRY_MS window —
// never per poll.

import {
  fetchPinnedChatMessages,
  GQL_REFRESH_INTERVAL_MS,
  type PinnedChatMessageData,
} from './gql'
import { parseBadges, normalizeColor, type BadgeInfo } from './irc'
import { getTwitchUserId, type EmoteRange } from './emotes'
import { settings } from './settings.svelte.ts'

export interface PinnedChatPin {
  /** PIN id (node.id) — the identity/dismissal key. Distinct from messageId. */
  pinId: string
  messageId: string
  /** Opaque enum string ("MOD" observed; unknown values render generically). */
  type: string
  startsAtMs: number | null
  endsAtMs: number | null
  updatedAtMs: number | null
  sentAtMs: number | null
  pinnedBy: { login: string; displayName: string }
  sender: { login: string; displayName: string; color: string }
  badges: BadgeInfo[]
  text: string
  emoteRanges: EmoteRange[]
}

function toMs(iso: string): number | null {
  if (!iso) return null
  const ms = Date.parse(iso)
  return Number.isFinite(ms) ? ms : null
}

/** Transport row → render-ready pin (badges/colors/emote offsets normalized). */
export function toDisplayPin(data: PinnedChatMessageData): PinnedChatPin {
  const msg = data.message
  const emoteRanges: EmoteRange[] = []
  let offset = 0
  for (const f of msg?.fragments ?? []) {
    const end = offset + f.text.length - 1
    if (f.emoteId && end >= offset) {
      emoteRanges.push({ start: offset, end, id: f.emoteId })
    }
    offset += f.text.length
  }
  return {
    pinId: data.pinId,
    messageId: data.messageId,
    type: data.type,
    startsAtMs: toMs(data.startsAt),
    endsAtMs: toMs(data.endsAt),
    updatedAtMs: toMs(data.updatedAt),
    sentAtMs: toMs(msg?.sentAt ?? ''),
    pinnedBy: {
      login: data.pinnedBy.login,
      displayName: data.pinnedBy.displayName || data.pinnedBy.login,
    },
    sender: {
      login: msg?.sender.login ?? '',
      displayName: msg?.sender.displayName || msg?.sender.login || '',
      color: normalizeColor(msg?.sender.chatColor || undefined),
    },
    // displayBadges carries the same setID/version keys the IRC badges tag
    // does — feed them through parseBadges so labels, per-version UUIDs and
    // the generated baseline all resolve exactly like a chat message badge.
    badges: parseBadges((msg?.sender.badges ?? []).map((b) => `${b.setID}/${b.version || '1'}`)),
    text: msg?.text ?? '',
    emoteRanges,
  }
}

/** True when a pin's endsAt has lapsed (null endsAt = no expiry = never). */
export function isPinExpired(pin: PinnedChatPin, nowMs: number): boolean {
  return pin.endsAtMs != null && pin.endsAtMs <= nowMs
}

// ---------------------------------------------------------------------------
// Dismissal store — pin-id keyed, persisted, bounded.
// ---------------------------------------------------------------------------

const DISMISSED_KEY = 'app-chat-pinned-dismissed-v1'
export const MAX_DISMISSED_PINS = 20

function loadDismissed(): string[] {
  try {
    const raw = localStorage.getItem(DISMISSED_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed)) return []
    const out: string[] = []
    const seen = new Set<string>()
    for (const item of parsed) {
      // Pin ids are UUIDs; a loose shape check keeps junk out of the store.
      if (typeof item !== 'string' || !/^[A-Za-z0-9-]{1,64}$/.test(item)) continue
      if (seen.has(item)) continue
      seen.add(item)
      out.push(item)
      if (out.length >= MAX_DISMISSED_PINS) break
    }
    return out
  } catch {
    return []
  }
}

// ---------------------------------------------------------------------------
// Fetch controller.
// ---------------------------------------------------------------------------

export interface PinnedChatDeps {
  /** The pinned-messages fetch (gql transport). */
  fetch: (channelId: string) => Promise<PinnedChatMessageData[]>
  /** Toggle read (default: settings.chatPinned). Read at refresh time. */
  enabled: () => boolean
  /** Numeric-id fallback for callers that have no status batch (multi-view). */
  resolveUserId: (login: string) => Promise<string | null>
  /** Injectable clock for tests. */
  now: () => number
  /** Min spacing between requests for the SAME channel (the poll cadence). */
  intervalMs: number
  /** How long a FAILED login→id resolution is remembered before one retry. */
  userIdRetryMs: number
}

// How long a FAILED login→id resolution stays memoized before the next
// refresh may retry it. Successes are stable for the app's lifetime (a
// channel's numeric id never changes), but a failure is usually a transient
// network blip — caching it forever would silently drop the pin banner on
// that channel until an app restart. 5 min bounds the retry cost at roughly
// one resolution request per TTL window, never per poll.
const USER_ID_RETRY_MS = 5 * 60_000

const DEFAULT_DEPS: PinnedChatDeps = {
  fetch: (id) => fetchPinnedChatMessages(id),
  enabled: () => settings.chatPinned,
  resolveUserId: (login) => getTwitchUserId(login),
  now: () => Date.now(),
  intervalMs: GQL_REFRESH_INTERVAL_MS,
  userIdRetryMs: USER_ID_RETRY_MS,
}

// How often the local clock re-checks endsAt while a bounded pin is shown.
// A UI-only ticker (never a network timer): it lets an expired pin vanish
// between polls. 15s is far below the shortest pin durations Twitch offers.
const EXPIRY_TICK_MS = 15_000

export class PinnedChatStore {
  pins: PinnedChatPin[] = $state([])
  /** Local clock for expiry checks (kept fresh by the ticker below). */
  nowMs: number = $state(0)

  private dismissed: string[] = $state(loadDismissed())
  private targetChannel: string | null = null
  private targetUserId: string | null = null
  private lastFetchChannel: string | null = null
  private lastFetchAt = 0
  private inFlight = false
  private wasEnabled = false
  private userIdMemo = new Map<string, string>()
  private userIdFailedAt = new Map<string, number>()
  private resolvingIds = new Set<string>()
  private expiryTimer: ReturnType<typeof setInterval> | null = null
  private readonly deps: PinnedChatDeps

  constructor(deps: PinnedChatDeps = DEFAULT_DEPS) {
    this.deps = deps
    this.nowMs = deps.now()
    this.wasEnabled = deps.enabled()
  }

  /**
   * Point the store at the channel whose chat is displayed (null = none).
   * `userId` is the numeric id the caller already has (single-view passes the
   * favorites status batch's; null makes the controller resolve it once).
   * Safe to call repeatedly — the internal throttle gates actual requests.
   */
  setTarget(channel: string | null, userId: string | null): void {
    if (channel !== this.targetChannel) {
      // Any channel change (including leaving to null) bypasses the throttle
      // for the next refresh, so returning to a channel re-fetches at once
      // instead of showing nothing until the next poll.
      this.lastFetchChannel = null
      if (!channel) this.pins = []
    }
    this.targetChannel = channel
    this.targetUserId = userId
    void this.refresh()
  }

  /** Favorites-cycle nudge (called from the store's subscribe callback). */
  tick(): void {
    void this.refresh()
  }

  /** Re-read the clock; used by the expiry ticker and tests. */
  refreshNow(): void {
    this.nowMs = this.deps.now()
  }

  /** First non-dismissed, non-expired pin (reactive — reads $state). */
  get visiblePin(): PinnedChatPin | null {
    for (const pin of this.pins) {
      if (this.isDismissed(pin.pinId)) continue
      if (isPinExpired(pin, this.nowMs)) continue
      return pin
    }
    return null
  }

  isDismissed(pinId: string): boolean {
    return this.dismissed.includes(pinId)
  }

  /** Dismiss by PIN id (persisted; a NEW pin id still shows normally). */
  dismiss(pinId: string): void {
    if (!pinId || this.dismissed.includes(pinId)) return
    this.dismissed = [...this.dismissed, pinId]
    if (this.dismissed.length > MAX_DISMISSED_PINS) {
      this.dismissed = this.dismissed.slice(this.dismissed.length - MAX_DISMISSED_PINS)
    }
    try {
      localStorage.setItem(DISMISSED_KEY, JSON.stringify(this.dismissed))
    } catch {
      /* quota or disabled */
    }
    this.updateExpiryTicker()
  }

  private async refresh(): Promise<void> {
    const enabled = this.deps.enabled()
    if (!enabled) {
      this.wasEnabled = false
      if (this.pins.length > 0) this.pins = []
      this.updateExpiryTicker()
      return
    }
    if (!this.wasEnabled) {
      // The toggle just turned on — fetch now rather than at the next cycle.
      this.lastFetchAt = 0
      this.lastFetchChannel = null
    }
    this.wasEnabled = true
    const channel = this.targetChannel
    if (!channel || this.inFlight) return
    if (channel === this.lastFetchChannel && this.deps.now() - this.lastFetchAt < this.deps.intervalMs) {
      return
    }
    this.inFlight = true
    try {
      const userId = await this.ensureUserId(channel)
      if (!userId) return // resolution pending — its completion re-calls refresh
      const raw = await this.deps.fetch(userId)
      if (this.targetChannel !== channel) return // superseded by a later join
      this.pins = raw.map(toDisplayPin)
    } catch {
      // Transport failure: degrade to the last-known pin (or none) — never
      // let the failure reach the chat path, never trip any breaker.
    } finally {
      this.inFlight = false
    }
    // Record the attempt only when a fetch actually happened this pass (the
    // resolution-pending return above must not count, or the retry it
    // schedules would be throttled away).
    this.lastFetchChannel = channel
    this.lastFetchAt = this.deps.now()
    this.updateExpiryTicker()
  }

  // Numeric id for channels whose caller has no status batch (multi-view).
  // Successes are memoized for the app's lifetime; failures are memoized as
  // '' for userIdRetryMs only, so a transient blip costs one retry per TTL
  // window instead of silencing the channel's pins until restart — and never
  // one request per poll.
  private async ensureUserId(channel: string): Promise<string | null> {
    if (this.targetUserId) return this.targetUserId
    const memo = this.userIdMemo.get(channel)
    if (memo !== undefined) {
      if (memo) return memo
      const failedAt = this.userIdFailedAt.get(channel) ?? 0
      if (this.deps.now() - failedAt < this.deps.userIdRetryMs) return null
      this.userIdMemo.delete(channel)
      this.userIdFailedAt.delete(channel)
    }
    if (this.resolvingIds.has(channel)) return null
    this.resolvingIds.add(channel)
    try {
      const id = await this.deps.resolveUserId(channel)
      if (id) {
        this.userIdMemo.set(channel, id)
      } else {
        this.userIdMemo.set(channel, '')
        this.userIdFailedAt.set(channel, this.deps.now())
      }
      return id
    } finally {
      this.resolvingIds.delete(channel)
    }
  }

  // Keep the local clock ticking only while a bounded pin could expire;
  // no timer runs when nothing is shown (or nothing has an endsAt).
  private updateExpiryTicker(): void {
    const needsTicker = this.pins.some((p) => !this.isDismissed(p.pinId) && p.endsAtMs != null)
    if (needsTicker && this.expiryTimer == null) {
      this.expiryTimer = setInterval(() => this.refreshNow(), EXPIRY_TICK_MS)
    } else if (!needsTicker && this.expiryTimer != null) {
      clearInterval(this.expiryTimer)
      this.expiryTimer = null
    }
  }
}

export const pinnedChat = new PinnedChatStore()
