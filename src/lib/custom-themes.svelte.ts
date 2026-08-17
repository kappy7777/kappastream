// Runtime custom themes: user-authored colour themes stored in localStorage
// and applied by setting the 20 theme CSS custom properties on the document
// root at runtime. Built-in themes remain compile-time CSS (`app.css`); a
// custom theme writes `style="--bg-app: ...; ..."` on <html>, which overrides
// the `:root` defaults while it is active — and every property is removed
// again on switch-away so a built-in theme's output stays byte-identical.
//
// SECURITY — every value is a user-supplied string that ends up in CSS, so
// validation is a strict ALLOWLIST, never a blocklist:
//  - 19 of the 20 properties must be a plain colour: #RGB/#RGBA/#RRGGBB/
//    #RRGGBBAA or rgb()/rgba() with in-range numbers. No var(), url(),
//    gradients, quotes, semicolons or any other token can get through.
//  - --shadow-menu is a single box-shadow of the exact shape the built-in
//    themes use (three lengths + one rgba() colour); nothing else.
//  - Property NAMES are checked against the fixed 20-name list — unknown
//    properties are rejected on import, never stored.
//  - Stored/imported data is capped (theme count + file size) and any
//    malformed entry is DROPPED whole (never partially applied), and nothing
//    here may throw during startup (every read is try/catch-guarded).
//
// Import/export reuses the favorites backup pattern: one JSON document per
// theme, imported via the hidden <input type="file"> flow, exported via the
// rfd-based Rust save dialog (`save_theme_export`).

export const CUSTOM_THEME_PROPS = [
  '--bg-app',
  '--bg-panel',
  '--bg-chat',
  '--bg-input',
  '--bg-hover',
  '--bg-deep',
  '--text-primary',
  '--text-secondary',
  '--text-dim',
  '--accent',
  '--accent-hover',
  '--live',
  '--border',
  '--track',
  '--track-hover',
  '--track-buffered',
  '--bg-overlay',
  '--bg-overlay-strong',
  '--bg-hover-faint',
  '--shadow-menu',
] as const

export type ThemePropName = (typeof CUSTOM_THEME_PROPS)[number]

/**
 * Runtime custom-theme ids are namespaced `custom-…` so they can never
 * collide with a built-in id (settings.ThemeId unions this with the built-in
 * literal union).
 */
export type CustomThemeId = `custom-${string}`

/**
 * Properties that are defined by every theme but consumed by NO surface in
 * the current UI (verified by a source-scan test) — kept in the
 * storage/import/export contract (20 props) for compatibility with saved
 * themes and shared files, but HIDDEN from the editor: showing a control
 * that changes nothing is worse than omitting it.
 */
export const UNUSED_THEME_PROPS = ['--bg-chat', '--bg-deep'] as const satisfies ReadonlyArray<ThemePropName>

/** The properties the editor exposes (CUSTOM_THEME_PROPS minus the unused). */
export const EDITABLE_THEME_PROPS = CUSTOM_THEME_PROPS.filter(
  (p) => !(UNUSED_THEME_PROPS as readonly string[]).includes(p),
) as readonly ThemePropName[]

// ---- colour math + palette (the editor is sliders/swatches only — no typing) --
// HSL is the slider space: "make it darker/lighter" maps to one axis, which is
// what theme authoring needs. Every generated value is a canonical hex/rgba
// string, so editor-produced values are valid by construction.

export interface Hsl {
  /** 0–360 */
  h: number
  /** 0–100 */
  s: number
  /** 0–100 */
  l: number
}

function rgbToHsl(r: number, g: number, b: number): Hsl {
  const rr = r / 255, gg = g / 255, bb = b / 255
  const max = Math.max(rr, gg, bb), min = Math.min(rr, gg, bb)
  const l = (max + min) / 2
  let h = 0, s = 0
  if (max !== min) {
    const d = max - min
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min)
    if (max === rr) h = ((gg - bb) / d + (gg < bb ? 6 : 0)) * 60
    else if (max === gg) h = ((bb - rr) / d + 2) * 60
    else h = ((rr - gg) / d + 4) * 60
  }
  return { h: Math.round(h), s: Math.round(s * 100), l: Math.round(l * 100) }
}

