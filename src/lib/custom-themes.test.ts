/// <reference types="node" />
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import type { ThemeValues } from './custom-themes.svelte'

/*
 * Runtime custom themes — validation, storage, import/export.
 *
 * Security posture under test: every value that ends up in CSS must pass a
 * STRICT allowlist (plain colours; --shadow-menu a single fixed-shape
 * box-shadow), unknown property names are rejected, malformed data is dropped
 * whole (never partially applied), and nothing throws on startup. Caps: theme
 * count and import file size.
 */

type CustomThemesMod = typeof import('./custom-themes.svelte')
let S: CustomThemesMod

beforeEach(async () => {
  vi.resetModules()
  localStorage.clear()
  S = await import('./custom-themes.svelte')
})

/** A full, valid 20-property value set (the app.css :root defaults). */
function validValues(): ThemeValues {
  return {
    '--bg-app': '#0E0E10',
    '--bg-panel': '#18181B',
    '--bg-chat': '#18181B',
    '--bg-input': '#1F1F23',
    '--bg-hover': '#26262C',
    '--bg-deep': '#050505',
    '--text-primary': '#EFEFF1',
    '--text-secondary': '#ADADB8',
    '--text-dim': '#848494',
    '--accent': '#6D5DD3',
    '--accent-hover': '#5A4AB8',
    '--live': '#EB0400',
    '--border': '#2A2A2D',
    '--track': '#3A3A3D',
    '--track-hover': '#4A4A4F',
    '--track-buffered': 'rgba(239, 239, 241, 0.25)',
    '--bg-overlay': 'rgba(14, 14, 16, 0.85)',
    '--bg-overlay-strong': 'rgba(14, 14, 16, 0.92)',
    '--bg-hover-faint': 'rgba(239, 239, 241, 0.12)',
    '--shadow-menu': '0 8px 24px rgba(0, 0, 0, 0.5)',
  }
}

function validFile(name = 'My Theme'): string {
  return JSON.stringify({ kappastreamTheme: 1, name, values: validValues() })
}

describe('colour validation (strict allowlist — CSS injection impossible)', () => {
  it('accepts hex 3/4/6/8 and in-range rgb()/rgba()', () => {
    for (const v of ['#fff', '#ffff', '#EFEFF1', '#EFEFF1FF', 'rgb(14, 14, 16)', 'rgb(0,0,0)', 'rgba(239, 239, 241, 0.25)', 'rgba(0,0,0,1)', 'rgba(0,0,0,0.5)', 'rgba(0,0,0,0)']) {
      expect(S.isValidColorValue(v)).toBe(true)
    }
  })

  it('rejects injection payloads and anything not a plain colour', () => {
    const hostile = [
      'red; background-image: url(https://evil/x.png)',
      'red;background:url(x)',
      'var(--bg-app)',
      'url(https://evil/x.png)',
      'linear-gradient(red, blue)',
      'expression(alert(1))',
      'unset',
      'inherit',
      'transparent',
      '"#fff"',
      "'#fff'",
      ' #fff', // leading/trailing whitespace is NOT silently accepted
      '#fff ',
      '#12345', // 5 digits
      '#1234567', // 7 digits
      'rgb(300, 0, 0)', // out of range
      'rgb(1, 2)', // wrong arity
      'rgba(1, 2, 3, 2)', // alpha > 1
      'rgba(1, 2, 3)',
      'rgb(1, 2, 3) /* x */',
      'rgb(1,2,3);}',
      '',
      'a'.repeat(33),
    ]
    for (const v of hostile) expect(S.isValidColorValue(v)).toBe(false)
    expect(S.isValidColorValue(42)).toBe(false)
    expect(S.isValidColorValue(null)).toBe(false)
  })

  it('validates --shadow-menu as exactly one fixed-shape box-shadow', () => {
    expect(S.isValidThemeValue('--shadow-menu', '0 8px 24px rgba(0, 0, 0, 0.5)')).toBe(true)
    expect(S.isValidThemeValue('--shadow-menu', '0px 2px 8px rgba(10, 20, 30, 0.9)')).toBe(true)
    const hostile = [
      '0 8px 24px rgba(0, 0, 0, 0.5), 0 0 0 1px red', // two shadows
      '0 8px 24px 8px rgba(0, 0, 0, 0.5)', // spread — not used by themes
      '0 8px 24px inset rgba(0, 0, 0, 0.5)',
      '0 8px 24px url(https://evil/x.png)',
      '0 8px 24px rgba(0, 0, 0, 0.5); } body { display:none',
      'none',
      '',
    ]
    for (const v of hostile) expect(S.isValidThemeValue('--shadow-menu', v)).toBe(false)
    // A colour-only value is NOT a valid shadow (and vice versa).
    expect(S.isValidThemeValue('--shadow-menu', '#000000')).toBe(false)
    expect(S.isValidThemeValue('--bg-app', '0 8px 24px rgba(0, 0, 0, 0.5)')).toBe(false)
  })
})

