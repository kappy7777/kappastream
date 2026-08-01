/*
 * VOD chat replay — past-broadcast comments synced to the playhead.
 *
 * EFFICIENCY is the primary design goal. The Phase 0 measurement run (see the
 * spike notes in gql.ts `fetchVodCommentPage`) established the endpoint's
 * paging model, and every number below is derived from it:
 *
 *   - A page is a contiguous slice of the comment total-order bounded by a
 *     COUNT ceiling (~59–60 comments). DENSE chat (xqc) → those 60 span ~9 s;
 *     SPARSE chat → they span a minute or more.
 *   - The page anchors slightly before and well after the requested offset, and
 *     consecutive pages OVERLAP heavily (so every request re-fetches some prior
 *     comments → dedup by comment id is mandatory).
 *   - `contentOffsetSeconds` is an Int argument and all returned offsets are
 *     whole numbers, so `+1` is exact.
 *   - The gap-free advance rule is `nextOffset = lastCommentOffset + 1`
 *     (verified MISSING=0 against a dense 1 s ground-truth walk on firehose /
 *     mid / small VODs). Cursor paging is integrity-blocked and `first`/`last`
 *     are ignored, so this offset walk is the ONLY viable path.
 *
 * Real-time cost (advance = maxOff+1, measured): ~6.7 req/min on a firehose,
 * ~1.3 req/min mid, ~2.2 req/min small — and Phase 4 guards cut that further
 * (no fetch while paused / chat hidden / VOD closed).
 *
 * The engine is transport-agnostic and generic over the rendered message type
 * <M>: it only knows offsets + ids. App.svelte supplies a `fetchPage` that goes
 * through the existing `gql_fetch` path (no second transport) and normalizes
 * each comment into the shared chat shape, so ONE renderer handles live + replay.
 */

import { parseBadges, normalizeColor, type ParsedMessage, type BadgeInfo } from './irc'
import type { EmoteRange } from './emotes'
import { fetchVodCommentPage, type VodCommentNode } from './gql'

// ---------------------------------------------------------------------------
// Phase 1 — normalize a raw GQL comment node into the shared ParsedMessage
// shape (irc.ts) so the live-chat renderer handles replay unchanged.
// ---------------------------------------------------------------------------

/**
 * Convert one VOD comment node into a ParsedMessage tagged with its broadcast
 * offset. The flat message text is the concatenation of `fragments[].text`,
 * and each emote fragment contributes an inclusive char range
 * `[start, start+len-1]` into that joined string. The offset is accumulated
 * locally (NOT read from the server `from` field) so the ranges are provably
 * correct regardless of how `from` is defined.
 *
 * Returns null for a node with no id (defensive; the transport already drops
 * those). `bits` is always null — the comment payload carries no bits amount
 * (cheer emotes still render, but the Tier-2 bits indicator has no source).
 */
export function normalizeVodComment(node: VodCommentNode, channel: string): VodComment | null {
  if (!node || !node.id) return null
  const commenter = node.commenter ?? null
  const msg = node.message ?? null

  let text = ''
  const twitchEmotes: EmoteRange[] = []
  for (const f of msg?.fragments ?? []) {
    const ftext = f.text ?? ''
    if (f.emote?.emoteID) {
      const start = text.length
      twitchEmotes.push({ start, end: start + ftext.length - 1, id: String(f.emote.emoteID) })
    }
    text += ftext
  }

  // Reuse the IRC badge pipeline so the global map + per-channel render-time
  // override both apply. Empty setID rows (the payload sometimes sends
  // {setID:"",version:""}) are dropped before formatting.
  const badgeStrs: string[] = []
  for (const b of msg?.userBadges ?? []) {
    if (b.setID) badgeStrs.push(b.setID + '/' + (b.version || '1'))
  }
  const badges: BadgeInfo[] = parseBadges(badgeStrs)

  const pm: ParsedMessage = {
    id: node.id,
    channel,
    username: commenter?.login ?? '',
    displayName: commenter?.displayName || commenter?.login || '',
    color: normalizeColor(msg?.userColor ?? undefined),
    message: text,
    rawColor: msg?.userColor ?? null,
    isAction: false,
    twitchEmotes,
    badges,
    timestamp: node.createdAt ? Date.parse(node.createdAt) || Date.now() : Date.now(),
    userId: commenter?.id ?? null,
    bits: null,
  }
  return { offset: node.contentOffsetSeconds, id: node.id, pm }
}

/** A normalized comment tagged with its broadcast offset + stable id. */
export interface VodComment {
  offset: number
  id: string
  pm: ParsedMessage
}

/** One fetched page: normalized comments + the highest offset in the page. */
export interface VodCommentPage {
  comments: VodComment[]
  maxOffset: number
}

/**
 * Fetch + normalize one comment page through the existing `gql_fetch` path.
 * `channel` is stamped onto each ParsedMessage.channel (the renderer does not
 * display it, but it keeps the shape honest). An empty page is a success
 * (returns maxOffset = the requested offset, comments = []); the sync engine
 * treats empty as end-of-comments.
 */