function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  const ss = Math.min(100, Math.max(0, s)) / 100
  const ll = Math.min(100, Math.max(0, l)) / 100
  const c = (1 - Math.abs(2 * ll - 1)) * ss
  const hp = (((h % 360) + 360) % 360) / 60
  const x = c * (1 - Math.abs((hp % 2) - 1))
  let rgb: [number, number, number]
  if (hp < 1) rgb = [c, x, 0]
  else if (hp < 2) rgb = [x, c, 0]
  else if (hp < 3) rgb = [0, c, x]
  else if (hp < 4) rgb = [0, x, c]
  else if (hp < 5) rgb = [x, 0, c]
  else rgb = [c, 0, x]
  const m = ll - c / 2
  return [
    Math.round((rgb[0] + m) * 255),
    Math.round((rgb[1] + m) * 255),
    Math.round((rgb[2] + m) * 255),
  ]
}

/** Any parseable colour token → HSL (for seeding the sliders). */
export function colorToHsl(v: string): Hsl | null {
  const c = parseColorToken(v)
  if (!c) return null
  return rgbToHsl(c.r, c.g, c.b)
}

/** An already-parsed colour (e.g. the rgba inside --shadow-menu) → HSL. */
export function parsedColorToHsl(c: ParsedColor): Hsl {
  return rgbToHsl(c.r, c.g, c.b)
}

/** HSL → canonical #RRGGBB. */
export function hslToHex(h: number, s: number, l: number): string {
  const [r, g, b] = hslToRgb(h, s, l)
  const hx = (n: number) => Math.min(255, Math.max(0, n)).toString(16).padStart(2, '0').toUpperCase()
  return `#${hx(r)}${hx(g)}${hx(b)}`
}

/**
 * The swatch palette: a systematic HSL grid (12 hues × 6 tones, dark→light)
 * plus a neutral column — 90 swatches, all canonical hex by construction.
 */
export const THEME_PALETTE: readonly string[] = (() => {
  const out: string[] = ['#000000', '#1A1A1A', '#333333', '#555555', '#808080', '#B0B0B0', '#DCDCDC', '#FFFFFF']
  const tones: ReadonlyArray<[number, number]> = [[8, 35], [16, 50], [27, 60], [42, 80], [60, 90], [82, 55]]
  for (let hue = 0; hue < 360; hue += 30) {
    for (const [l, s] of tones) out.push(hslToHex(hue, s, l))
  }
  return out
})()

/** The one non-colour property: a single box-shadow (3 lengths + 1 colour). */
const SHADOW_PROP: ThemePropName = '--shadow-menu'

export type ThemeValues = Record<ThemePropName, string>

export interface CustomTheme {
  id: CustomThemeId
  label: string
  values: ThemeValues
}

/** Storage key follows the settings-store `app-*-v1` convention. */
const STORAGE_KEY = 'app-custom-themes-v1'
const STORAGE_VERSION = 1

export const MAX_CUSTOM_THEMES = 16
export const MAX_THEME_LABEL_LENGTH = 40
/** Import files are tiny by design; anything larger is hostile or corrupt. */
export const MAX_THEME_FILE_BYTES = 64 * 1024

// ---- validation (allowlist) -------------------------------------------------

const HEX_RE = /^#(?:[0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i
const RGB_RE = /^rgb\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*\)$/
const RGBA_RE = /^rgba\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(0|1|0?\.\d+|1\.0+)\s*\)$/

