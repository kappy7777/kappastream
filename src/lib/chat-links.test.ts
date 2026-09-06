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
      'see https://www.twitch.tv/chan9 and https://twitch.tv/videos/1 not javascript:alert(1) or data:text/html,x or https://bit.ly/x or http://twitch.tv/x',
    )
    const links = chunks.filter((c) => c.url)
    expect(links).toHaveLength(2)
    expect(links[0].url).toBe('https://www.twitch.tv/chan9')
    expect(links[1].url).toBe('https://twitch.tv/videos/1')
    // Every emitted URL parses as an https://(*.)twitch.tv link — a
    // whitelist, so no scheme or host denylist can miss a case.
    for (const link of links) {
      const u = new URL(link.url!)
      expect(u.protocol).toBe('https:')
      expect(u.hostname === 'twitch.tv' || u.hostname.endsWith('.twitch.tv')).toBe(true)
    }
    // The dangerous tokens survive as plain text, never as links.
    const plain = chunks.filter((c) => !c.url).map((c) => c.text).join(' ')
    expect(plain).toMatch(/javascript:alert\(1\)/)
    expect(plain).toMatch(/data:text\/html,x/)
    expect(plain).toMatch(/https:\/\/bit\.ly\/x/)
  })

  it('rejects twitch URLs with credentials, ports, or backslash tricks', () => {
    expect(splitTwitchLinks('https://user@twitch.tv/x').every((c) => c.url === null)).toBe(true)
    expect(splitTwitchLinks('https://twitch.tv:444/x').every((c) => c.url === null)).toBe(true)
    expect(splitTwitchLinks('https://evil.example\\twitch.tv/').every((c) => c.url === null)).toBe(true)
    expect(splitTwitchLinks('https://notwitch.tv/channel').every((c) => c.url === null)).toBe(true)
  })

  it('clip URLs (both shapes) are clickable twitch links', () => {
    expect(splitTwitchLinks('watch https://clips.twitch.tv/HappySunnyOtter-x1')[1].url).toBe(
      'https://clips.twitch.tv/HappySunnyOtter-x1',
    )
    expect(splitTwitchLinks('watch https://www.twitch.tv/chan9/clip/HappySunnyOtter-x1')[1].url).toBe(
      'https://www.twitch.tv/chan9/clip/HappySunnyOtter-x1',
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
    expect(parseTwitchClipUrl('https://clips.twitch.tv/HappySunnyOtterRabbitTacos-aB3xKQ9vZRtM5cWf')).toBe(
      'HappySunnyOtterRabbitTacos-aB3xKQ9vZRtM5cWf',
    )
  })

  it('recognizes twitch.tv/<channel>/clip/<slug> (incl. www/m subdomains)', () => {
    expect(parseTwitchClipUrl('https://www.twitch.tv/chan9/clip/MellowBraveWombats-qR7_NDU8WQkc3mLz')).toBe(
      'MellowBraveWombats-qR7_NDU8WQkc3mLz',
    )
    expect(parseTwitchClipUrl('https://m.twitch.tv/chan9/clip/CozyBrightLlamaTheMuffin')).toBe(
      'CozyBrightLlamaTheMuffin',
    )
  })

  it('non-clip twitch pages return null', () => {
    expect(parseTwitchClipUrl('https://www.twitch.tv/chan9')).toBeNull()
    expect(parseTwitchClipUrl('https://www.twitch.tv/videos/12345')).toBeNull()
    expect(parseTwitchClipUrl('https://clips.twitch.tv/')).toBeNull()
    // A bare "clip" path without a channel segment is not the canonical shape.
    expect(parseTwitchClipUrl('https://www.twitch.tv/clip/SomeSlug-1')).toBeNull()
  })

  it('rejects malformed slugs and non-twitch hosts', () => {
    expect(parseTwitchClipUrl('https://clips.twitch.tv/bad slug!')).toBeNull()
    expect(parseTwitchClipUrl('https://clips.twitch.tv/' + 'a'.repeat(101))).toBeNull()
    expect(parseTwitchClipUrl('https://evil.example/chan9/clip/SomeSlug-1')).toBeNull()
    expect(parseTwitchClipUrl('https://twitch.tv.example/chan/clip/SomeSlug-1')).toBeNull()
    expect(parseTwitchClipUrl('not a url')).toBeNull()
  })
})
