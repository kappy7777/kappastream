import { describe, it, expect } from 'vitest'
import { RELEASE_NOTES, releaseNotesFor } from './release-notes'

/*
 * Owner conventions for the what's-new highlights (see the Release-notes rule
 * in AGENTS.md): entries mirror the CHANGELOG's Added / Changed / Fixed
 * sections, and every bullet starts with a fitting emoji. These tests pin the
 * conventions so a future entry can't silently drop them.
 */

const SECTION_KEYS = ['added', 'changed', 'fixed'] as const

// Matches the first code point of any emoji (pictographic, incl. ones that
// need VS16 for colour presentation, e.g. 🎚️ / 🖱️ / 🏷️).
const EMOJI_LEAD = /^\p{Extended_Pictographic}/u

describe('release-notes — sectioned, emoji-led highlights (owner conventions)', () => {
  const versions = Object.keys(RELEASE_NOTES)

  it('has curated entries to check', () => {
    expect(versions.length).toBeGreaterThan(0)
  })

  it('every entry uses only the Added/Changed/Fixed sections, each non-empty', () => {
    for (const [version, notes] of Object.entries(RELEASE_NOTES)) {
      const present = SECTION_KEYS.filter((k) => notes[k] !== undefined)
      expect(present.length, `${version}: at least one section`).toBeGreaterThan(0)
      for (const key of present) {
        expect(notes[key]!.length, `${version}.${key}: no empty lists`).toBeGreaterThan(0)
      }
      const unknown = Object.keys(notes).filter((k) => !SECTION_KEYS.includes(k as (typeof SECTION_KEYS)[number]))
      expect(unknown, `${version}: unknown sections`).toEqual([])
    }
  })

  it('every bullet in every section starts with an emoji', () => {
    for (const [version, notes] of Object.entries(RELEASE_NOTES)) {
      for (const key of SECTION_KEYS) {
        for (const bullet of notes[key] ?? []) {
          expect(bullet, `${version}.${key}: "${bullet.slice(0, 30)}…" needs a leading emoji`).toMatch(EMOJI_LEAD)
        }
      }
    }
  })

  it('an unknown version falls back to empty sections (generic line in the UI)', () => {
    expect(releaseNotesFor('0.0.1-not-a-version')).toEqual({})
  })
})
