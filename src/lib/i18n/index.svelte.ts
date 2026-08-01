// Hand-rolled i18n. No library: a typed `t()` over a per-locale catalogue.
//
// - `TKey` is derived from the English catalogue (locales/en.ts) and every
//   other locale is `Record<TKey, string>`, so a MISSING TRANSLATION IS A
//   COMPILE ERROR. This is the primary guarantee.
// - Runtime fallback to English for a key that resolves empty, then to the raw
//   key, is defence in depth behind the compile-time check — a raw key must
//   never reach the user.
// - Locale is reactive ($state). Switching language updates the UI live with no
//   restart or reconnect: `t()` reads `currentLocale`, so any call site in a
//   reactive context (template / $derived / $effect) re-runs on change.
// - Resolution order: explicit saved choice → detected system locale → English.
//
// Locale detection uses `navigator.language` (zero dependencies). In the Tauri
// webview this reflects the OS/UI locale in both engines in practice: WebKitGTK
// reads GLib's LANGUAGE/LC_*; WebView2 reads the Windows UI language. This could
// NOT be empirically verified in the headless build container — verification on
// an X11/Wayland (or Windows) box is still owed. An explicit English default is
// the ultimate fallback so a wrong auto-detection never renders keys.

import { en, type TKey } from './locales/en'
import { de } from './locales/de'
import { es } from './locales/es'
import { fr } from './locales/fr'
import { pt } from './locales/pt'

export type Locale = 'en' | 'de' | 'es' | 'fr' | 'pt'
export type { TKey } from './locales/en'

const SUPPORTED: readonly Locale[] = ['en', 'de', 'es', 'fr', 'pt']

const CATALOGUES: Record<Locale, Record<TKey, string>> = { en, de, es, fr, pt }

export interface LocaleMeta {
  id: Locale
  // Native name (convention: users find their language by its own name).
  label: string
}

export const LOCALES: ReadonlyArray<LocaleMeta> = [
  { id: 'en', label: 'English' },
  { id: 'de', label: 'Deutsch' },
  { id: 'es', label: 'Español' },
  { id: 'fr', label: 'Français' },
  { id: 'pt', label: 'Português' },
]

const LOCALE_KEY = 'app-locale-v1'

function safeReadLocale(): string | null {
  try {
    return localStorage.getItem(LOCALE_KEY)
  } catch {
    return null
  }
}

function safeWriteLocale(value: string): void {
  try {
    localStorage.setItem(LOCALE_KEY, value)
  } catch {
    /* ignore */
  }
}

function isSupported(value: string | null): value is Locale {
  return value !== null && (SUPPORTED as readonly string[]).includes(value)
}

/** Map a BCP-47 navigator tag to a supported locale, else English. */
export function detectSystemLocale(): Locale {
  if (typeof navigator === 'undefined') return 'en'
  const tags = [navigator.language, ...(navigator.languages ?? [])]
  for (const tag of tags) {
    if (!tag) continue
    const lower = tag.toLowerCase()
    if (lower.startsWith('de')) return 'de'
    if (lower.startsWith('es')) return 'es'
    if (lower.startsWith('fr')) return 'fr'
    if (lower.startsWith('pt')) return 'pt'
    if (lower.startsWith('en')) return 'en'
  }
  return 'en'
}

function resolveInitial(): Locale {
  const saved = safeReadLocale()
  if (isSupported(saved)) return saved
  return detectSystemLocale()
}

let currentLocale = $state<Locale>(resolveInitial())

/** The effective locale (never a sentinel). Read in templates for reactivity. */
export function getLocale(): Locale {
  return currentLocale
}

export function setLocale(locale: Locale): void {
  if (!isSupported(locale)) return
  currentLocale = locale
  safeWriteLocale(locale)
}

/**
 * Translate a key with optional `{name}` placeholder substitution. Reads the
 * reactive locale, so calling it inside a template / `$derived` / `$effect`
 * re-runs when the language changes. Falls back to English, then the raw key.
 */
export function t(key: TKey, params?: Record<string, string | number>): string {
  const localized = CATALOGUES[currentLocale]?.[key]
  let str = localized || en[key] || key
  if (params) {
    for (const name of Object.keys(params)) {
      str = str.replaceAll(`{${name}}`, String(params[name]))
    }
  }
  return str
}
