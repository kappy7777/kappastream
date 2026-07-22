/*
 * Client-side reveal pagination for the Browse view.
 *
 * Anonymous Twitch GQL rejects `after` cursors ("IntegrityCheckFailed"), so
 * server-side pagination is unavailable. Instead each browse list over-fetches
 * up to its query's hard cap (30 for root streams, 100 for games / game
 * streams) in a single request, and "Load more" is a purely local reveal of
 * the already-fetched rows — it issues NO network request.
 *
 * The visible count is bounded by the fetched total so the Load more button
 * hides once everything fetched is shown. The component resets the count to
 * REVEAL_INITIAL on every refetch and whenever a different category is opened.
 *
 * Extracted as pure functions so the policy (initial size, step, clamp, gate)
 * is unit-testable without a component harness.
 */

export const REVEAL_INITIAL = 30
export const REVEAL_STEP = 30

/** Visible count a list starts at, and resets to on refetch / re-drill. */
export function initialVisible(): number {
  return REVEAL_INITIAL
}

/** Reveal the next step of rows, clamped to the total so it never overshoots. */
export function revealMore(visible: number, total: number): number {
  return Math.min(visible + REVEAL_STEP, total)
}

/** Whether the Load more button should show (more fetched rows are hidden). */
export function hasMoreToShow(visible: number, total: number): boolean {
  return visible < total
}