/** A plain colour: 3/4/6/8-digit hex, or rgb()/rgba() with in-range numbers. */
export function isValidColorValue(v: unknown): v is string {
  if (typeof v !== 'string') return false
  const s = v.trim()
  if (s.length === 0 || s.length > 32 || s !== v) return false
  if (HEX_RE.test(s)) return true
  const rgb = RGB_RE.exec(s) ?? RGBA_RE.exec(s)
  if (!rgb) return false
  for (const n of rgb.slice(1, 4)) {
    if (Number(n) > 255) return false
  }
  return true
}

const LENGTH = String.raw`(?:0(?:\.\d+)?|0px|\d{1,3}(?:\.\d+)?px)`
const SHADOW_RE = new RegExp(
  String.raw`^${LENGTH} ${LENGTH} ${LENGTH} rgba\(\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*(0|1|0?\.\d+|1\.0+)\s*\)$`,
)

/** --shadow-menu: exactly the box-shadow shape the built-in themes use. */
export function isValidShadowValue(v: unknown): v is string {
  if (typeof v !== 'string') return false
  const s = v.trim()
  if (s.length === 0 || s.length > 64 || s !== v) return false
  if (!SHADOW_RE.test(s)) return false
  return true
}

export function isValidThemeValue(prop: ThemePropName, v: unknown): v is string {
  return prop === SHADOW_PROP ? isValidShadowValue(v) : isValidColorValue(v)
}

// ---- normalization ----------------------------------------------------------
// Values read back from getComputedStyle() are NOT guaranteed to keep the
// authored form: engines may serialize alpha as a percentage (rgba(0,0,0,50%)),
// normalize `0` to `0px`, re-case hex, etc. — forms the strict validator above
// would reject, which surfaced as "cannot save, nothing highlighted" when a
// duplicate-from-built-in seeded such tokens. Everything entering the editor
// is therefore normalized to the canonical forms the validator accepts.

export interface ParsedColor {
  r: number
  g: number
  b: number
  /** 0–1 */
  a: number
}

const PCT_ALPHA_RE = /^rgba?\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3}(?:\.\d+)?)%\s*\)$/

/** Parse a color token (hex or rgb()/rgba(), incl. percent alpha). */
export function parseColorToken(v: string): ParsedColor | null {
  const s = v.trim()
  const hex = s.match(/^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i)
  if (hex) {
    let h = hex[1]!
    if (h.length === 3 || h.length === 4) h = [...h].map((c) => c + c).join('')
    return {
      r: parseInt(h.slice(0, 2), 16),
      g: parseInt(h.slice(2, 4), 16),
      b: parseInt(h.slice(4, 6), 16),
      a: h.length === 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1,
    }
  }
  const pct = PCT_ALPHA_RE.exec(s)
  if (pct) {
    return {
      r: Math.min(255, Number(pct[1])),
      g: Math.min(255, Number(pct[2])),
      b: Math.min(255, Number(pct[3])),
      a: Math.min(1, Number(pct[4]) / 100),
    }
  }
  const rgb = RGB_RE.exec(s) ?? RGBA_RE.exec(s)
  if (rgb) {
    const a = rgb[4] === undefined ? 1 : Math.min(1, Math.max(0, Number(rgb[4])))
    return { r: Number(rgb[1]), g: Number(rgb[2]), b: Number(rgb[3]), a }
  }
  return null
}

function fmtAlpha(a: number): string {
  const clamped = Math.min(1, Math.max(0, a))
  return String(Math.round(clamped * 100) / 100)
}

/** Canonical #RRGGBB (opaque) or rgba(r, g, b, a); null if unparsable. */
export function normalizeColorToken(v: string): string | null {
  const c = parseColorToken(v)
  if (!c) return null
  const hex = (n: number) => Math.round(n).toString(16).padStart(2, '0').toUpperCase()
  if (c.a >= 1) return `#${hex(c.r)}${hex(c.g)}${hex(c.b)}`
  return `rgba(${Math.round(c.r)}, ${Math.round(c.g)}, ${Math.round(c.b)}, ${fmtAlpha(c.a)})`
}

