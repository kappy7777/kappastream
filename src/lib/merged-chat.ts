// Pure logic for MERGED multi-view chats: any subset of the open tiles' chats
// — plus CHAT-ONLY channels with no tile of their own — combined into one
// interleaved stream. The UI state (the merge group, whether the merged
// stream is displayed, the picker dropdown) lives in MultiView.svelte; these
// helpers are the testable core, in the same spirit as
// tile-store.svelte.ts.
//
// Merging is session-only state (never persisted), exactly like multi-view
// itself and the splitter positions — restoring a merge across restarts
// would resurrect tiles the user closed.

import type { ChatMessage } from './chat-session.svelte'
import { isValidChannelName, normalizeChannelName } from './channel-name'

/**
 * Ceiling on the merge group's size (tiles + chat-only channels combined).
 * Every member is a live IRC connection whose 500-entry buffer feeds one
 * interleaved, timestamp-sorted render pass, so cost grows linearly per
 * source; six covers a full 2×2 grid plus two chat-only channels.
 */
export const MAX_MERGED_SOURCES = 6

/**
 * Chat-only members are encoded in the merge group as `chat:<channel>`
 * pseudo-ids. Tile ids are UUIDs (hyphens only, never ':'), so the forms can
 * never collide, and every consumer that only needs a unique key/namespace
 * can treat both shapes identically.
 */
const EXTRA_CHAT_ID_PREFIX = 'chat:'

export function extraChatId(channel: string): string {
  return EXTRA_CHAT_ID_PREFIX + channel
}

export function isExtraChatId(id: string): boolean {
  return id.startsWith(EXTRA_CHAT_ID_PREFIX)
}

export function extraChatChannel(id: string): string {
  return id.slice(EXTRA_CHAT_ID_PREFIX.length)
}

/**
 * One renderable chat entry. In the merged view every entry carries its
 * ORIGIN (tile id + channel + that session's badge override) so messages
 * can be attributed per channel and badges resolve against the right
 * channel's art; in the single-session view the attribution fields are
 * null and the renderer omits them.
 */
export interface ChatEntry {
  /** Unique key across ALL sessions (tile id + message id). */
  key: string
  /** Origin tile (null in single-session view — no attribution shown). */
  tileId: string | null
  /** Origin channel login (null in single-session view). */
  channel: string | null
  /** The origin session's per-channel badge override (null = global art). */
  override: Record<string, Record<string, string>> | null
  msg: ChatMessage
}

/** One merged source: a session's buffer plus its origin identity. */
export interface MergeSource {
  tileId: string
  channel: string
  override: Record<string, Record<string, string>> | null
  messages: ChatMessage[]
}

/**
 * Single-session view model: the session's buffer as entries WITHOUT
 * attribution (the pane shows one channel — per-message source marks would
 * be noise). Key is the bare message id; there is no cross-session
 * collision to guard against.
 */
export function singleChatEntries(
  messages: ChatMessage[],
  override: Record<string, Record<string, string>> | null,
): ChatEntry[] {
  return messages.map((m) => ({ key: m.id, tileId: null, channel: null, override, msg: m }))
}

/**
 * Merged view model: every source's buffer interleaved into ONE list by
 * arrival time (each session buffers independently, so timestamps are the
 * only honest ordering). Keys are namespaced `tileId:messageId` — Twitch
 * message ids are unique in practice, but CLEARMSG matching and synthetic
 * notice ids (crypto.randomUUID today, anything tomorrow) must never be
 * able to collide ACROSS sessions and wedge Svelte's keyed each.
 *
 * The sort is STABLE, so entries with identical timestamps keep their
 * per-source insertion order (deterministic rendering).
 */
export function mergedChatEntries(sources: MergeSource[]): ChatEntry[] {
  const out: ChatEntry[] = []
  for (const s of sources) {
    for (const m of s.messages) {
      out.push({ key: `${s.tileId}:${m.id}`, tileId: s.tileId, channel: s.channel, override: s.override, msg: m })
    }
  }
  out.sort((a, b) => a.msg.timestamp - b.msg.timestamp)
  return out
}

/**
 * Toggle one member's membership in the merge group (a tile id or a
 * `chat:<channel>` pseudo-id). ADDING always persists (a one-member group is
 * a pending selection — the first tick must stick for a second to join it)
 * but no-ops once the group is at `cap`: the merged stream's cost grows
 * linearly per source, so neither path (checkbox or picker input) may push
 * past it. REMOVING collapses anything smaller than two members to the empty
 * group, because a one-member "merge" left over from removals is not a
 * selection, it is a stale leftover. The merged VIEW is gated on length >= 2
 * by the caller.
 */
