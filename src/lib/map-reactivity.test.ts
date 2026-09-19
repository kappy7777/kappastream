import { describe, expect, it } from 'vitest'
import { plainStateMap, reactiveMap, runsAfterSet } from './map-reactivity.svelte'

describe('Map reactivity pin (MultiView SvelteMap premise)', () => {
  it('a plain $state(new Map()) does not react to .set()', () => {
    // 1 = the effect's initial run only; the mutation went unobserved.
    expect(runsAfterSet(plainStateMap)).toBe(1)
  })

  it('a SvelteMap DOES react to .set()', () => {
    expect(runsAfterSet(reactiveMap)).toBeGreaterThan(1)
  })
})