/**
 * Canonical `0 8px 24px rgba(r, g, b, a)` box-shadow; accepts `0`/`0px` for
 * the first length and percent alpha. Null if it is not exactly one
 * 3-length + rgba() shadow.
 */
export function normalizeShadowToken(v: string): string | null {
  const m = /^(\S+)\s+(\S+)\s+(\S+)\s+(rgba?\([^)]*\)|#[0-9a-fA-F]{3,8})$/.exec(v.trim())
  if (!m) return null
  const length = (t: string): string | null => {
    if (t === '0' || t === '0px') return '0'
    if (/^\d{1,3}(\.\d+)?px$/.test(t)) return t
    return null
  }
  const l1 = length(m[1]!)
  const l2 = length(m[2]!)
  const l3 = length(m[3]!)
  if (!l1 || !l2 || !l3) return null
  const c = parseColorToken(m[4]!)
  if (!c) return null
  return `${l1} ${l2} ${l3} rgba(${Math.round(c.r)}, ${Math.round(c.g)}, ${Math.round(c.b)}, ${fmtAlpha(c.a)})`
}

export function isThemePropName(v: unknown): v is ThemePropName {
  return typeof v === 'string' && (CUSTOM_THEME_PROPS as readonly string[]).includes(v)
}

export function isValidThemeLabel(v: unknown): v is string {
  if (typeof v !== 'string') return false
  const s = v.trim()
  return s.length >= 1 && s.length <= MAX_THEME_LABEL_LENGTH
}

function isValidValues(values: unknown): values is ThemeValues {
  if (typeof values !== 'object' || values === null) return false
  const record = values as Record<string, unknown>
  // Exactly the 20 known properties — no unknown names, none missing.
  for (const prop of CUSTOM_THEME_PROPS) {
    if (!(prop in record)) return false
    if (!isValidThemeValue(prop, record[prop])) return false
  }
  for (const key of Object.keys(record)) {
    if (!isThemePropName(key)) return false
  }
  return true
}

// ---- storage ----------------------------------------------------------------

function safeRead(): string | null {
  try {
    return localStorage.getItem(STORAGE_KEY)
  } catch {
    return null
  }
}

function safeWrite(value: string): void {
  try {
    localStorage.setItem(STORAGE_KEY, value)
  } catch {
    /* ignore */
  }
}

/** Fully validated, or null — a malformed theme is dropped whole. */
function parseTheme(entry: unknown): CustomTheme | null {
  if (typeof entry !== 'object' || entry === null) return null
  const e = entry as Record<string, unknown>
  if (typeof e.id !== 'string' || !e.id.startsWith('custom-') || e.id.length > 64) return null
  if (!isValidThemeLabel(e.label)) return null
  if (!isValidValues(e.values)) return null
  return { id: e.id as CustomThemeId, label: e.label.trim(), values: e.values }
}

/** Read + validate the stored list. NEVER throws; corrupt data → empty. */
export function readStoredCustomThemes(): CustomTheme[] {
  const raw = safeRead()
  if (!raw) return []
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return []
  }
  if (typeof parsed !== 'object' || parsed === null) return []
  const env = parsed as { v?: unknown; themes?: unknown }
  if (env.v !== STORAGE_VERSION || !Array.isArray(env.themes)) return []
  const out: CustomTheme[] = []
  const seen = new Set<string>()
  for (const entry of env.themes) {
    if (out.length >= MAX_CUSTOM_THEMES) break
    const theme = parseTheme(entry)
    if (!theme || seen.has(theme.id)) continue
    seen.add(theme.id)
    out.push(theme)
  }
  return out
}

function persist(themes: CustomTheme[]): void {
  safeWrite(JSON.stringify({ v: STORAGE_VERSION, themes }))
}

// ---- reactive registry ------------------------------------------------------

let customThemes = $state<CustomTheme[]>(readStoredCustomThemes())

function slugify(label: string): string {
  const slug = label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 24)
  return slug || 'theme'
}