export function toggleMergedId(current: string[], id: string, cap = MAX_MERGED_SOURCES): string[] {
  if (current.includes(id)) {
    const next = current.filter((x) => x !== id)
    return next.length >= 2 ? next : []
  }
  if (current.length >= cap) return current
  return [...current, id]
}

/**
 * Reconcile the merge group against the live tiles (a tile was closed or
 * replaced-by-close): gone tile ids are dropped. A `chat:<channel>` member
 * whose channel LATER got a tile of its own MIGRATES to that tile's id —
 * the group keeps its size, the tile's checkbox shows checked, and the
 * chat-only session is released instead of doubling the channel's messages
 * through two connections. Migration is lossless, so a PENDING one-member
 * selection (`[chat:chan]` whose channel just got a tile) migrates to
 * `[tileId]` and stays a pending selection; only a group that LOST a
 * membership (a tile died, or a doubled channel deduped down) collapses
 * below two to empty — a leftover of removals is not a selection. With NO
 * tiles at all the whole group goes: multi-view torn down wholesale (sleep
 * timer, hide-to-tray) must not leave headless IRC sockets alive with no
 * grid to manage them from (the merge picker needs a tile). Returns the
 * SAME array reference when nothing changed so callers (an $effect) can
 * skip a redundant state write.
 */
export function reconcileMergedIds(
  current: string[],
  liveTiles: ReadonlyArray<{ id: string; channel: string }>,
): string[] {
  if (liveTiles.length === 0) {
    return current.length === 0 ? current : []
  }
  const tileByChannel = new Map(liveTiles.map((tile) => [tile.channel, tile.id]))
  const liveIds = new Set(liveTiles.map((tile) => tile.id))
  const kept: string[] = []
  let changed = false
  let lost = false
  const seen = new Set<string>()
  for (const id of current) {
    let mapped = id
    if (isExtraChatId(id)) {
      // A channel with a live tile joins through the tile from now on.
      mapped = tileByChannel.get(extraChatChannel(id)) ?? id
    } else if (!liveIds.has(id)) {
      mapped = ''
    }
    if (mapped === '') {
      changed = true
      lost = true
      continue
    }
    if (mapped !== id) changed = true
    if (seen.has(mapped)) {
      // The channel was a member twice (chat-only, then its tile got checked
      // before the migration ran) — one membership survives.
      changed = true
      lost = true
      continue
    }
    seen.add(mapped)
    kept.push(mapped)
  }
  if (!changed) return current
  return kept.length >= 2 || !lost ? kept : []
}

export type ExtraChatAddReason = 'invalid' | 'tile-open' | 'already-merged' | 'full' | 'not-found'
export type ExtraChatAddPlan = { ok: true; next: string[] } | { ok: false; reason: ExtraChatAddReason }

/**
 * Decide a picker-input submission: normalize the typed name (trim / strip a
 * leading '#' / lowercase, exactly like the favorites add field), then reject
 * names that are not channel logins, channels already in the group — checked
 * BEFORE the tile-open rejection, because typing a MERGED tile's channel
 * must say "already in the merge", not "use its checkbox" (it IS ticked) —
 * channels that already have a tile (merge the TILE instead — two
 * connections to one channel would double every message), and submissions
 * past the group cap. Pure so the whole rejection matrix is unit-testable;
 * the caller only maps the reason to an i18n string.
 */
export function planExtraChatAdd(
  rawName: string,
  mergedIds: string[],
  tiles: ReadonlyArray<{ id: string; channel: string }>,
): ExtraChatAddPlan {
  const channel = normalizeChannelName(rawName)
  if (!isValidChannelName(channel)) return { ok: false, reason: 'invalid' }
  const tile = tiles.find((t) => t.channel === channel)
  if (tile && mergedIds.includes(tile.id)) return { ok: false, reason: 'already-merged' }
  if (tile) return { ok: false, reason: 'tile-open' }
  if (mergedIds.includes(extraChatId(channel))) return { ok: false, reason: 'already-merged' }
  if (mergedIds.length >= MAX_MERGED_SOURCES) return { ok: false, reason: 'full' }
  return { ok: true, next: [...mergedIds, extraChatId(channel)] }
}

/**
 * How many entries arrived after the last-seen one — the jump pill's "N new"
 * count. Keyed by the last-seen entry KEY, not by length: the chat buffer is
 * capped (500), so once full the length stops growing and a length
 * difference would report every subsequent message as "not new" (the pill
 * stuck at 0 forever). When the marker itself has been trimmed away
 * everything visible is new.
 */
export function newChatEntryCount(entries: ChatEntry[], lastSeenKey: string | null): number {
  if (lastSeenKey === null) return 0
  if (entries.length === 0) return 0
  if (entries[entries.length - 1]!.key === lastSeenKey) return 0
  const idx = entries.findIndex((e) => e.key === lastSeenKey)
  if (idx === -1) return entries.length
  return entries.length - idx - 1
}
