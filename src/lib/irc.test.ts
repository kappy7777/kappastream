import { describe, it, expect } from 'vitest'
import { parseIrcLine } from './irc'

/*
 * Tests for the IRCv3 tag-value escape decoder inside parseIrcLine
 * (src/lib/irc.ts decodeTagValue). The decoder is not exported directly, so
 * each escape is asserted through parseIrcLine on a realistic PRIVMSG whose
 * `display-name` tag carries the escape sequence under test. This is the same
 * path the live IRC socket feeds through, so it covers the parser + decoder
 * together.
 */

// Build a PRIVMSG line whose `display-name` tag carries the raw (already-
// escaped) value `raw`. The rest of the line is a minimal valid PRIVMSG.
function lineWithDisplayName(raw: string): string {
  return `@display-name=${raw};id=abc;tmi-sent-ts=0 :nick!nick@nick.tmi.twitch.tv PRIVMSG #channel :hello`
}

describe('decodeTagValue (via parseIrcLine display-name)', () => {
  it('decodes \\s to a space', () => {
    const msg = parseIrcLine(lineWithDisplayName('foo\\sbar'))
    expect(msg?.displayName).toBe('foo bar')
  })

  it('decodes \\n to a newline', () => {
    const msg = parseIrcLine(lineWithDisplayName('foo\\nbar'))
    expect(msg?.displayName).toBe('foo\nbar')
  })

  it('decodes \\r to a carriage return', () => {
    const msg = parseIrcLine(lineWithDisplayName('foo\\rbar'))
    expect(msg?.displayName).toBe('foo\rbar')
  })

  it('decodes \\: to a semicolon', () => {
    // `;` would otherwise split the tag, so this also confirms decode happens
    // before tag splitting would have a chance to mis-cut.
    const msg = parseIrcLine(lineWithDisplayName('foo\\:bar'))
    expect(msg?.displayName).toBe('foo;bar')
  })

  it('decodes \\\\ to a single backslash', () => {
    const msg = parseIrcLine(lineWithDisplayName('foo\\\\bar'))
    expect(msg?.displayName).toBe('foo\\bar')
  })

  it('drops the backslash for an unknown escape, keeping the char', () => {
    // \q is not a defined IRCv3 escape: the backslash is removed and 'q' is
    // kept as-is.
    const msg = parseIrcLine(lineWithDisplayName('foo\\qbar'))
    expect(msg?.displayName).toBe('fooqbar')
  })

  it('does not mis-decode \\\\ followed by s (a\\\\sb → a\\sb, not a\\ b)', () => {
    // Regression: the old sequential .replace() chain ran `\\` → `\` before
    // `\s` → ` `, turning `a\\sb` into `a\ b`. The single-pass decoder
    // consumes `\\` as one escape, leaving `sb` literal.
    const msg = parseIrcLine(lineWithDisplayName('a\\\\sb'))
    expect(msg?.displayName).toBe('a\\sb')
  })
})
