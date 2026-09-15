/// <reference types="node" />
import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { STORAGE_KEYS } from './storage-keys'

/*
 * Contract tests for the localStorage key registry.
 *
 *  - Uniqueness is the whole point: a duplicate value would mean two
 *    features silently overwriting each other's state.
 *  - The count is pinned to an explicit number so ADDING a key is a
 *    deliberate act (bump the number in the same change), never an
 *    accident that slips past review.
 *  - The three historical key names (pre-app-*-v1) are pinned at the
 *    value level: renaming any of them silently wipes that slice of
 *    state for every existing user. Normalizing them is a deliberate
 *    future migration, never a refactor.
 *  - The grep guard mirrors the source-reading approach of
 *    pinned-chat.test.ts / themes.test.ts: walk src/ from disk and
 *    assert no localStorage call bakes in a string literal — every key
 *    must come from this registry.
 */

const EXPECTED_KEY_COUNT = 35

describe('STORAGE_KEYS registry', () => {
  it('holds exactly the expected number of entries (bump deliberately)', () => {
    expect(Object.keys(STORAGE_KEYS).length).toBe(EXPECTED_KEY_COUNT)
  })

  it('every value is unique', () => {
    const values = Object.values(STORAGE_KEYS)
    expect(new Set(values).size).toBe(values.length)
  })

  it('every value is non-empty', () => {
    for (const [name, value] of Object.entries(STORAGE_KEYS)) {
      expect(value.length, name).toBeGreaterThan(0)
    }
  })

  it('the quality prefix is a namespace, ending in a colon', () => {
    expect(STORAGE_KEYS.qualityPrefix.endsWith(':')).toBe(true)
  })

  it('historical (pre-convention) key values are pinned — renaming wipes user state', () => {
    expect(STORAGE_KEYS.favorites).toBe('twitch-favorites-v1')
    expect(STORAGE_KEYS.sidebarVisible).toBe('twitch-sidebar-visible-v3')
    expect(STORAGE_KEYS.favNotifChannels).toBe('fav-notif-channels-v1')
  })

  it('legacy entries keep their historical values (migration sources)', () => {
    expect(STORAGE_KEYS.legacyChatSubnotices).toBe('app-chat-subnotices-v1')
    expect(STORAGE_KEYS.legacyTheater).toBe('app-theater-v1')
  })
})

describe('localStorage call sites go through the registry', () => {
  it('no getItem/setItem/removeItem under src/ takes a string literal', () => {
    // A literal first argument (quoted or template) bakes a key into the
    // call site, bypassing the registry. Dynamic keys must be built from
    // registry entries (concatenation/variables), which start with an
    // identifier and pass.
    const re = /localStorage\s*\.\s*(?:getItem|setItem|removeItem)\s*\(\s*['"`]/
    const offenders: string[] = []
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = `${dir}/${entry.name}`
        if (entry.isDirectory()) {
          // Stray vitest/vite caches under src/ are not source (same skip
          // as pinned-chat.test.ts's raw-HTML walk).
          if (entry.name === 'node_modules' || entry.name === '.vite') continue
          walk(full); continue
        }
        if (!/\.(svelte|ts|js)$/.test(entry.name) || entry.name.includes('.test.')) continue
        if (re.test(readFileSync(full, 'utf8'))) offenders.push(full)
      }
    }
    walk('src')
    expect(offenders).toEqual([])
  })
})
