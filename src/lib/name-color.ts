/*
 * Chat username colours — the deterministic default and the readability
 * adjustment.
 *
 * Twitch sends an EMPTY color IRC tag for users who never picked a colour
 * (https://dev.twitch.tv/docs/chat/irc/ — "This tag may be empty if it is
 * never set"). Painting those names with a hard-coded near-white produced
 * ~1.1:1 contrast on the light themes, and genuinely bright picks (#FFFF00,
 * #00FF7F, #ADFF2F) were unreadable on several themes either way.
 *
 * Two layers:
 *  - defaultNameColor(login): a deterministic pick from Twitch's own
 *    15-colour chat palette, keyed by a hash of the login (the server-side
 *    assignment is state we cannot read anonymously; a stable hash is the
 *    closest anonymous equivalent — same user, same colour, every launch).
 *  - readableNameColor(fg, bg): keeps the hue and saturation of whatever the
 *    user DID pick and moves only the lightness until the WCAG contrast
 *    against the chat background reaches 4.5:1 (AA for normal text). A colour
 *    that already passes comes back unchanged. Memoized per (fg, bg) so a
 *    500-message render does not redo the search per name.
 */

import { parseColorToken, type ParsedColor } from './custom-themes.svelte'

/** Twitch's default chat colour palette, in the order twitch.tv lists them. */
export const TWITCH_DEFAULT_NAME_COLORS: readonly string[] = [
  '#FF0000',
  '#0000FF',
  '#008000',
  '#B22222',
  '#FF7F50',
  '#9ACD32',
  '#FF4500',
  '#2E8B57',
  '#DAA520',
  '#D2691E',
  '#5F9EA0',
  '#1E90FF',
  '#FF69B4',
  '#8A2BE2',
  '#00FF7F',
]

/** Deterministic palette pick for a login (never #ffffff, always a hex). */
export function defaultNameColor(login: string): string {
  let h = 0
  for (let i = 0; i < login.length; i++) h = ((h << 5) - h + login.charCodeAt(i)) | 0
  return TWITCH_DEFAULT_NAME_COLORS[Math.abs(h) % TWITCH_DEFAULT_NAME_COLORS.length]!
}

// ---- WCAG contrast (https://www.w3.org/TR/WCAG21/#dfn-contrast-ratio) ----

function srgbChannelToLinear(v: number): number {
  const c = v / 255
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4)
}

export function relativeLuminance(r: number, g: number, b: number): number {
  return 0.2126 * srgbChannelToLinear(r) + 0.7152 * srgbChannelToLinear(g) + 0.0722 * srgbChannelToLinear(b)
}

export function contrastRatio(a: { r: number; g: number; b: number }, b: { r: number; g: number; b: number }): number {
  const la = relativeLuminance(a.r, a.g, a.b)
  const lb = relativeLuminance(b.r, b.g, b.b)
  const hi = Math.max(la, lb)
  const lo = Math.min(la, lb)
  return (hi + 0.05) / (lo + 0.05)
}

/** Composite a (possibly translucent) foreground over an opaque background. */
export function compositeOver(fg: ParsedColor, bg: ParsedColor): { r: number; g: number; b: number } {
  const a = Math.min(1, Math.max(0, fg.a))
  return {
    r: fg.r * a + bg.r * (1 - a),
    g: fg.g * a + bg.g * (1 - a),
    b: fg.b * a + bg.b * (1 - a),
  }
}

// ---- hue/sat-preserving lightness adjustment ----

function rgbToHsl(c: { r: number; g: number; b: number }): { h: number; s: number; l: number } {
  const r = c.r / 255
  const g = c.g / 255
  const b = c.b / 255
  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  const l = (max + min) / 2
  if (max === min) return { h: 0, s: 0, l }
  const d = max - min
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min)
  let h: number
  if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) / 6
  else if (max === g) h = ((b - r) / d + 2) / 6
  else h = ((r - g) / d + 4) / 6
  return { h, s, l }
}

function hslToRgb(h: number, s: number, l: number): { r: number; g: number; b: number } {
  // Canonical HSL → RGB (the bounded hue2rgb form; t wraps into 0..1).
  const hue = (p: number, q: number, t: number): number => {
    let x = t
    if (x < 0) x += 1
    if (x > 1) x -= 1
    if (x < 1 / 6) return p + (q - p) * 6 * x
    if (x < 1 / 2) return q
    if (x < 2 / 3) return p + (q - p) * (2 / 3 - x) * 6
    return p
  }
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s
  const p = 2 * l - q
  return {
    r: Math.round(hue(p, q, h + 1 / 3) * 255),
    g: Math.round(hue(p, q, h) * 255),
    b: Math.round(hue(p, q, h - 1 / 3) * 255),
  }
}

