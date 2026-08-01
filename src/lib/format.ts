// Locale-aware formatting helpers. Each reads the reactive i18n locale, so a
// call inside a template / `$derived` / `$effect` re-renders on language change.
//
// NUMBER FORMATTING (formatCompact): a HYBRID of the existing terse algorithm
// (which decides K/M and trimming) with `Intl.NumberFormat` for the numeric
// portion. This keeps English byte-identical to the previous hand-rolled output
// (e.g. "1.2K", "12.3K", "150K", "1.5M") while localising the decimal separator
// for other languages (German "1,2K", French "1,2K"). Pure `Intl` compact
// notation was rejected: its English output drifts from today's for some values
// (breaking byte-identity) and its German output drops the suffix for small
// thousands ("1200"), which is inconsistent.
//
// TIME / RELATIVE: chat timestamps use Intl.DateTimeFormat (24h, byte-identical
// for English: "14:05"). Relative times ("5m ago") stay terse and translate
// their unit words via `t()` (Intl.RelativeTimeFormat changes English wording,
// which would break byte-identity). Clock durations (H:MM:SS) are not
// locale-sensitive and are left untouched in their components.

import { getLocale, t, type Locale, type TKey } from './i18n/index.svelte'

// Cache one formatter per locale — Intl construction is not free and these run
// on every render of a viewer-count / timestamp.
const compactFmt = new Map<Locale, Intl.NumberFormat>()
const chatTimeFmt = new Map<Locale, Intl.DateTimeFormat>()

function compactFormatter(locale: Locale): Intl.NumberFormat {
  let f = compactFmt.get(locale)
  if (!f) {
    f = new Intl.NumberFormat(locale, { maximumFractionDigits: 1 })
    compactFmt.set(locale, f)
  }
  return f
}

function chatTimeFormatter(locale: Locale): Intl.DateTimeFormat {
  let f = chatTimeFmt.get(locale)
  if (!f) {
    // hour12:false keeps the 24h clock the app has always used (English stays
    // "14:05"); locale only affects the (absent here) AM/PM and separators.
    f = new Intl.DateTimeFormat(locale, {
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    })
    chatTimeFmt.set(locale, f)
  }
  return f
}

/** Compact viewer/count formatting: "1.2K", "12.3K", "150K", "1.5M". */
export function formatCompact(n: number): string {
  const nf = compactFormatter(getLocale())
  if (n < 1000) return nf.format(n)
  if (n < 1_000_000) {
    const k = n / 1000
    return (k < 100 ? nf.format(k) : nf.format(Math.round(k))) + 'K'
  }
  return nf.format(n / 1_000_000) + 'M'
}

/** Chat timestamp "HH:MM" (24h). */
export function formatChatTime(ts: number): string {
  return chatTimeFormatter(getLocale()).format(new Date(ts))
}

/** Sidebar tooltip / stale-fetch age: "just now", "5m ago", "3h ago", "2d ago". */
export function timeAgo(ts: number | null): string {
  if (ts === null) return ''
  const diff = Date.now() - ts
  if (diff < 0) return ''
  if (diff < 60_000) return t('relTime_justNow')
  if (diff < 3_600_000) return t('relTime_minutesAgo', { n: Math.floor(diff / 60_000) })
  if (diff < 86_400_000) return t('relTime_hoursAgo', { n: Math.floor(diff / 3_600_000) })
  return t('relTime_daysAgo', { n: Math.floor(diff / 86_400_000) })
}

/** Channel-content card age: minutes/hours/days/months/years ago. */
export function formatAge(iso: string): string {
  if (!iso) return ''
  const then = Date.parse(iso)
  if (!Number.isFinite(then)) return ''
  const diff = Date.now() - then
  const hr = 3_600_000
  const day = 86_400_000
  if (diff < hr) return t('relTime_minutesAgo', { n: Math.max(1, Math.floor(diff / 60_000)) })
  if (diff < day) return t('relTime_hoursAgo', { n: Math.floor(diff / hr) })
  if (diff < 30 * day) return t('relTime_daysAgo', { n: Math.floor(diff / day) })
  const mo = Math.floor(diff / (30 * day))
  if (mo < 12) return t('relTime_monthsAgo' as TKey, { n: mo })
  return t('relTime_yearsAgo' as TKey, { n: Math.floor(mo / 12) })
}

/**
 * Notification list relative time: "now", "5m", "3h", "2d", else a locale date.
 * The >7d fallback uses Intl.DateTimeFormat in the app locale (previously the
 * webview-default locale via toLocaleDateString).
 */
export function relTimeShort(ts: number): string {
  const diff = Date.now() - ts
  const sec = Math.floor(diff / 1000)
  if (sec < 45) return t('relTime_now')
  const min = Math.floor(sec / 60)
  if (min < 60) return t('relTime_m', { n: min })
  const hr = Math.floor(min / 60)
  if (hr < 24) return t('relTime_h', { n: hr })
  const day = Math.floor(hr / 24)
  if (day < 7) return t('relTime_d', { n: day })
  return new Intl.DateTimeFormat(getLocale()).format(new Date(ts))
}
