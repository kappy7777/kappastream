// Pins the BrowseView category race: open category A, go back, open B
// quickly — A's late fetchGameStreams answer must not fill B's page. The
// identity check after the await (activeCategory !== category ⇒ drop) is the
// guard under test.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mount, unmount } from 'svelte'

const gqlMock = vi.hoisted(() => ({
  // Deferred controllers per category name; tests resolve them by hand.
  pending: new Map<string, (streams: unknown[]) => void>(),
  calls: [] as string[],
}))

vi.mock('./gql', () => ({
  fetchTopStreams: vi.fn(async () => ({ streams: [] })),
  fetchTopCategories: vi.fn(async () => ({
    categories: [
      { id: '1', name: 'gamea', displayName: 'Game A', boxArtUrl: '' },
      { id: '2', name: 'gameb', displayName: 'Game B', boxArtUrl: '' },
    ],
  })),
  fetchGameStreams: vi.fn((name: string) => {
    gqlMock.calls.push(name)
    return new Promise((resolve) => {
      gqlMock.pending.set(name, (streams) => resolve({ streams }))
    })
  }),
}))

const BrowseView = (await import('./BrowseView.svelte')).default

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

function q(sel: string): HTMLElement {
  const el = document.querySelector(sel)
  if (!el) throw new Error('missing element: ' + sel)
  return el as HTMLElement
}

let view: ReturnType<typeof mount> | null = null

beforeEach(() => {
  gqlMock.pending.clear()
  gqlMock.calls.length = 0
})

afterEach(() => {
  if (view) void unmount(view)
  view = null
})

describe('BrowseView category drill-in race', () => {
  it("a late answer from category A never fills category B's page", async () => {
    const target = document.createElement('div')
    document.body.appendChild(target)
    view = mount(BrowseView, { target, props: { onselect: () => {}, onclose: () => {} } })
    await sleep(150)

    // Open A (its fetch parks on the deferred).
    const cards = document.querySelectorAll<HTMLButtonElement>('.cat-card')
    expect(cards.length).toBe(2)
    cards[0]!.click()
    await sleep(30)
    expect(gqlMock.calls).toEqual(['gamea'])

    // Back to the overview, then open B — A is STILL pending.
    q('.browse-back').click()
    await sleep(30)
    const cards2 = document.querySelectorAll<HTMLButtonElement>('.cat-card')
    cards2[1]!.click()
    await sleep(30)
    expect(gqlMock.calls).toEqual(['gamea', 'gameb'])

    // A resolves LAST — its answer must be dropped, not written into B's page.
    gqlMock.pending.get('gameb')!([{ login: 'chanb', title: 'B stream' }])
    gqlMock.pending.get('gamea')!([{ login: 'chana', title: 'A stream' }])
    await sleep(80)

    const text = document.body.textContent ?? ''
    expect(text).toContain('B stream')
    expect(text).not.toContain('A stream')
  }, 15000)
})