function freshCustomId(label: string): CustomThemeId {
  const base = 'custom-' + slugify(label)
  let id = base
  let n = 2
  while (customThemes.some((t) => t.id === id)) id = `${base}-${n++}`
  return id as CustomThemeId
}

export function listCustomThemes(): readonly CustomTheme[] {
  return customThemes
}

export function getCustomTheme(id: string): CustomTheme | null {
  return customThemes.find((t) => t.id === id) ?? null
}

export function hasCustomTheme(id: string): boolean {
  return customThemes.some((t) => t.id === id)
}

/**
 * Add or update a custom theme. The theme must already be fully valid
 * (validate/normalize at the call site via normalizeCustomTheme). Returns the
 * stored theme, or null when the list is full (a new theme past the cap is
 * rejected with the list unchanged).
 */
export function upsertCustomTheme(theme: CustomTheme): CustomTheme | null {
  const existing = customThemes.findIndex((t) => t.id === theme.id)
  if (existing === -1 && customThemes.length >= MAX_CUSTOM_THEMES) return null
  if (existing === -1) customThemes = [...customThemes, theme]
  else customThemes = customThemes.map((t) => (t.id === theme.id ? theme : t))
  persist(customThemes)
  return theme
}

/** New validated theme with a fresh unique id (label-derived slug). */
export function createCustomTheme(label: string, values: ThemeValues): CustomTheme | null {
  if (!isValidThemeLabel(label) || !isValidValues(values)) return null
  if (customThemes.length >= MAX_CUSTOM_THEMES) return null
  const clean = { id: freshCustomId(label), label: label.trim(), values: { ...values } }
  return upsertCustomTheme(clean)
}

export function deleteCustomTheme(id: string): void {
  customThemes = customThemes.filter((t) => t.id !== id)
  persist(customThemes)
}

// ---- import / export --------------------------------------------------------

export const THEME_FILE_MARKER = 'kappastreamTheme'

export interface ThemeFilePayload {
  [THEME_FILE_MARKER]: number
  name: string
  values: ThemeValues
}

export function exportThemeJson(theme: CustomTheme): string {
  const payload: ThemeFilePayload = { [THEME_FILE_MARKER]: 1, name: theme.label, values: theme.values }
  return JSON.stringify(payload, null, 2)
}

export type ThemeImportParse =
  | { ok: true; name: string; values: ThemeValues }
  | { ok: false; reason: 'too-large' | 'malformed' }

/**
 * Parse + validate ONE theme from a JSON document (the export format above).
 * The whole file is validated before anything is applied: unknown properties,
 * missing properties, out-of-range colours, a wrong/absent marker, non-JSON or
 * an oversized document all reject cleanly with NOTHING stored.
 */
export function parseThemeJson(text: string): ThemeImportParse {
  if (typeof text !== 'string' || text.length > MAX_THEME_FILE_BYTES) return { ok: false, reason: 'too-large' }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return { ok: false, reason: 'malformed' }
  }
  if (typeof parsed !== 'object' || parsed === null) return { ok: false, reason: 'malformed' }
  const rec = parsed as Record<string, unknown>
  if (rec[THEME_FILE_MARKER] !== 1) return { ok: false, reason: 'malformed' }
  if (!isValidThemeLabel(rec.name)) return { ok: false, reason: 'malformed' }
  if (!isValidValues(rec.values)) return { ok: false, reason: 'malformed' }
  return { ok: true, name: (rec as { name: string }).name.trim(), values: rec.values as ThemeValues }
}

export type ThemeImportOutcome =
  | { ok: true; theme: CustomTheme }
  | { ok: false; reason: 'too-large' | 'malformed' | 'full' }

/** Import + store in one step (the UI's entry point). */
export function importAndStoreThemeJson(text: string): ThemeImportOutcome {
  const parsed = parseThemeJson(text)
  if (!parsed.ok) return parsed
  const theme = createCustomTheme(parsed.name, parsed.values)
  if (!theme) return { ok: false, reason: 'full' }
  return { ok: true, theme }
}

