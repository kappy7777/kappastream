// Pins the Svelte behaviour MultiView's SvelteMap registries rely on: a
// plain `$state(new Map())` does NOT react to `.set()`/`.delete()` — only
// wholesale reassignment tracks — while SvelteMap mutations do trigger
// effects. If a future Svelte upgrade flips the plain-map result, this pin
// fails on purpose so the SvelteMap usage gets revisited consciously.
import { flushSync } from 'svelte'
import { SvelteMap } from 'svelte/reactivity'

/** Effect run count after one `.set()` on the given fresh map (1 = initial
 * run only, i.e. the mutation was NOT observed). */
export function runsAfterSet(makeMap: () => Map<string, number>): number {
  const map = makeMap()
  let runs = 0
  const cleanup = $effect.root(() => {
    $effect(() => {
      void map.get('k')
      void map.size
      runs++
    })
  })
  try {
    flushSync()
    flushSync(() => map.set('k', 1))
    flushSync()
    return runs
  } finally {
    cleanup()
  }
}

/** The plain `$state(new Map())` variant (reassignment-only reactivity). */
export function plainStateMap(): Map<string, number> {
  const m = $state(new Map<string, number>())
  return m
}

/** The `SvelteMap` variant (mutation-reactive). */
export function reactiveMap(): Map<string, number> {
  return new SvelteMap<string, number>()
}
