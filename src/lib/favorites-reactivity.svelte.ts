// Runes test helper: counts how often an effect reading `read()` re-runs
// around one application of `mutate()`. 1 = the initial run only (the
// mutation was NOT observed by readers); > 1 = reactive. Used by
// favorites.test.ts to pin that FavoritesStore.has()/hasNotifEnabled() are
// tracked ($state.raw entries + SvelteSet) — the old plain fields made every
// $derived/$effect reading them stale until a manual version-counter bump.
import { flushSync } from 'svelte'

export function runsAroundMutation(read: () => unknown, mutate: () => void): number {
  let runs = 0
  const cleanup = $effect.root(() => {
    $effect(() => {
      void read()
      runs++
    })
  })
  try {
    flushSync()
    flushSync(mutate)
    flushSync()
    return runs
  } finally {
    cleanup()
  }
}
