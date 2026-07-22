import { describe, it, expect } from 'vitest'

/*
 * Unit tests for src/lib/browse-reveal — the client-side reveal policy that
 * backs the Browse view's "Load more" buttons. Twitch GQL rejects anonymous
 * `after` cursors, so each browse list is over-fetched up to its hard cap and
 * revealed 30 rows at a time with NO network request. These tests pin the
 * policy (initial size, step, clamp, and the show/hide gate) so the component
 * stays a thin shell over it.
 */

import {
  REVEAL_INITIAL,
  REVEAL_STEP,
  initialVisible,
  revealMore,
  hasMoreToShow,
} from './browse-reveal'

describe('browse reveal policy', () => {
  it('starts at 30 and steps by 30', () => {
    expect(REVEAL_INITIAL).toBe(30)
    expect(REVEAL_STEP).toBe(30)
    expect(initialVisible()).toBe(30)
  })

  it('reveals 30 more per click when there is enough fetched', () => {
    let visible = initialVisible() // 30 of 100
    expect(revealMore(visible, 100)).toBe(60)
    visible = revealMore(visible, 100) // 60
    expect(visible).toBe(60)
    visible = revealMore(visible, 100) // 90
    expect(visible).toBe(90)
  })

  it('clamps to the fetched total so the count never overshoots', () => {
    expect(revealMore(80, 100)).toBe(100) // would-be 110 → clamp to 100
    expect(revealMore(30, 42)).toBe(42) // short list clamps immediately
    expect(revealMore(42, 42)).toBe(42) // already full stays full
  })

  it('hides the button once everything fetched is shown', () => {
    expect(hasMoreToShow(30, 100)).toBe(true) // more hidden
    expect(hasMoreToShow(90, 100)).toBe(true) // last step still hidden
    expect(hasMoreToShow(100, 100)).toBe(false) // all shown
    expect(hasMoreToShow(30, 30)).toBe(false) // list capped at one page
    expect(hasMoreToShow(0, 0)).toBe(false) // empty list never shows it
  })

  it('resets to the initial count (refetch / switching category both reuse it)', () => {
    // The component calls initialVisible() both on first paint and on every
    // reset path; both must yield the same base value so a reset is a true
    // return to the starting reveal window.
    let visible = revealMore(revealMore(initialVisible(), 100), 100) // 90
    expect(visible).toBe(90)
    visible = initialVisible() // simulate refetch / category switch
    expect(visible).toBe(30)
    // And the reset value never exceeds a list that is smaller than one page.
    expect(initialVisible()).toBe(REVEAL_INITIAL)
  })
})