// ---- runtime application ----------------------------------------------------

/**
 * Set the 20 theme properties on the document root (inline style wins over
 * the app.css `:root` block). Callers must pass VALIDATED values — this
 * function is the trust boundary's other half and assumes validation upstream.
 */
export function applyThemeProperties(values: ThemeValues): void {
  if (typeof document === 'undefined') return
  const root = document.documentElement
  for (const prop of CUSTOM_THEME_PROPS) {
    const v = values[prop]
    if (typeof v === 'string') root.style.setProperty(prop, v)
  }
}

/** Remove every runtime theme property so a built-in theme is untouched. */
export function clearThemeProperties(): void {
  if (typeof document === 'undefined') return
  const root = document.documentElement
  for (const prop of CUSTOM_THEME_PROPS) {
    root.style.removeProperty(prop)
  }
}

// ---- editor helpers ---------------------------------------------------------

export interface ThemePropGroup {
  id: 'backgrounds' | 'text' | 'accent' | 'chrome'
  props: readonly ThemePropName[]
}

/**
 * Property groups for the editor UI (backgrounds / text / accent / chrome).
 * ONLY properties that actually change something in the app are listed — the
 * unused tokens (UNUSED_THEME_PROPS) are deliberately absent.
 */
export const THEME_PROP_GROUPS: readonly ThemePropGroup[] = [
  { id: 'backgrounds', props: ['--bg-app', '--bg-panel', '--bg-input', '--bg-hover', '--bg-overlay', '--bg-overlay-strong'] },
  { id: 'text', props: ['--text-primary', '--text-secondary', '--text-dim'] },
  { id: 'accent', props: ['--accent', '--accent-hover', '--live'] },
  { id: 'chrome', props: ['--border', '--track', '--track-hover', '--track-buffered', '--bg-hover-faint', '--shadow-menu'] },
]

/**
 * Read the 20 current values of a theme (built-in or custom) so the editor can
 * seed a duplicate. For built-ins this temporarily switches the document
 * root's data-theme attribute AND clears any runtime-applied custom-theme
 * inline properties (they would override the CSS block and silently seed the
 * ACTIVE custom theme's colours instead of the requested base), reads the
 * computed custom properties synchronously — no paint happens between set and
 * restore — then restores both. Computed values are NORMALIZED (engines may
 * serialize e.g. percent alpha or `0px`, which the strict validator rejects).
 */
export function readThemeValuesFor(id: string): ThemeValues | null {
  if (typeof document === 'undefined') return null
  if (id.startsWith('custom-')) {
    const theme = getCustomTheme(id)
    return theme ? { ...theme.values } : null
  }
  const root = document.documentElement
  const prev = root.dataset.theme
  const inlineSnapshot = new Map<string, string>()
  try {
    for (const prop of CUSTOM_THEME_PROPS) {
      const v = root.style.getPropertyValue(prop)
      if (v) {
        inlineSnapshot.set(prop, v)
        root.style.removeProperty(prop)
      }
    }
    root.dataset.theme = id
    const computed = getComputedStyle(root)
    const out: Partial<Record<ThemePropName, string>> = {}
    for (const prop of CUSTOM_THEME_PROPS) {
      const raw = computed.getPropertyValue(prop)
      if (typeof raw !== 'string' || raw.trim().length === 0) continue
      const normalized =
        prop === SHADOW_PROP
          ? normalizeShadowToken(raw)
          : normalizeColorToken(raw) ?? (isValidThemeValue(prop, raw.trim()) ? raw.trim() : null)
      if (normalized) out[prop] = normalized
    }
    if (Object.keys(out).length !== CUSTOM_THEME_PROPS.length) return null
    return out as ThemeValues
  } catch {
    return null
  } finally {
    if (prev === undefined) delete root.dataset.theme
    else root.dataset.theme = prev
    for (const [prop, v] of inlineSnapshot) root.style.setProperty(prop, v)
  }
}
