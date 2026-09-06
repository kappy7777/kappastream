// Twitch-link handling shared by the chat renderer and the pinned-message
// banner. Remote text (chat messages, pinned messages) can contain arbitrary
// URLs; only twitch.tv URLs are ever made interactive — the existing
// open_url_robust Rust validator accepts exactly HTTPS twitch.tv (incl.
// subdomains like clips.twitch.tv) with no credentials/port, and no second
// opener may be added. This also makes javascript:/data: links impossible to
// produce: only an https URL on a twitch host ever linkifies. Everything else
// stays plain text.
//
// Clip links are special-cased: parseTwitchClipUrl recognizes the two Twitch
// clip URL shapes so a caller that can play clips in-app (the single-stream
// view) can hand the slug to its player instead of opening a browser.

import { isValidClipSlug } from './gql'

export interface TextLinkChunk {
  text: string
  /** Non-null only for https://(*.)twitch.tv URLs. */
  url: string | null
}

// Mirrors the Rust open_url_robust validator: HTTPS, twitch.tv or a
// *.twitch.tv subdomain, no credentials, no port, no backslash tricks.
function matchTwitchLink(token: string): string | null {
  if (!/^https:\/\/[^\s@]*twitch\.tv\//i.test(token)) return null
  if (/[@\\]/.test(token)) return null
  if (/^https:\/\/[a-z0-9.-]+:\d+/i.test(token)) return null
  try {
    const u = new URL(token)
    const host = u.hostname.toLowerCase()
    if (host !== 'twitch.tv' && !host.endsWith('.twitch.tv')) return null
    return u.href
  } catch {
    return null
  }
}

/** Split a text run into plain chunks and openable twitch.tv link chunks. */
export function splitTwitchLinks(text: string): TextLinkChunk[] {
  const out: TextLinkChunk[] = []
  let rest = text
  for (;;) {
    const m = /(https?:\/\/[^\s]+)/.exec(rest)
    if (!m || m.index === undefined) break
    if (m.index > 0) out.push({ text: rest.slice(0, m.index), url: null })
    // Sentence punctuation after a URL is not part of it — keep it out of the
    // href (and out of the link label).
    const raw = m[0]
    const trimmed = raw.replace(/[.,;:!?)\]'">]+$/, '')
    const url = trimmed ? matchTwitchLink(trimmed) : null
    if (trimmed) out.push({ text: trimmed, url })
    const trail = raw.slice(trimmed.length)
    if (trail) out.push({ text: trail, url: null })
    rest = rest.slice(m.index + raw.length)
  }
  if (rest.length > 0) out.push({ text: rest, url: null })
  return out
}

/**
 * The clip slug for a Twitch clip URL, or null for anything else. Both
 * canonical shapes are recognized:
 *   https://clips.twitch.tv/<slug>
 *   https://(www|m).twitch.tv/<channel>/clip/<slug>
 * The slug is validated (isValidClipSlug) so a malformed path can never reach
 * the player or the resolve_clip command.
 */
export function parseTwitchClipUrl(url: string): string | null {
  let u: URL
  try {
    u = new URL(url)
  } catch {
    return null
  }
  const host = u.hostname.toLowerCase()
  if (host !== 'twitch.tv' && !host.endsWith('.twitch.tv')) return null
  const segments = u.pathname.split('/').filter(Boolean)
  // clips.twitch.tv/<slug>
  if (host === 'clips.twitch.tv') {
    const slug = decodeURIComponent(segments[0] ?? '')
    return isValidClipSlug(slug) ? slug : null
  }
  // twitch.tv/<channel>/clip/<slug>
  if (
    segments.length === 3 &&
    segments[1] === 'clip' &&
    /^[a-zA-Z0-9_]{1,25}$/.test(decodeURIComponent(segments[0]))
  ) {
    const slug = decodeURIComponent(segments[2])
    return isValidClipSlug(slug) ? slug : null
  }
  return null
}