export async function fetchVodComments(
  videoId: string,
  channel: string,
  offset: number,
  signal?: AbortSignal,
): Promise<VodCommentPage> {
  const nodes = await fetchVodCommentPage(videoId, offset, signal)
  const comments: VodComment[] = []
  let maxOffset = offset
  for (const node of nodes) {
    const c = normalizeVodComment(node, channel)
    if (!c) continue
    comments.push(c)
    if (c.offset > maxOffset) maxOffset = c.offset
  }
  return { comments, maxOffset }
}

// ---------------------------------------------------------------------------
// Phase 2 — sync engine. Bounded-ahead buffer; advances by maxOff+1; seeks
// discard + refetch (debounced); degrades to no chat on failure.
// ---------------------------------------------------------------------------

/** A fetched comment tagged for the (generic) rendered message type. */
export interface VodChatPageEntry<M> {
  offset: number
  id: string
  msg: M
}
export interface VodChatPage<M> {
  comments: VodChatPageEntry<M>[]
  maxOffset: number
}
export type VodChatFetcher<M> = (
  videoId: string,
  offset: number,
  signal: AbortSignal,
) => Promise<VodChatPage<M>>

export interface VodChatDeps<M> {
  fetchPage: VodChatFetcher<M>
  /** Current playhead in seconds (video.currentTime). */
  getPlayhead: () => number
  /** True when playback is paused (or no VOD is active) — gates fetching. */
  getPaused: () => boolean
  /** True when the chat panel is visible — gates fetching (biggest saving). */
  getChatVisible: () => boolean
}

// How far ahead of the playhead to buffer. Worst case (a firehose at ~9 s new
// coverage per request) this is ~7 pages; a seek discards at most that much
// prefetched data. One request lands in well under a second, so 60 s comfortably
// covers a slow/timeout request with no playback starvation.
const MARGIN_AHEAD_S = 60
// Cap the rendered (drained) list so a long VOD never accumulates unbounded DOM.
const VISIBLE_CAP = 500
// Drain cadence. Chat is not frame-precise; 250 ms keeps it smooth and ties
// draining to real playback progress (the loop reads the live playhead).
const TICK_MS = 250
// Scrubbing fires many `seeking` events; collapse them into one refetch.
const SEEK_DEBOUNCE_MS = 500
// Back off this long after any fetch failure (429 / IntegrityCheckFailed /
// network) before a single retry — never a tight retry loop.
const BACKOFF_MS = 30_000

/**
 * Drives VOD chat replay for one video at a time. Owns a bounded-ahead buffer
 * (not yet at the playhead) and a capped visible list (at/behind the playhead,
 * what the renderer shows). A 250 ms tick drains buffered comments whose offset
 * has passed the playhead and tops the buffer up only when the ahead-margin
 * drops below `MARGIN_AHEAD_S` AND the Phase 4 guards pass (not paused, chat
 * visible, VOD active).
 *
 * Concurrency: EXACTLY one in-flight request at a time (`inFlight`). A
 * generation token + AbortController discard results from a superseded
 * seek/resync/stop (the in-flight HTTP still completes; its result is dropped).
 * On any fetch failure the engine sets `failed`, schedules ONE backoff retry,
 * and leaves already-drained chat in place — a replay failure never breaks
 * playback.
 */
export class VodChatController<M> {
  /** Drained comments at/behind the playhead — the render source. */
  visible = $state<M[]>([])
  /** True after a fetch failure (429/integrity/network) while backed off. */
  failed = $state(false)

  private readonly deps: VodChatDeps<M>
  private buffer: { offset: number; msg: M }[] = []
  private seen = new Set<string>()
  private playhead = 0
  private nextOffset = 0
  private maxFetched = 0
  private eof = false
  private inFlight = false
  private videoId: string | null = null
  private generation = 0
  private aborter: AbortController | null = null
  private tickTimer: ReturnType<typeof setInterval> | null = null
  private seekTimer: ReturnType<typeof setTimeout> | null = null
  private backoffTimer: ReturnType<typeof setTimeout> | null = null

  constructor(deps: VodChatDeps<M>) {
    this.deps = deps
  }

  /** Begin replay for `videoId` at `atOffset` seconds (the resume position). */
  start(videoId: string, atOffset = 0): void {
    this.stopTimers()
    this.videoId = videoId
    this.failed = false
    this.inFlight = false
    this.eof = false
    this.resetBuffers()
    const start = Math.max(0, Math.floor(atOffset))
    this.playhead = start
    this.nextOffset = start
    this.maxFetched = start
    this.generation++
    this.aborter = new AbortController()
    this.tickTimer = setInterval(() => this.tick(), TICK_MS)
    this.maybeFetch()
  }

  /** A user scrub. Debounced (~500 ms) so dragging the bar = one refetch. */
  seek(seconds: number): void {
    if (this.videoId == null) return
    const target = Math.max(0, Math.floor(seconds))
    if (this.seekTimer) clearTimeout(this.seekTimer)
    this.seekTimer = setTimeout(() => {
      this.seekTimer = null
      if (this.videoId == null) return
      this.resync(target)
    }, SEEK_DEBOUNCE_MS)
  }

