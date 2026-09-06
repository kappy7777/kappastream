import { describe, it, expect } from 'vitest'
import {
  singleChatEntries,
  mergedChatEntries,
  toggleMergedId,
  reconcileMergedIds,
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

function source(tileId: string, channel: string, messages: ChatMessage[], override: MergeSource['override'] = null): MergeSource {
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
})

describe('reconcileMergedIds — keep the group valid as tiles close', () => {
  it('all members alive → SAME array reference (no redundant state write)', () => {
    const group = ['t1', 't2', 't3']
    expect(reconcileMergedIds(group, ['t0', 't1', 't2', 't3'])).toBe(group)
  })

  it('drops closed tiles, keeping the group while two remain', () => {
    expect(reconcileMergedIds(['t1', 't2', 't3'], ['t1', 't3'])).toEqual(['t1', 't3'])
  })

  it('collapses to empty when fewer than two members survive', () => {
    expect(reconcileMergedIds(['t1', 't2'], ['t2'])).toEqual([])
    expect(reconcileMergedIds(['t1', 't2'], [])).toEqual([])
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
    const [e1, e2] = mergedChatEntries([
      source('t1', 'chan1', [msg('a', 1)], ov),
      source('t2', 'chan2', [msg('b', 2)]),
    ])
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