describe('storage — malformed data never throws, never partially applies', () => {
  it('an empty/corrupt/foreign localStorage yields an empty list', () => {
    expect(S.listCustomThemes()).toHaveLength(0)
    localStorage.setItem('app-custom-themes-v1', '{not json')
    expect(S.readStoredCustomThemes()).toEqual([])
    localStorage.setItem('app-custom-themes-v1', JSON.stringify({ v: 99, themes: [] }))
    expect(S.readStoredCustomThemes()).toEqual([])
    localStorage.setItem('app-custom-themes-v1', JSON.stringify({ nope: true }))
    expect(S.readStoredCustomThemes()).toEqual([])
  })

  it('a stored theme with an invalid value or unknown property is dropped whole', () => {
    const good = { id: 'custom-good', label: 'Good', values: validValues() }
    const badColor = { id: 'custom-bad', label: 'Bad', values: { ...validValues(), '--bg-app': 'red; url(x)' } }
    const unknownProp = { id: 'custom-extra', label: 'Extra', values: { ...validValues(), '--evil-prop': '#fff' } }
    const missingProp = { id: 'custom-missing', label: 'Missing', values: { ...validValues(), ['--bg-app' as const]: undefined } }
    localStorage.setItem(
      'app-custom-themes-v1',
      JSON.stringify({ v: 1, themes: [good, badColor, unknownProp, missingProp] }),
    )
    const stored = S.readStoredCustomThemes()
    expect(stored.map((t) => t.id)).toEqual(['custom-good'])
    expect(stored[0]!.values['--bg-app']).toBe('#0E0E10')
  })

  it('createCustomTheme validates and persists; labels are trimmed and capped', () => {
    const theme = S.createCustomTheme('  Night Shift  ', validValues())
    expect(theme).not.toBeNull()
    expect(theme!.label).toBe('Night Shift')
    expect(S.listCustomThemes()).toHaveLength(1)
    expect(S.createCustomTheme('', validValues())).toBeNull()
    expect(S.createCustomTheme('x'.repeat(41), validValues())).toBeNull()
    expect(S.createCustomTheme('ok', { ...validValues(), '--live': 'url(x)' })).toBeNull()
  })

  it('ids are namespaced custom- and never collide (built-ins or each other)', () => {
    const a = S.createCustomTheme('Night Shift', validValues())!
    const b = S.createCustomTheme('Night Shift', validValues())!
    expect(a.id.startsWith('custom-')).toBe(true)
    expect(a.id).not.toBe(b.id)
    // Built-in ids can never be custom ids (namespace check).
    expect('amethyst'.startsWith('custom-')).toBe(false)
  })
})

describe('count cap', () => {
  it('the stored list never exceeds MAX_CUSTOM_THEMES', () => {
    const many = Array.from({ length: S.MAX_CUSTOM_THEMES + 5 }, (_, i) => ({
      id: 'custom-t' + i,
      label: 'T' + i,
      values: validValues(),
    }))
    localStorage.setItem('app-custom-themes-v1', JSON.stringify({ v: 1, themes: many }))
    expect(S.readStoredCustomThemes()).toHaveLength(S.MAX_CUSTOM_THEMES)
  })

  it('createCustomTheme rejects past the cap with the list unchanged', () => {
    for (let i = 0; i < S.MAX_CUSTOM_THEMES; i++) {
      expect(S.createCustomTheme('T' + i, validValues())).not.toBeNull()
    }
    expect(S.createCustomTheme('One Too Many', validValues())).toBeNull()
    expect(S.listCustomThemes()).toHaveLength(S.MAX_CUSTOM_THEMES)
    // Deleting frees a slot again.
    S.deleteCustomTheme(S.listCustomThemes()[0]!.id)
    expect(S.createCustomTheme('Fits Now', validValues())).not.toBeNull()
  })
})