  /** Stop all replay activity (VOD closed / channel changed / mode left). */
  stop(): void {
    this.stopTimers()
    this.aborter?.abort()
    this.aborter = null
    this.generation++
    this.videoId = null
    this.inFlight = false
    this.failed = false
    this.eof = false
    this.resetBuffers()
  }

  private stopTimers(): void {
    if (this.tickTimer) {
      clearInterval(this.tickTimer)
      this.tickTimer = null
    }
    if (this.seekTimer) {
      clearTimeout(this.seekTimer)
      this.seekTimer = null
    }
    if (this.backoffTimer) {
      clearTimeout(this.backoffTimer)
      this.backoffTimer = null
    }
  }

  private resetBuffers(): void {
    this.buffer = []
    this.seen = new Set()
    this.visible = []
  }

  // Discard everything and refetch at a new offset (seek, or resync after the
  // chat was hidden while the video kept playing). Bumps generation so any
  // in-flight result from the old position is dropped.
  private resync(offset: number): void {
    this.inFlight = false
    this.failed = false
    this.eof = false
    this.resetBuffers()
    this.playhead = offset
    this.nextOffset = offset
    this.maxFetched = offset
    this.generation++
    this.aborter?.abort()
    this.aborter = new AbortController()
    this.maybeFetch()
  }

  private tick(): void {
    if (this.videoId == null) return
    const raw = this.deps.getPlayhead()
    if (!Number.isFinite(raw)) return
    const t = Math.max(0, Math.floor(raw))
    if (t !== this.playhead) {
      this.playhead = t
      this.drain()
    }
    this.maybeFetch()
  }

  // Move buffered comments whose offset has reached the playhead into `visible`,
  // capped to VISIBLE_CAP (oldest trimmed). Buffer is offset-sorted ascending.
  private drain(): void {
    if (this.buffer.length === 0) return
    let i = 0
    for (; i < this.buffer.length; i++) {
      if (this.buffer[i].offset > this.playhead) break
    }
    if (i === 0) return
    const ready = this.buffer.splice(0, i)
    const next = this.visible.concat(ready.map((e) => e.msg))
    this.visible = next.length > VISIBLE_CAP ? next.slice(next.length - VISIBLE_CAP) : next
  }

  // Phase 4 guards + margin top-up. Idempotent; called from the tick and after
  // every fetch / guard change.
  private maybeFetch(): void {
    if (this.videoId == null || this.eof || this.inFlight || this.failed) return
    if (this.deps.getPaused()) return // no fetch while paused
    if (!this.deps.getChatVisible()) return // no fetch while chat hidden
    // If we have no data at/after the playhead (chat was hidden while the video
    // played, so fetching was paused), jump to the current moment instead of
    // draining a stale behind-playhead page. (Cannot fire while a fetch is
    // in-flight — `inFlight` short-circuits above.)
    if (this.maxFetched < this.playhead) {
      this.resync(this.playhead)
      return
    }
    const ahead = this.maxFetched - this.playhead
    if (ahead >= MARGIN_AHEAD_S) return // enough buffered ahead
    void this.fetchNext()
  }

  private async fetchNext(): Promise<void> {
    if (this.videoId == null || !this.aborter) return
    const gen = this.generation
    const id = this.videoId
    const offset = this.nextOffset
    const signal = this.aborter.signal
    this.inFlight = true
    try {
      const page = await this.deps.fetchPage(id, offset, signal)
      if (gen !== this.generation) return // superseded by seek/resync/stop
      this.inFlight = false
      if (page.comments.length === 0) {
        this.eof = true
        return
      }
      for (const c of page.comments) {
        if (this.seen.has(c.id)) continue // overlap is guaranteed, not hypothetical
        this.seen.add(c.id)
        this.buffer.push({ offset: c.offset, msg: c.msg })
      }
      // Pages arrive ascending and we advance forward, but sort defensively so
      // `drain`'s front-scan is always correct.
      if (this.buffer.length > 1) this.buffer.sort((a, b) => a.offset - b.offset)
      if (page.maxOffset > this.maxFetched) this.maxFetched = page.maxOffset
      // The gap-free advance rule (Phase 0). The Math.max guards forward
      // progress in the impossible case a page didn't bracket its offset.
      this.nextOffset = Math.max(page.maxOffset + 1, offset + 1)
      this.drain()
      this.maybeFetch() // keep filling the margin (one request at a time)
    } catch (err) {
      if (gen !== this.generation) return // superseded — not a real failure
      this.inFlight = false
      // An abort issued by a newer seek/resync/stop arrives here too; it is not
      // a transport failure, so leave the failure state untouched.
      if (signal.aborted) return
      this.handleFailure(err)
    }
  }

  // Back off and schedule a single retry. Already-drained chat stays visible
  // (graceful degrade); the placeholder surfaces `failed` only when empty.
  private handleFailure(_err: unknown): void {
    this.failed = true
    if (this.backoffTimer) clearTimeout(this.backoffTimer)
    this.backoffTimer = setTimeout(() => {
      this.backoffTimer = null
      if (this.videoId == null) return
      this.failed = false
      this.maybeFetch()
    }, BACKOFF_MS)
  }
}
