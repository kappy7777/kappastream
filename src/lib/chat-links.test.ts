import { describe, it, expect } from 'vitest'

/*
 * Unit tests for the shared twitch-link handling (src/lib/chat-links.ts) used
 * by BOTH the chat renderer and the pinned-message banner.
 *
 * Core rules:
 *   - only https://(*.)twitch.tv URLs ever linkify (the exact set the
 *     open_url_robust Rust validator accepts — no second opener exists);
 *   - javascript:/data:/other hosts are impossible to produce as links;
 *   - credentials, ports and backslash tricks are rejected;
 *   - trailing sentence punctuation stays out of the link;
 *   - clip URLs (both Twitch shapes) resolve to a validated slug so the
 *     single-stream view can play them in-app.
 */

import { splitTwitchLinks, parseTwitchClipUrl } from './chat-links'

describe('chat links: allowlist', () => {
  it('linkifies only https twitch.tv URLs — javascript:/data:/other hosts stay text', () => {
    const chunks = splitTwitchLinks(
      'see https://www.twitch.tv/trymacs and https://twitch.tv/videos/1 not javascript:alert(1) or data:text/html,x or https://bit.ly/x or http://twitch.tv/x',
    )
    const links = chunks.filter((c) => c.url)
    expect(links).toHaveLength(2)
    expect(links[0].url).toBe('https://www.twitch.tv/trymacs')
    expect(links[1].url).toBe('https://twitch.tv/videos/1')
    // The dangerous tokens survive as plain text, never as links.
    expect(chunks.some((c) => c.url?.startsWith('javascript:'))).toBe(false)
    expect(chunks.some((c) => c.url?.startsWith('data:'))).toBe(false)
    expect(chunks.some((c) => !c.url && c.text.includes('javascript:alert(1)'))).toBe(true)
    expect(chunks.some((c) => !c.url && c.text.includes('https://bit.ly/x'))).toBe(true)
  })

  it('rejects twitch URLs with credentials, ports, or backslash tricks', () => {
    expect(splitTwitchLinks('https://user@twitch.tv/x').every((c) => c.url === null)).toBe(true)
    expect(splitTwitchLinks('https://twitch.tv:444/x').every((c) => c.url === null)).toBe(true)
    expect(splitTwitchLinks('https://evil.example\\twitch.tv/').every((c) => c.url === null)).toBe(true)
    expect(splitTwitchLinks('https://notwitch.tv/channel').every((c) => c.url === null)).toBe(true)
  })

  it('clip URLs (both shapes) are clickable twitch links', () => {
    expect(splitTwitchLinks('watch https://clips.twitch.tv/CrispyJollyGull-x1')[1].url).toBe(
      'https://clips.twitch.tv/CrispyJollyGull-x1',
    )
    expect(splitTwitchLinks('watch https://www.twitch.tv/trymacs/clip/CrispyJollyGull-x1')[1].url).toBe(
      'https://www.twitch.tv/trymacs/clip/CrispyJollyGull-x1',
    )
  })

  it('plain text without URLs passes through unchanged', () => {
    expect(splitTwitchLinks('no links here')).toEqual([{ text: 'no links here', url: null }])
    expect(splitTwitchLinks('')).toEqual([])
  })

  it('trailing sentence punctuation stays out of the link', () => {
    expect(splitTwitchLinks('go https://www.twitch.tv/x. now')).toEqual([
      { text: 'go ', url: null },
      { text: 'https://www.twitch.tv/x', url: 'https://www.twitch.tv/x' },
      { text: '.', url: null },
      { text: ' now', url: null },
    ])
  })
})

describe('chat links: clip URL parsing', () => {
  it('recognizes clips.twitch.tv/<slug>', () => {
    expect(parseTwitchClipUrl('https://clips.twitch.tv/CrispyJollyGullHassaanChop-nPlLKGxGRcBj37e4')).toBe(
      'CrispyJollyGullHassaanChop-nPlLKGxGRcBj37e4',
    )
  })

  it('recognizes twitch.tv/<channel>/clip/<slug> (incl. www/m subdomains)', () => {
    expect(parseTwitchClipUrl('https://www.twitch.tv/trymacs/clip/SwissManlyKangaroo-fCO_OHO9QUIuPGlg')).toBe(
      'SwissManlyKangaroo-fCO_OHO9QUIuPGlg',
    )
    expect(parseTwitchClipUrl('https://m.twitch.tv/trymacs/clip/GoodAlertBurritoTheTarFu')).toBe(
      'GoodAlertBurritoTheTarFu',
    )
  })

  it('non-clip twitch pages return null', () => {
    expect(parseTwitchClipUrl('https://www.twitch.tv/trymacs')).toBeNull()
    expect(parseTwitchClipUrl('https://www.twitch.tv/videos/12345')).toBeNull()
    expect(parseTwitchClipUrl('https://clips.twitch.tv/')).toBeNull()
    // A bare "clip" path without a channel segment is not the canonical shape.
    expect(parseTwitchClipUrl('https://www.twitch.tv/clip/SomeSlug-1')).toBeNull()
  })

  it('rejects malformed slugs and non-twitch hosts', () => {
    expect(parseTwitchClipUrl('https://clips.twitch.tv/bad slug!')).toBeNull()
    expect(parseTwitchClipUrl('https://clips.twitch.tv/' + 'a'.repeat(101))).toBeNull()
    expect(parseTwitchClipUrl('https://evil.example/trymacs/clip/SomeSlug-1')).toBeNull()
    expect(parseTwitchClipUrl('https://twitch.tv.example/chan/clip/SomeSlug-1')).toBeNull()
    expect(parseTwitchClipUrl('not a url')).toBeNull()
  })
})