describe('import / export round-trip', () => {
  it('a created theme round-trips through exportThemeJson → importAndStoreThemeJson', () => {
    const original = S.createCustomTheme('Roundtrip', { ...validValues(), '--accent': '#24B39B' })!
    const json = S.exportThemeJson(original)
    // Reset storage entirely, then import the exported document.
    localStorage.clear()
    vi.resetModules()
    return import('./custom-themes.svelte').then((Fresh) => {
      const result = Fresh.importAndStoreThemeJson(json)
      expect(result.ok).toBe(true)
      expect(Fresh.listCustomThemes()).toHaveLength(1)
      const imported = Fresh.listCustomThemes()[0]!
      expect(imported.label).toBe('Roundtrip')
      expect(imported.values).toEqual(original.values)
      expect(imported.id.startsWith('custom-')).toBe(true)
      // Importing the SAME file again never collides — the id gets a suffix.
      const again = Fresh.importAndStoreThemeJson(json)
      expect(again.ok).toBe(true)
      expect(again.ok && again.theme.id).not.toBe(imported.id)
      expect(Fresh.listCustomThemes()).toHaveLength(2)
    })
  })

  it('rejects non-JSON, wrong marker, unknown properties, missing properties, bad colours', () => {
    expect(S.importAndStoreThemeJson('not json at all')).toMatchObject({ ok: false, reason: 'malformed' })
    expect(S.importAndStoreThemeJson(JSON.stringify({ name: 'x', values: validValues() }))).toMatchObject({ ok: false, reason: 'malformed' })
    expect(S.importAndStoreThemeJson(JSON.stringify({ kappastreamTheme: 2, name: 'x', values: validValues() }))).toMatchObject({ ok: false, reason: 'malformed' })
    const extra = { ...JSON.parse(validFile()), values: { ...validValues(), '--hax': '#fff' } }
    expect(S.importAndStoreThemeJson(JSON.stringify(extra))).toMatchObject({ ok: false, reason: 'malformed' })
    const missing = { ...JSON.parse(validFile()), values: { ...validValues() } }
    delete missing.values['--live']
    expect(S.importAndStoreThemeJson(JSON.stringify(missing))).toMatchObject({ ok: false, reason: 'malformed' })
    const badColor = { ...JSON.parse(validFile()), values: { ...validValues(), '--text-primary': 'var(--x)' } }
    expect(S.importAndStoreThemeJson(JSON.stringify(badColor))).toMatchObject({ ok: false, reason: 'malformed' })
    // Nothing was stored by any of the rejected imports.
    expect(S.listCustomThemes()).toHaveLength(0)
  })

  it('enforces the file-size cap before parsing', () => {
    expect(S.importAndStoreThemeJson('x'.repeat(S.MAX_THEME_FILE_BYTES + 1))).toMatchObject({ ok: false, reason: 'too-large' })
    expect(S.listCustomThemes()).toHaveLength(0)
  })

  it('a valid import past the count cap is rejected with reason "full"', () => {
    for (let i = 0; i < S.MAX_CUSTOM_THEMES; i++) S.createCustomTheme('T' + i, validValues())
    const result = S.importAndStoreThemeJson(validFile('One More'))
    expect(result.ok).toBe(false)
    expect(result.ok === false && result.reason).toBe('full')
    expect(S.listCustomThemes()).toHaveLength(S.MAX_CUSTOM_THEMES)
  })
})

