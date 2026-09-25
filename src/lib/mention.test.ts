import { describe, expect, it } from 'vitest'
import { escapeRegex, mentionMatcher } from './mention'

describe('mentionMatcher', () => {
  it('requires a word boundary before the @ and no word tail after', () => {
    const re = mentionMatcher('bob')!
    expect(re.test('hi @bob!')).toBe(true)
    expect(re.test('@bob hello')).toBe(true)
    expect(re.test('@bob')).toBe(true)
    // No boundary before the @ (mid-word).
    expect(re.test('x@bob hi')).toBe(false)
    expect(re.test('email@bob')).toBe(false)
    // Word tail after the name — a longer name, not a mention.
    expect(re.test('@bobby hi')).toBe(false)
    expect(re.test('@bob_')).toBe(false)
    expect(re.test('@bob123')).toBe(false)
  })

  it('matches case-insensitively', () => {
    const re = mentionMatcher('bob')!
    expect(re.test('hey @BOB!')).toBe(true)
    expect(re.test('HEY @Bob!')).toBe(true)
  })

  it('escapes regex metacharacters in the username', () => {
    expect(escapeRegex('a.b*c')).toBe('a\\.b\\*c')
    const re = mentionMatcher('a.b')!
    expect(re.test('hi @a.b!')).toBe(true)
    expect(re.test('hi @axb!')).toBe(false)
  })

  it('returns null for an empty username', () => {
    expect(mentionMatcher('')).toBeNull()
  })

  it('rebuilds when the username changes and caches while it does not', () => {
    const bob1 = mentionMatcher('bob')!
    expect(mentionMatcher('bob')).toBe(bob1)
    const alice = mentionMatcher('alice')!
    expect(alice).not.toBe(bob1)
    expect(alice.test('hi @alice!')).toBe(true)
    expect(alice.test('hi @bob!')).toBe(false)
    const bob2 = mentionMatcher('bob')!
    expect(bob2).not.toBe(bob1)
    expect(bob2.test('hi @bob!')).toBe(true)
  })
})

describe('mentionMatcher — non-word boundary before the @', () => {
  it('matches a mention wrapped in punctuation: "(@name", "[@name]"', () => {
    const re = mentionMatcher('bob')!
    expect(re.test('(@bob)')).toBe(true)
    expect(re.test('[@bob]')).toBe(true)
    expect(re.test('(@bob')).toBe(true)
  })

  it('still rejects a word character before the @', () => {
    const re = mentionMatcher('bob')!
    expect(re.test('email@bob')).toBe(false)
    expect(re.test('x@bob')).toBe(false)
  })
})
