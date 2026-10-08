import { describe, it, expect } from 'vitest'
import {
  newChatEntryCount,
  singleChatEntries,
  mergedChatEntries,
  toggleMergedId,
  reconcileMergedIds,
  planExtraChatAdd,
  extraChatId,
  extraChatChannel,
  isExtraChatId,
  type ChatEntry,
  type MergeSource,
} from './merged-chat'
import type { ChatMessage } from './chat-session.svelte'

/*
 * Pure logic for merged multi-view chats (src/lib/merged-chat.ts): group
 * membership toggling + reconciliation, and the interleaved view model the
 * chat pane renders. The UI state lives in MultiView.svelte; everything
 * tested here is side-effect free.
 */

// Minimal ChatMessage factory — only the fields the merge logic reads
// (id, timestamp) vary per test; the rest are inert defaults.
function msg(id: string, timestamp: number): ChatMessage {
  return {
    kind: 'message',
    id,
    username: 'user_' + id,
    color: '#9146FF',
    raw: '',
    parts: [],
    badges: [],
    isAction: false,
    emoteOnly: false,
    timestamp,
    bits: null,
    userId: null,
    login: null,
    deleted: false,
    deletedReason: null,
    systemText: null,
    noticeMsgId: null,
  }
}

function source(
  tileId: string,
  channel: string,
  messages: ChatMessage[],
  override: MergeSource['override'] = null,
): MergeSource {
  return { tileId, channel, override, messages }
}

describe('toggleMergedId — merge-group membership', () => {
  it('the FIRST tick sticks (a pending one-member group), the second forms the merge', () => {
    const pending = toggleMergedId([], 't1')
    expect(pending).toEqual(['t1'])
    expect(toggleMergedId(pending, 't2')).toEqual(['t1', 't2'])
  })

  it('a group grows further', () => {
    expect(toggleMergedId(['t1', 't2'], 't3')).toEqual(['t1', 't2', 't3'])
  })

  it('removing one of three keeps the group; removing down to one collapses it', () => {
    expect(toggleMergedId(['t1', 't2', 't3'], 't3')).toEqual(['t1', 't2'])
    expect(toggleMergedId(['t1', 't2'], 't2')).toEqual([])
  })

  it('removing from a pending one-member group turns merging off', () => {
    expect(toggleMergedId(['t1'], 't1')).toEqual([])
  })

  it('preserves the order of the remaining members', () => {
    expect(toggleMergedId(['t1', 't2', 't3'], 't1')).toEqual(['t2', 't3'])
  })

  it('adding no-ops at the cap; removal keeps working there', () => {
    const full = ['t1', 't2', 't3', 't4', 'chat:c5', 'chat:c6']
    expect(toggleMergedId(full, 'chat:c7')).toBe(full)
    expect(toggleMergedId(full, 't1')).toEqual(['t2', 't3', 't4', 'chat:c5', 'chat:c6'])
  })
})

describe('chat-only member ids (the chat:<channel> pseudo-id form)', () => {
  it('round-trips a channel through the pseudo-id form', () => {
    const id = extraChatId('chan1')
    expect(isExtraChatId(id)).toBe(true)
    expect(extraChatChannel(id)).toBe('chan1')
  })

  it('tile ids (UUIDs — hyphens only) are never mistaken for chat-only ids', () => {
    expect(isExtraChatId('0f0f7c8e-1111-4d2d-9d2a-2b1d5c9e7a33')).toBe(false)
  })

  it('pseudo-id keys cannot collide with tile-id keys in the view model', () => {
    const entries = mergedChatEntries([
      source('t1', 'chan1', [msg('same', 1)]),
      source(extraChatId('chan2'), 'chan2', [msg('same', 2)]),
    ])
    expect(entries.map((e) => e.key)).toEqual(['t1:same', 'chat:chan2:same'])
  })
})