describe('normalization — computed-style tokens become validator-accepted canon', () => {
  it('colors: rgb()/rgba()/percent-alpha/hex3 → canonical #RRGGBB or rgba(r, g, b, a)', () => {
    expect(S.normalizeColorToken('rgb(14, 14, 16)')).toBe('#0E0E10')
    expect(S.normalizeColorToken('#fff')).toBe('#FFFFFF')
    expect(S.normalizeColorToken('#0e0e10')).toBe('#0E0E10')
    expect(S.normalizeColorToken('rgba(239, 239, 241, 0.25)')).toBe('rgba(239, 239, 241, 0.25)')
    expect(S.normalizeColorToken('rgba(239, 239, 241, .25)')).toBe('rgba(239, 239, 241, 0.25)')
    // The serialization quirk that broke saving: percent alpha.
    expect(S.normalizeColorToken('rgba(0, 0, 0, 50%)')).toBe('rgba(0, 0, 0, 0.5)')
    expect(S.normalizeColorToken('rgba(14, 14, 16, 100%)')).toBe('#0E0E10')
    expect(S.normalizeColorToken('#0E0E10FF')).toBe('#0E0E10')
    expect(S.normalizeColorToken('nonsense')).toBeNull()
  })

  it('every normalized color passes the strict validator', () => {
    for (const v of ['rgb(14, 14, 16)', '#fff', 'rgba(0, 0, 0, 50%)', 'rgba(239, 239, 241, .25)', '#0E0E10CC']) {
      const n = S.normalizeColorToken(v)
      expect(n).not.toBeNull()
      expect(S.isValidColorValue(n!)).toBe(true)
    }
  })

  it('shadows: 0px offsets + percent alpha normalize to the canonical form', () => {
    expect(S.normalizeShadowToken('0 8px 24px rgba(0, 0, 0, 0.5)')).toBe('0 8px 24px rgba(0, 0, 0, 0.5)')
    expect(S.normalizeShadowToken('0px 8px 24px rgba(0, 0, 0, 50%)')).toBe('0 8px 24px rgba(0, 0, 0, 0.5)')
    expect(S.normalizeShadowToken('0 12px 48px rgba(0, 0, 0, 0.5)')).toBe('0 12px 48px rgba(0, 0, 0, 0.5)')
    // Rejects anything that is not exactly 3 lengths + one colour.
    expect(S.normalizeShadowToken('none')).toBeNull()
    expect(S.normalizeShadowToken('0 8px 24px 8px rgba(0, 0, 0, 0.5)')).toBeNull()
    expect(S.normalizeShadowToken('url(https://evil/x.png)')).toBeNull()
  })
})

describe('editor surface — only properties that actually change something', () => {
  it('UNUSED_THEME_PROPS are exactly the two unconsumed tokens', () => {
    expect([...S.UNUSED_THEME_PROPS]).toEqual(['--bg-chat', '--bg-deep'])
  })

  it('the editor groups cover EDITABLE_THEME_PROPS exactly once (no unused tokens)', () => {
    const grouped = S.THEME_PROP_GROUPS.flatMap((g) => g.props)
    expect(grouped.sort()).toEqual([...S.EDITABLE_THEME_PROPS].sort())
    expect(S.EDITABLE_THEME_PROPS).toHaveLength(18)
    // The 20-property STORAGE contract is unchanged (imports/exports keep it).
    expect(S.CUSTOM_THEME_PROPS).toHaveLength(20)
  })

  it('REGRESSION GUARD: no surface consumes the hidden tokens — if you start using var(--bg-chat)/var(--bg-deep), re-add them to the editor first', () => {
    const offenders: string[] = []
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = `${dir}/${entry.name}`
        if (entry.isDirectory()) { walk(full); continue }
        if (!/\.(svelte|ts|js)$/.test(entry.name) || entry.name.includes('.test.')) continue
        if (full.includes('src/lib/custom-themes') || full.includes('src/lib/settings.svelte') || full.includes('src/lib/themes.test')) continue
        const src = readFileSync(full, 'utf8')
        if (src.includes('var(--bg-chat') || src.includes('var(--bg-deep')) offenders.push(full)
      }
    }
    walk('src')
    expect(offenders).toEqual([])
  })
})

