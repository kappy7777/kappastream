// Mention-highlight matching for the notification path. The regex is
// memoized against the configured username — it used to be rebuilt on
// every PRIVMSG, and an active chat delivers hundreds per minute.
export function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

let cachedFor = ''
let cachedRe: RegExp | null = null

/**
 * The mention matcher for a username: `(?:^|\W)@name(?![a-z0-9_])`, case
 * insensitive. The @ needs a NON-WORD character (or the string start) before
 * it — whitespace, but also "(@name" or "[@name]" — while `@name` glued to a
 * word ("email@name") still does not count; nor does a word-character tail
 * after the name. Returns null for an empty username; the RegExp is rebuilt
 * only when the username changes.
 */
export function mentionMatcher(username: string): RegExp | null {
  if (!username) return null
  if (!cachedRe || cachedFor !== username) {
    cachedFor = username
    cachedRe = new RegExp('(?:^|\\W)@' + escapeRegex(username) + '(?![a-z0-9_])', 'i')
  }
  return cachedRe
}
