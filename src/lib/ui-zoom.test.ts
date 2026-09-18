import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { UI_ZOOM_VAR, zoomDivisor } from './ui-zoom'

describe('zoomDivisor', () => {
  it('returns the scale for valid positive values', () => {
    expect(zoomDivisor(1)).toBe(1)
    expect(zoomDivisor(0.5)).toBe(0.5)
    expect(zoomDivisor(1.5)).toBe(1.5)
    expect(zoomDivisor(2)).toBe(2)
    expect(zoomDivisor(4)).toBe(4)
  })

  it('clamps invalid values to a no-op 1 (never divides by zero/negative/NaN)', () => {
    expect(zoomDivisor(0)).toBe(1)
    expect(zoomDivisor(-1)).toBe(1)
    expect(zoomDivisor(NaN)).toBe(1)
    expect(zoomDivisor(Infinity)).toBe(1)
  })

  it('cancels the zoom: (1 / divisor) * scale === 1 for every supported scale', () => {
    // The compensation contract: a viewport length L divided by the divisor,
    // then painted at `scale ×`, must net the true viewport. i.e. for scale s,
    // (L / zoomDivisor(s)) * s === L  ==>
    // (1 / zoomDivisor(s)) * s === 1.
    // A regression here would re-introduce the macOS band/overflow bug.
    for (const s of [0.5, 0.75, 1, 1.25, 1.5, 2, 4]) {
      expect((1 / zoomDivisor(s)) * s).toBeCloseTo(1, 10)
    }
  })

  it('exposes the CSS custom-property name the stylesheets divide by', () => {
    expect(UI_ZOOM_VAR).toBe('--ui-zoom')
  })
})

// Drift guard for the CSS side of the compensation (2026-09-18, the
// "Settings renders much smaller on macOS" bug): the divisor may apply to
// VIEWPORT-UNIT TERMS ONLY — never to a px term. A px length under
// documentElement zoom already paints at zoom × its css size on every
// engine, so dividing a whole `min(520px, calc(100vw - 32px))` (or any px
// term) makes the box design-sized on macOS while Windows/Linux render it
// zoom-scaled — the panel then renders smaller on macOS than on
// Windows/Linux AND its zoom-scaled content overflows the shrunken box.
// A whole-min() division IS legitimate when every arm is pure viewport
// arithmetic (App.svelte's `min(70vh, calc(100vw * 9 / 16))`), so the
// check is: at each `/ var(--ui-zoom` site, either the divisor directly
// follows a viewport unit, or the balanced group it closes contains NO px
// token.
describe('ui-zoom CSS usage (viewport-unit terms only)', () => {
  const here = dirname(fileURLToPath(import.meta.url))
  const files = [
    '../App.svelte',
    './Settings.svelte',
    './SearchBox.svelte',
    './NotifyMenu.svelte',
    './BrowseView.svelte',
  ]

  // The text of the outermost balanced `(...)` group ending exactly at
  // `end`, or null when the divisor does not close a group.
  function precedingGroup(css: string, end: number): string | null {
    let depth = 0
    for (let i = end - 1; i >= 0; i--) {
      const c = css[i]
      if (c === ')') depth++
      else if (c === '(') {
        if (depth === 0) return null
        depth--
        if (depth === 0) return css.slice(i + 1, end)
      }
    }
    return null
  }

  it('no division site divides a px term (directly or via a whole min())', () => {
    for (const rel of files) {
      const raw = readFileSync(join(here, rel), 'utf8')
      // Scan CSS/TS code only — prose comments mention the calc form too.
      const css = raw.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1')
      const marker = '/ var(--ui-zoom'
      let total = 0
      let at = css.indexOf(marker)
      while (at !== -1) {
        total++
        const unitPreceded = /\d(?:vh|vw|dvh|svh|lvh|vmin|vmax) $/.test(css.slice(0, at))
        const group = precedingGroup(css, at)
        const groupClean = group === null || !/\d\s*px\b/.test(group)
        expect(
          unitPreceded || groupClean,
          `${rel}: division at offset ${at} divides a px term (site: …${css.slice(Math.max(0, at - 60), at + 20)}…)`,
        ).toBe(true)
        at = css.indexOf(marker, at + marker.length)
      }
      expect(total, `${rel}: expected at least one ui-zoom division`).toBeGreaterThan(0)
    }
  })
})