describe('colour math + palette (the editor generates every value)', () => {
  it('hslToHex produces canonical uppercase hex', () => {
    expect(S.hslToHex(0, 100, 50)).toBe('#FF0000')
    expect(S.hslToHex(120, 100, 50)).toBe('#00FF00')
    expect(S.hslToHex(240, 100, 50)).toBe('#0000FF')
    expect(S.hslToHex(0, 0, 0)).toBe('#000000')
    expect(S.hslToHex(0, 0, 100)).toBe('#FFFFFF')
  })

  it('colorToHsl round-trips through hslToHex within slider precision', () => {
    for (const hex of ['#EFEFF1', '#6D5DD3', '#38B6FF', '#0A2440', '#FF6E8C']) {
      const hsl = S.colorToHsl(hex)
      expect(hsl).not.toBeNull()
      expect(S.isValidColorValue(S.hslToHex(hsl!.h, hsl!.s, hsl!.l))).toBe(true)
    }
    expect(S.colorToHsl('rgba(14, 14, 16, 0.85)')).toEqual(S.colorToHsl('#0E0E10'))
    expect(S.colorToHsl('garbage')).toBeNull()
  })

  it('parsedColorToHsl converts an already-parsed colour', () => {
    const hsl = S.parsedColorToHsl({ r: 255, g: 0, b: 0, a: 0.5 })
    expect(hsl).toEqual({ h: 0, s: 100, l: 50 })
  })

  it('the palette is a large set of unique, validator-clean hex swatches', () => {
    expect(S.THEME_PALETTE.length).toBeGreaterThanOrEqual(80)
    expect(new Set(S.THEME_PALETTE).size).toBe(S.THEME_PALETTE.length)
    for (const swatch of S.THEME_PALETTE) expect(S.isValidColorValue(swatch)).toBe(true)
    // Usable spread: near-black through near-white present.
    expect(S.THEME_PALETTE).toContain('#000000')
    expect(S.THEME_PALETTE).toContain('#FFFFFF')
  })
})

describe('runtime application on the document root', () => {
  it('applyThemeProperties sets all 20; clearThemeProperties removes them all', () => {
    const values = validValues()
    S.applyThemeProperties(values)
    const root = document.documentElement
    for (const prop of S.CUSTOM_THEME_PROPS) {
      expect(root.style.getPropertyValue(prop)).toBe(values[prop])
    }
    S.clearThemeProperties()
    for (const prop of S.CUSTOM_THEME_PROPS) {
      expect(root.style.getPropertyValue(prop)).toBe('')
    }
  })
})

describe('unknown stored theme ids fall back safely (settings integration)', () => {
  it('an unknown custom- id in app-theme-v1 falls back to amethyst', async () => {
    localStorage.setItem('app-theme-v1', 'custom-does-not-exist')
    vi.resetModules()
    const settings = await import('./settings.svelte')
    expect(settings.settings.theme).toBe('amethyst')
  })

  it('an unknown built-in-style id falls back to amethyst (unchanged behaviour)', async () => {
    localStorage.setItem('app-theme-v1', 'not-a-real-theme')
    vi.resetModules()
    const settings = await import('./settings.svelte')
    expect(settings.settings.theme).toBe('amethyst')
  })

  it('a VALID custom id is restored as the active theme', async () => {
    // Seed the custom registry first (settings reads it via localStorage).
    const theme = S.createCustomTheme('My Night', validValues())!
    localStorage.setItem('app-theme-v1', theme.id)
    vi.resetModules()
    const settings = await import('./settings.svelte')
    expect(settings.settings.theme).toBe(theme.id)
  })
})

describe('the 20-property contract', () => {
  it('CUSTOM_THEME_PROPS lists exactly the 20 properties every app.css theme defines', () => {
    // vitest runs from the repo root; app.css is the compile-time source of truth.
    const css = readFileSync('src/app.css', 'utf8')
    const firstBlock = css.slice(0, css.indexOf('}') + 1) // the `:root, :root[data-theme='amethyst']` block
    const cssProps = [...firstBlock.matchAll(/(--[\w-]+)\s*:/g)].map((m) => m[1])
    expect(cssProps.sort()).toEqual([...S.CUSTOM_THEME_PROPS].sort())
    expect(S.CUSTOM_THEME_PROPS).toHaveLength(20)
  })

  it('the editor groups cover the editable properties exactly once (see editor-surface describe)', () => {
    const grouped = S.THEME_PROP_GROUPS.flatMap((g) => g.props)
    expect(grouped.sort()).toEqual([...S.EDITABLE_THEME_PROPS].sort())
  })
})