export const NAME_COLOR_CONTRAST_TARGET = 4.5

const WHITE = { r: 255, g: 255, b: 255 }
const BLACK = { r: 0, g: 0, b: 0 }

// Steps from the current lightness toward the useful extreme. Going toward
// pure 0/1 would keep hue in name only (a black/white-ish result); 0.06/0.94
// retain a visible tint while passing 4.5:1 on every real chat background.
const L_DARK = 0.06
const L_BRIGHT = 0.94
const L_STEPS = 24

const memo = new Map<string, string>()
const MEMO_CAP = 1024

/**
 * A chat-username colour that meets the WCAG AA contrast target against
 * `bg` (an opaque background — composite translucent panels first with
 * compositeOver). Hue and saturation are preserved; only lightness moves.
 * Unparsable input is returned unchanged (the caller's fallback owns it).
 */
export function readableNameColor(fg: string, bg: string): string {
  const key = fg + '|' + bg
  const cached = memo.get(key)
  if (cached !== undefined) return cached
  const out = computeReadableNameColor(fg, bg)
  if (memo.size >= MEMO_CAP) memo.clear()
  memo.set(key, out)
  return out
}

/** One lightness walk toward `targetL`: first hit, else the best seen. */
function searchToward(
  hsl: { h: number; s: number; l: number },
  targetL: number,
  bg: { r: number; g: number; b: number },
): { hit: string | null; best: { hex: string; ratio: number } | null } {
  const step = (targetL - hsl.l) / L_STEPS
  let best: { hex: string; ratio: number } | null = null
  for (let i = 1; i <= L_STEPS; i++) {
    const rgb = hslToRgb(hsl.h, hsl.s, Math.min(1, Math.max(0, hsl.l + step * i)))
    const ratio = contrastRatio(rgb, bg)
    if (ratio >= NAME_COLOR_CONTRAST_TARGET) return { hit: rgbToHex(rgb), best }
    if (!best || ratio > best.ratio) best = { hex: rgbToHex(rgb), ratio }
  }
  return { hit: null, best }
}

function computeReadableNameColor(fg: string, bg: string): string {
  const fgC = parseColorToken(fg)
  const bgC = parseColorToken(bg)
  if (!fgC || !bgC) return fg
  const bgOpaque = { r: bgC.r, g: bgC.g, b: bgC.b }
  if (contrastRatio({ r: fgC.r, g: fgC.g, b: fgC.b }, bgOpaque) >= NAME_COLOR_CONTRAST_TARGET) return fg
  const hsl = rgbToHsl({ r: fgC.r, g: fgC.g, b: fgC.b })
  // Pick the direction by which EXTREME actually contrasts more with this
  // background: white and black cross over at a background luminance of
  // ~0.179, not 0.5. On a mid-tone background (luminance ~0.18-0.5, the
  // custom-theme range) even pure WHITE is below 4.5:1, so lightening there
  // — the old 0.5 pivot — was a search that could never reach the target
  // while darkening would.
  const towardBright = contrastRatio(WHITE, bgOpaque) >= contrastRatio(BLACK, bgOpaque)
  const primary = searchToward(hsl, towardBright ? L_BRIGHT : L_DARK, bgOpaque)
  if (primary.hit) return primary.hit
  // The preferred extreme fell short (e.g. a saturated hue whose luminance
  // at L_DARK/L_BRIGHT still misses): try the other one before giving up on
  // the tint-preserving range.
  const secondary = searchToward(hsl, towardBright ? L_DARK : L_BRIGHT, bgOpaque)
  if (secondary.hit) return secondary.hit
  // The bounded extremes keep a visible tint but can land just short on a
  // mid-tone background (a saturated green at L 0.06 misses 4.5:1 on
  // #808080 by 0.05). The true extremes — pure black or white, preferred
  // direction first — sacrifice the tint only in the case that would
  // otherwise be unreadable.
  for (const l of [towardBright ? 1 : 0, towardBright ? 0 : 1]) {
    const rgb = hslToRgb(hsl.h, hsl.s, l)
    if (contrastRatio(rgb, bgOpaque) >= NAME_COLOR_CONTRAST_TARGET) return rgbToHex(rgb)
  }
  // Neither direction nor extreme reaches the target: the better of the two
  // best-effort samples, never a guaranteed-miss direction alone.
  const fallback =
    primary.best && (!secondary.best || primary.best.ratio >= secondary.best.ratio)
      ? primary.best
      : (secondary.best ?? primary.best)
  return fallback ? fallback.hex : fg
}

function rgbToHex(c: { r: number; g: number; b: number }): string {
  const hex = (n: number) => Math.round(n).toString(16).padStart(2, '0')
  return `#${hex(c.r)}${hex(c.g)}${hex(c.b)}`
}
