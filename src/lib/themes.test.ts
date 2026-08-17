/// <reference types="node" />
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { THEMES } from './settings.svelte'
import { CUSTOM_THEME_PROPS } from './custom-themes.svelte'

/*
 * Built-in theme contract, cross-checked against the compile-time source of
 * truth (src/app.css): every theme block defines EXACTLY the 20 properties
 * (a missing one would inherit from whatever was set last — a broken theme),
 * the CSS blocks and the THEMES array list the same ids, and the five
 * saturated themes (v1.1: Riptide/Toxin/Redline/Hazard/Blacklight) keep
 * genuinely coloured backgrounds (real chroma, not near-neutral tints).
 */

const css = readFileSync('src/app.css', 'utf8')

function parseThemeBlocks(): Map<string, string[]> {
  const blocks = new Map<string, string[]>()
  const re = /:root\[data-theme='([\w-]+)'\]\s*\{([^}]*)\}/g
  for (const m of css.matchAll(re)) {
    const id = m[1]!
    const props = [...m[2]!.matchAll(/(--[\w-]+)\s*:/g)].map((p) => p[1]!)
    blocks.set(id, props)
  }
  return blocks
}

/** Channel spread (max-min of R/G/B, 0–255) — a rough chroma measure. */
function channelSpread(hex: string): number {
  const h = hex.replace('#', '')
  const channels = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16))
  return Math.max(...channels) - Math.min(...channels)
}

describe('built-in themes (app.css ↔ THEMES parity)', () => {
  const blocks = parseThemeBlocks()

  it('every theme block defines EXACTLY the 20 known properties', () => {
    expect(blocks.size).toBeGreaterThanOrEqual(34)
    for (const [id, props] of blocks) {
      expect(props.sort(), `theme ${id}`).toEqual([...CUSTOM_THEME_PROPS].sort())
    }
  })

  it('the CSS blocks and the THEMES array list exactly the same ids', () => {
    const cssIds = [...blocks.keys()].sort()
    const arrayIds = THEMES.map((t) => t.id as string).sort()
    expect(cssIds).toEqual(arrayIds)
  })

  it('every THEMES entry has a label and a hex swatch', () => {
    for (const t of THEMES) {
      expect(t.label.length).toBeGreaterThan(0)
      expect(t.swatch).toMatch(/^#[0-9a-fA-F]{6}$/)
    }
  })
})

describe('the five saturated themes (v1.1)', () => {
  const SATURATED = ['riptide', 'toxin', 'redline', 'hazard', 'blacklight'] as const

  it('all five are registered with distinct, non-colliding labels', () => {
    const labels = THEMES.map((t) => t.label)
    expect(new Set(labels).size).toBe(labels.length)
    for (const id of SATURATED) {
      expect(THEMES.some((t) => t.id === id)).toBe(true)
    }
  })

  it('backgrounds carry real chroma (not near-neutral tints)', () => {
    const blocks = parseThemeBlocks()
    for (const id of SATURATED) {
      const block = css.slice(css.indexOf(`[data-theme='${id}']`))
      const body = block.slice(0, block.indexOf('}'))
      for (const prop of ['--bg-app', '--bg-panel', '--bg-chat', '--bg-input', '--bg-hover', '--bg-deep'] as const) {
        const m = new RegExp(prop.replace(/-/g, '\\-') + String.raw`:\s*(#[0-9a-fA-F]{6})`).exec(body)
        expect(m, `${id} ${prop}`).not.toBeNull()
        // A channel spread >= 24/255 reads as clearly coloured at these depths;
        // the pre-existing dark themes sit far below this (near-neutral).
        expect(channelSpread(m![1]), `${id} ${prop} ${m![1]}`).toBeGreaterThanOrEqual(24)
      }
      expect(blocks.get(id)).toBeDefined()
    }
  })

  it('overlay colours are derived from the app background, not copied from another theme', () => {
    for (const id of SATURATED) {
      const block = css.slice(css.indexOf(`[data-theme='${id}']`))
      const body = block.slice(0, block.indexOf('}'))
      const app = /--bg-app:\s*(#[0-9a-fA-F]{6})/.exec(body)![1]!
      const overlay = /--bg-overlay:\s*rgba\((\d+),\s*(\d+),\s*(\d+),/.exec(body)!
      const overlayStrong = /--bg-overlay-strong:\s*rgba\((\d+),\s*(\d+),\s*(\d+),/.exec(body)!
      const a = app.replace('#', '')
      const rgb = [0, 2, 4].map((i) => parseInt(a.slice(i, i + 2), 16))
      for (const m of [overlay, overlayStrong]) {
        for (let i = 0; i < 3; i++) {
          expect(Math.abs(parseInt(m[i + 1]!, 10) - rgb[i]!), `${id} overlay channel ${i}`).toBeLessThanOrEqual(2)
        }
      }
    }
  })
})
