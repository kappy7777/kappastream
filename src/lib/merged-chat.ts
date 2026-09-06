// Pure logic for MERGED multi-view chats: any subset of the open tiles'
// chats combined into one interleaved stream. The UI state (the merge
// group, whether the merged stream is displayed, the picker dropdown)
// lives in MultiView.svelte; these helpers are the testable core, in the
// same spirit as tile-store.svelte.ts.
//
// Merging is session-only state (never persisted), exactly like multi-view
// itself and the splitter positions — restoring a merge across restarts
// would resurrect tiles the user closed.

import type { ChatMessage } from './chat-session.svelte'

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
 * Toggle one tile's membership in the merge group. ADDING always persists
 * (a one-member group is a pending selection — the first tick must stick
 * for a second to join it); REMOVING collapses anything smaller than two
 * members to the empty group, because a one-member "merge" left over from
 * removals is not a selection, it is a stale leftover. The merged VIEW is
 * gated on length >= 2 by the caller.
 */
export function toggleMergedId(current: string[], tileId: string): string[] {
  if (current.includes(tileId)) {
    const next = current.filter((x) => x !== tileId)
    return next.length >= 2 ? next : []
  }
  return [...current, tileId]
}

/**
 * Reconcile the merge group against the live tiles (a tile was closed or
 * replaced-by-close): gone ids are dropped, and a group smaller than two
 * collapses to empty. Returns the SAME array reference when nothing
 * changed so callers (an $effect) can skip a redundant state write.
 */
export function reconcileMergedIds(current: string[], liveTileIds: string[]): string[] {
  const next = current.filter((id) => liveTileIds.includes(id))
  if (next.length === current.length) return current
  return next.length >= 2 ? next : []
}
