import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { UI_ZOOM_VAR, shouldCompensateViewportUnits, zoomDivisor } from './ui-zoom'

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
    // A regression here would re-introduce the band/overflow bug on the
    // engines that need the compensation.
    for (const s of [0.5, 0.75, 1, 1.25, 1.5, 2, 4]) {
      expect((1 / zoomDivisor(s)) * s).toBeCloseTo(1, 10)
    }
  })

  it('exposes the CSS custom-property name the stylesheets divide by', () => {
    expect(UI_ZOOM_VAR).toBe('--ui-zoom')
  })
})

describe('shouldCompensateViewportUnits', () => {
  it('a ratio of ~1 means the engine rescales viewport units: no compensation', () => {
    // Dividing there would shrink the UI to 1/zoom × the window.
    expect(shouldCompensateViewportUnits(1, 1.25)).toBe(false)
    expect(shouldCompensateViewportUnits(1, 0.75)).toBe(false)
    expect(shouldCompensateViewportUnits(0.996, 1.25)).toBe(false)
    expect(shouldCompensateViewportUnits(1.004, 2)).toBe(false)
  })

  it('a ratio of ~zoom means the engine does not rescale: compensate, for every supported scale', () => {
    for (const s of [0.5, 0.75, 1.25, 2, 4]) {
      expect(shouldCompensateViewportUnits(s, s), `scale ${s}`).toBe(true)
      // Small measurement noise around the zoom must not flip the verdict.
      expect(shouldCompensateViewportUnits(s * 0.99, s), `scale ${s}, -1%`).toBe(true)
      expect(shouldCompensateViewportUnits(s * 1.01, s), `scale ${s}, +1%`).toBe(true)
    }
  })

  it('a zoom of 1 never compensates (nothing to cancel)', () => {
    expect(shouldCompensateViewportUnits(1, 1)).toBe(false)
    expect(shouldCompensateViewportUnits(1.25, 1)).toBe(false)
  })

  it('junk or non-positive measurements never compensate', () => {
    expect(shouldCompensateViewportUnits(NaN, 1.25)).toBe(false)
    expect(shouldCompensateViewportUnits(0, 2)).toBe(false)
    expect(shouldCompensateViewportUnits(Infinity, 2)).toBe(false)
    expect(shouldCompensateViewportUnits(-1.25, 1.25)).toBe(false)
  })

  it('borderline ratios follow the closer-target rule', () => {
    // Midpoint between 1 and 1.25 is 1.125: below stays uncompensated,
    // above compensates — the decision can never half-flip.
    expect(shouldCompensateViewportUnits(1.1, 1.25)).toBe(false)
    expect(shouldCompensateViewportUnits(1.2, 1.25)).toBe(true)
  })
})