describe('reconcileMergedIds — keep the group valid as tiles change', () => {
  const tiles = (...pairs: Array<[string, string]>): Array<{ id: string; channel: string }> =>
    pairs.map(([id, channel]) => ({ id, channel }))

  it('all members alive → SAME array reference (no redundant state write)', () => {
    const group = ['t1', 't2', 'chat:chan3']
    expect(reconcileMergedIds(group, tiles(['t0', 'chan0'], ['t1', 'chan1'], ['t2', 'chan2']))).toBe(group)
  })

  it('drops closed tiles, keeping the group while two remain', () => {
    expect(reconcileMergedIds(['t1', 't2', 't3'], tiles(['t1', 'chan1'], ['t3', 'chan3']))).toEqual(['t1', 't3'])
  })

  it('collapses to empty when fewer than two members survive a LOSS', () => {
    expect(reconcileMergedIds(['t1', 't2'], tiles(['t2', 'chan2']))).toEqual([])
    expect(reconcileMergedIds(['t1', 't2'], [])).toEqual([])
    // A doubled channel deduping down to one membership is a loss too.
    expect(reconcileMergedIds(['chat:chan2', 't2'], tiles(['t2', 'chan2']))).toEqual([])
  })

  it('a chat-only member whose channel gets a tile MIGRATES to that tile id', () => {
    // The group keeps its size, the tile's checkbox shows checked, and the
    // chat-only session is released instead of doubling the channel through
    // two connections.
    expect(reconcileMergedIds(['t1', 'chat:chan2'], tiles(['t1', 'chan1'], ['t2', 'chan2']))).toEqual(['t1', 't2'])
  })

  it('a PENDING one-member selection migrates instead of being dropped', () => {
    // The first tick of a group is a pending selection the user made; its
    // channel getting a tile must CARRY the selection over to that tile
    // (the group stays "formed by adding", not a removal leftover).
    expect(reconcileMergedIds(['chat:chan1'], tiles(['t1', 'chan1']))).toEqual(['t1'])
  })

  it('chat-only members with no matching tile survive reconcile (no tile to die with)', () => {
    const group = ['chat:chan1', 'chat:chan2']
    expect(reconcileMergedIds(group, tiles(['t9', 'chan9']))).toBe(group)
  })

  it('an EMPTY grid drops chat-only members too (wholesale teardown)', () => {
    // exitAll paths (sleep timer, hide-to-tray) keep multi-view mounted
    // with no tiles: the headless IRC sessions must not outlive the grid
    // they were merged alongside — there is no picker left to remove them
    // with (the merge button needs a tile).
    expect(reconcileMergedIds(['chat:chan1', 'chat:chan2'], [])).toEqual([])
    const empty: string[] = []
    expect(reconcileMergedIds(empty, [])).toBe(empty)
  })

  it('migration is a CHANGE even with no drops (fresh array, not the same reference)', () => {
    const group = ['chat:chan1', 'chat:chan2']
    const next = reconcileMergedIds(group, tiles(['t1', 'chan1'], ['t2', 'chan2']))
    expect(next).toEqual(['t1', 't2'])
    expect(next).not.toBe(group)
  })

  it('a channel that was a member twice (chat-only AND its tile) keeps ONE membership', () => {
    // t2 is chan2's tile and was ticked while chat:chan2 was still a member
    // — the migration must not leave a doubled id behind.
    expect(reconcileMergedIds(['t1', 'chat:chan2', 't2'], tiles(['t1', 'chan1'], ['t2', 'chan2']))).toEqual([
      't1',
      't2',
    ])
  })
})

describe('planExtraChatAdd — the picker input decision', () => {
  it('normalizes like the favorites add field: trim, strip #, lowercase', () => {
    expect(planExtraChatAdd('  #SomeChan ', [], [])).toEqual({ ok: true, next: ['chat:somechan'] })
  })

  it('rejects names that are not channel logins', () => {
    expect(planExtraChatAdd('', [], [])).toEqual({ ok: false, reason: 'invalid' })
    expect(planExtraChatAdd('bad-name', [], [])).toEqual({ ok: false, reason: 'invalid' })
    expect(planExtraChatAdd('x'.repeat(26), [], [])).toEqual({ ok: false, reason: 'invalid' })
  })

  it('rejects channels that already have a tile (merge the TILE instead)', () => {
    expect(planExtraChatAdd('chan1', ['t2'], ['chan1'])).toEqual({ ok: false, reason: 'tile-open' })
  })

  it('rejects a channel already merged chat-only', () => {
    expect(planExtraChatAdd('chan1', ['chat:chan1'], [])).toEqual({ ok: false, reason: 'already-merged' })
  })

  it('rejects past the group cap', () => {
    const full = ['t1', 't2', 't3', 't4', 'chat:c5', 'chat:c6']
    expect(planExtraChatAdd('chan7', full, [])).toEqual({ ok: false, reason: 'full' })
  })

  it('appends the pseudo-id, preserving member order', () => {
    expect(planExtraChatAdd('chan3', ['t1', 'chat:c2'], ['chan1'])).toEqual({
      ok: true,
      next: ['t1', 'chat:c2', 'chat:chan3'],
    })
  })
})

