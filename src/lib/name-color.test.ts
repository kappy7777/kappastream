import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  TWITCH_DEFAULT_NAME_COLORS,
  defaultNameColor,
  readableNameColor,
  contrastRatio,
  NAME_COLOR_CONTRAST_TARGET,
} from './name-color'
import { parseColorToken } from './custom-themes.svelte'
import { normalizeColor } from './irc'
import { THEMES } from './settings.svelte'

/*
 * Username-colour readability. The two load-bearing behaviours:
 *  - an empty/invalid IRC color tag resolves to a DETERMINISTIC palette
 *    colour (never the old hard-coded #ffffff, which was ~1.1:1 on the light
 *    themes), and
 *  - every colour a user can actually end up with — the whole default
 *    palette plus the pathological bright picks — reaches WCAG AA contrast
 *    (4.5:1) against EVERY built-in theme's chat background, while a colour
 *    that already passes comes back unchanged.
 */

const css = readFileSync(join(process.cwd(), 'src', 'app.css'), 'utf8')
const themePanels: { theme: string; bg: string }[] = []
for (const m of css.matchAll(/:root\[data-theme='([a-z0-9-]+)'\]\s*\{([^}]*)\}/g)) {
  const prop = /--bg-panel:\s*([^;]+);/.exec(m[2]!)
  if (prop) themePanels.push({ theme: m[1]!, bg: prop[1]!.trim() })
}

describe('defaultNameColor', () => {
  it('is deterministic per login and always a palette colour', () => {
    for (const login of ['chan1', 'somechannel', 'streamer_x', 'a', 'zzz_9']) {
      const c = defaultNameColor(login)
      expect(TWITCH_DEFAULT_NAME_COLORS).toContain(c)
      expect(c).toBe(defaultNameColor(login))
      expect(c).not.toBe('#ffffff')
    }
  })

  it('covers more than one palette entry across logins', () => {
    const picks = new Set<string>()
    for (let i = 0; i < 200; i++) picks.add(defaultNameColor('user' + i))
    expect(picks.size).toBeGreaterThan(1)
  })
})

describe('normalizeColor', () => {
  it('returns a deterministic palette colour for an empty tag (never white)', () => {
    const c = normalizeColor(undefined, 'chan1')
    expect(TWITCH_DEFAULT_NAME_COLORS).toContain(c)
    expect(c).not.toBe('#ffffff')
    expect(normalizeColor('', 'chan1')).toBe(c)
    expect(normalizeColor('not-a-color', 'chan1')).toBe(c)
  })

  it('returns a valid tag verbatim', () => {
    expect(normalizeColor('#FF0000', 'chan1')).toBe('#FF0000')
  })
})

describe('readableNameColor', () => {
  const hostile = [...TWITCH_DEFAULT_NAME_COLORS, '#FFFF00', '#00FF7F', '#FFFFFF']

  it.each(themePanels)('every default + bright colour passes on theme $theme', ({ bg }) => {
    const bgc = parseColorToken(bg)
    expect(bgc).not.toBeNull()
    for (const fg of hostile) {
      const adjusted = readableNameColor(fg, bg)
      const adj = parseColorToken(adjusted)
      expect(adj, `${fg} on ${bg} adjusted to ${adjusted}`).not.toBeNull()
      const ratio = contrastRatio({ r: adj!.r, g: adj!.g, b: adj!.b }, { r: bgc!.r, g: bgc!.g, b: bgc!.b })
      expect(ratio, `${fg} on ${bg} -> ${adjusted} (${ratio.toFixed(2)}:1)`).toBeGreaterThanOrEqual(
        NAME_COLOR_CONTRAST_TARGET,
      )
    }
  })

  it('found the built-in theme panels in app.css', () => {
    // Sanity for the sweep above: EVERY theme in the registry must be
    // represented, including the light ones the fix is about.
    expect(themePanels.length).toBe(THEMES.length)
    for (const theme of THEMES) {
      expect(
        themePanels.some((t) => t.theme === theme.id),
        theme.id,
      ).toBe(true)
    }
  })

  it('reaches the target on mid-tone backgrounds by darkening', () => {
    // Luminance ~0.22 / ~0.28 — the custom-theme mid-tone range. Even pure
    // white is below 4.5:1 against these (the white/black contrast crossover
    // sits at a background luminance of ~0.179), so LIGHTENING — what the
    // old 0.5 pivot picked here — was a search that could never reach the
    // target. The direction must follow the crossover and darken.
    for (const bg of ['#808080', '#909090']) {
      const bgc = parseColorToken(bg)!
      for (const fg of hostile) {
        const adjusted = readableNameColor(fg, bg)
        const adj = parseColorToken(adjusted)
        expect(adj, `${fg} on ${bg} adjusted to ${adjusted}`).not.toBeNull()
        const ratio = contrastRatio({ r: adj!.r, g: adj!.g, b: adj!.b }, { r: bgc.r, g: bgc.g, b: bgc.b })
        expect(ratio, `${fg} on ${bg} -> ${adjusted} (${ratio.toFixed(2)}:1)`).toBeGreaterThanOrEqual(
          NAME_COLOR_CONTRAST_TARGET,
        )
      }
    }
  })

  it('leaves a colour that already passes unchanged', () => {
    // #00FF7F on the dark amethyst panel is ~13:1 already.
    expect(readableNameColor('#00FF7F', '#18181b')).toBe('#00FF7F')
    // Deep red on a light panel already passes too.
    expect(readableNameColor('#8B0000', '#fffdf1')).toBe('#8B0000')
  })

  it('keeps the hue family when adjusting (yellow on light goes darker-yellow, not blue)', () => {
    const adjusted = readableNameColor('#FFFF00', '#f7f2e5')
    const c = parseColorToken(adjusted)!
    // Yellow: the blue channel must stay the smallest of the three.
    expect(c.b).toBeLessThan(c.r)
    expect(c.b).toBeLessThan(c.g)
  })
})
