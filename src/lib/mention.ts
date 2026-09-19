// Mention-highlight matching for the notification path. The regex is
// memoized against the configured username — it used to be rebuilt on
// every PRIVMSG, and an active chat delivers hundreds per minute.
export function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

let cachedFor = ''
let cachedRe: RegExp | null = null

/**
 * The mention matcher for a username: `(?:^|\s)@name(?![a-z0-9_])`, case
 * insensitive. `@name` mid-word or followed by a word character does not
 * count as a mention. Returns null for an empty username; the RegExp is
 * rebuilt only when the username changes.
 */
export function mentionMatcher(username: string): RegExp | null {
  if (!username) return null
  if (!cachedRe || cachedFor !== username) {
    cachedFor = username
    cachedRe = new RegExp('(?:^|\\s)@' + escapeRegex(username) + '(?![a-z0-9_])', 'i')
  }
  return cachedRe
}