describe('mergedChatEntries — the interleaved view model', () => {
  it('interleaves sources by arrival time, not by source', () => {
    const entries = mergedChatEntries([
      source('t1', 'chan1', [msg('a1', 1_000), msg('a2', 3_000)]),
      source('t2', 'chan2', [msg('b1', 2_000), msg('b2', 4_000)]),
    ])
    expect(entries.map((e) => e.msg.id)).toEqual(['a1', 'b1', 'a2', 'b2'])
  })

  it('keys are namespaced per tile — identical message ids can never collide', () => {
    const entries = mergedChatEntries([
      source('t1', 'chan1', [msg('same', 1)]),
      source('t2', 'chan2', [msg('same', 2)]),
    ])
    expect(entries.map((e) => e.key)).toEqual(['t1:same', 't2:same'])
  })

  it('carries per-entry attribution: tile, channel, and badge override', () => {
    const ov = { subscriber: { '1': 'uuid-1' } }
    const [e1, e2] = mergedChatEntries([source('t1', 'chan1', [msg('a', 1)], ov), source('t2', 'chan2', [msg('b', 2)])])
    expect(e1.tileId).toBe('t1')
    expect(e1.channel).toBe('chan1')
    expect(e1.override).toBe(ov)
    expect(e2.tileId).toBe('t2')
    expect(e2.channel).toBe('chan2')
    expect(e2.override).toBeNull()
  })

  it('equal timestamps keep stable per-source order (deterministic render)', () => {
    const entries = mergedChatEntries([
      source('t1', 'chan1', [msg('a1', 5_000), msg('a2', 5_000)]),
      source('t2', 'chan2', [msg('b1', 5_000)]),
    ])
    expect(entries.map((e) => e.msg.id)).toEqual(['a1', 'a2', 'b1'])
  })

  it('an empty source list renders nothing', () => {
    expect(mergedChatEntries([])).toEqual([])
  })
})

describe('singleChatEntries — the plain one-session view model', () => {
  it('passes the buffer through with keys and NO attribution', () => {
    const [m1, m2] = [msg('a', 1), msg('b', 2)]
    const entries = singleChatEntries([m1, m2], null)
    expect(entries).toHaveLength(2)
    expect(entries[0]!.key).toBe('a')
    expect(entries[0]!.msg).toBe(m1)
    expect(entries[0]!.tileId).toBeNull()
    expect(entries[0]!.channel).toBeNull()
  })

  it('attaches the session badge override to every entry', () => {
    const ov = { subscriber: { '1': 'uuid-1' } }
    const entries = singleChatEntries([msg('a', 1)], ov)
    expect(entries[0]!.override).toBe(ov)
  })
})

describe('newChatEntryCount — the jump pill count survives the buffer cap', () => {
  const entriesOf = (ids: string[]): ChatEntry[] =>
    singleChatEntries(
      ids.map((id, i) => msg(id, i)),
      null,
    )

  it('counts appendees past the last-seen key', () => {
    const after = entriesOf(['m1', 'm2', 'm3', 'm4', 'm5'])
    expect(newChatEntryCount(after, 'm3')).toBe(2)
  })

  it('reports 0 when nothing new arrived', () => {
    const entries = entriesOf(['m1', 'm2'])
    expect(newChatEntryCount(entries, 'm2')).toBe(0)
    expect(newChatEntryCount(entries, null)).toBe(0)
    expect(newChatEntryCount([], 'm2')).toBe(0)
  })

  it('past the 500 cap (marker near the end, buffer trimmed) still counts', () => {
    // THE regression: the buffer trims at 500, so the LENGTH freezes — the
    // old len-baseline difference returned 0 for every later message and the
    // pill's count stayed 0 forever while scrolled up.
    const ids = Array.from({ length: 500 }, (_, i) => 'm' + i)
    const marker = 'm499'
    // 3 new messages arrive; the 3 oldest are trimmed; length stays 500.
    const next = entriesOf([...ids.slice(3), 'n1', 'n2', 'n3'])
    expect(next.length).toBe(500)
    expect(newChatEntryCount(next, marker)).toBe(3)
  })

  it('everything visible counts when the marker was trimmed away entirely', () => {
    const next = entriesOf(Array.from({ length: 500 }, (_, i) => 'n' + i))
    expect(newChatEntryCount(next, 'm499')).toBe(500)
  })
})
