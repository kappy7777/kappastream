// Canonical Twitch channel-name validation. A tiny pure module (no store, no
// localStorage) so pure-logic modules like merged-chat.ts can validate
// user-typed channel names without importing the favorites store.

export const CHANNEL_NAME_RE = /^[a-z0-9_]{1,25}$/

export function normalizeChannelName(raw: string): string {
  return raw.trim().replace(/^#/, '').toLowerCase()
}

export function isValidChannelName(name: string): boolean {
  return CHANNEL_NAME_RE.test(name)
}