// Drift guards for the CSS side of the compensation. Two rules, both derived
// from how documentElement zoom behaves per engine (see ui-zoom.ts):
//
// 1. COVERAGE: every viewport-unit term (vh/vw/dvh/… — in every .svelte
//    under src/ except PipWindow.svelte, whose separate webview never applies
//    the UI-scale zoom) must be divided — a `/ var(--ui-zoom, …` divisor
//    either directly after the unit, or directly after the close of a
//    balanced group that contains it. An undivided term overflows the
//    viewport on an engine that does not rescale viewport units.
// 2. PX PURITY: the divisor may apply to VIEWPORT-UNIT TERMS ONLY — never to
//    a px term. A px length under documentElement zoom already paints at
//    `zoom ×` its css size on every engine, so dividing a px term (directly,
//    or via a whole `min(520px, calc(100vw - 32px))` group) makes the box
//    design-sized on compensating engines while the others render it
//    zoom-scaled — and its zoom-scaled content overflows the shrunken box.
//    A whole-group division IS legitimate when every arm is pure viewport
//    arithmetic (App.svelte's `min(70vh, calc(100vw * 9 / 16))`).
describe('ui-zoom CSS usage (viewport-unit terms only, all of them divided)', () => {
  const here = dirname(fileURLToPath(import.meta.url))
  const srcRoot = join(here, '..')

  function listSvelteFiles(dir: string): string[] {
    const out: string[] = []
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) out.push(...listSvelteFiles(full))
      else if (entry.name.endsWith('.svelte') && entry.name !== 'PipWindow.svelte') out.push(full)
    }
    return out
  }

  const files = listSvelteFiles(srcRoot).map((f) => relative(srcRoot, f))

  // Strip HTML/Svelte/CSS/TS comments so prose mentioning the calc form does
  // not count.
  function stripComments(raw: string): string {
    return raw
      .replace(/<!--[\s\S]*?-->/g, ' ')
      .replace(/\/\*[\s\S]*?\*\//g, ' ')
      .replace(/(^|[^:])\/\/[^\n]*/g, '$1')
  }

  // The .vh-probe rule itself must stay UNDIVIDED — its bare 100vh is the
  // measurement (a divided probe would read ratio 1 on every engine and the
  // compensation could never engage), so it is exempt like PipWindow:
  // instrumentation, not zoomed UI.
  function stripProbeRule(css: string): string {
    return css.replace(/\.vh-probe\s*\{[^}]*\}/g, ' ')
  }

  const DIVISOR = /\/\s*var\(--ui-zoom/

  function divisorAt(css: string, at: number): boolean {
    return DIVISOR.test(css.slice(at, at + 40))
  }

  function skipSpace(css: string, at: number): number {
    let i = at
    while (i < css.length && /\s/.test(css[i])) i++
    return i
  }

  function skipSpaceBack(css: string, at: number): number {
    let i = at
    while (i > 0 && /\s/.test(css[i - 1])) i--
    return i
  }

  // Fresh per call: a global regex carries lastIndex state between uses.
  const unitRe = () => /\d(?:dvh|dvw|lvh|lvw|svh|svw|vh|vw|vmin|vmax)\b/g

  /** Whether the viewport-unit term ending at `unitEnd` is divided — the
   *  divisor directly after the unit, or after the close of any balanced
   *  group that encloses it (walking to the end of the declaration). */
  function termIsDivided(css: string, unitEnd: number): boolean {
    let i = skipSpace(css, unitEnd)
    if (divisorAt(css, i)) return true
    let depth = 0
    for (; i < css.length; i++) {
      const c = css[i]
      if (c === '(') depth++
      else if (c === ')') {
        if (depth > 0) {
          depth--
          continue
        }
        // Closes a group containing the unit — the divisor may sit here.
        if (divisorAt(css, skipSpace(css, i + 1))) return true
      } else if (c === ';' || c === '{' || c === '}') {
        return false
      }
    }
    return false
  }

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

  it('the scan reaches a real corpus (files with viewport units exist)', () => {
    expect(files.length).toBeGreaterThan(15)
    const withUnits = files.filter((rel) => unitRe().test(stripComments(readFileSync(join(srcRoot, rel), 'utf8'))))
    expect(withUnits.length).toBeGreaterThanOrEqual(8)
  })

  it('every viewport-unit term is divided (directly or via its whole group)', () => {
    expect.hasAssertions()
    let unitCount = 0
    for (const rel of files) {
      const css = stripProbeRule(stripComments(readFileSync(join(srcRoot, rel), 'utf8')))
      for (const m of css.matchAll(unitRe())) {
        unitCount++
        expect(
          termIsDivided(css, (m.index ?? 0) + m[0].length),
          `${rel}: viewport-unit term '${m[0]}' is not divided (site: …${css.slice(Math.max(0, (m.index ?? 0) - 50), (m.index ?? 0) + 30).replace(/\n/g, ' ')}…)`,
        ).toBe(true)
      }
    }
    expect(unitCount).toBeGreaterThanOrEqual(20)
  })

  it('no division site divides a px term (directly or via a whole min())', () => {
    expect.hasAssertions()
    let siteCount = 0
    for (const rel of files) {
      const css = stripProbeRule(stripComments(readFileSync(join(srcRoot, rel), 'utf8')))
      for (const m of css.matchAll(/\/\s*var\(--ui-zoom/g)) {
        siteCount++
        const at = (m.index ?? 0) + m[0].length
        const unitBefore = skipSpaceBack(css, m.index ?? 0)
        const unitPreceded = /\d(?:dvh|dvw|lvh|lvw|svh|svw|vh|vw|vmin|vmax)$/.test(css.slice(0, unitBefore))
        const group = precedingGroup(css, m.index ?? 0)
        // No enclosing group means the divisor applies to whatever term sits
        // directly before it — so ONLY a viewport unit may sit there. A bare
        // px term with no group (calc(520px / var(--ui-zoom, 1))) is exactly
        // the regression this guard exists for.
        const ok = unitPreceded || (group !== null && !/\d\s*px\b/.test(group))
        expect(
          ok,
          `${rel}: division at offset ${at} divides a px term (site: …${css.slice(Math.max(0, (m.index ?? 0) - 60), at + 20).replace(/\n/g, ' ')}…)`,
        ).toBe(true)
      }
    }
    expect(siteCount).toBeGreaterThanOrEqual(20)
  })
})
