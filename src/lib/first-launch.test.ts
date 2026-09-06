import { describe, it, expect, beforeEach } from 'vitest'
import {
  classifyLaunch,
  readLastSeenVersion,
  writeLastSeenVersion,
  streamlinkProbeFromResult,
} from './first-launch.svelte'

/*
 * First-launch detection. The store singleton reads localStorage + __APP_VERSION__
 * at import; the LOGIC under test is exercised through the pure `classifyLaunch`
 * decision function and the `read/writeLastSeenVersion` helpers, so each row of
 * the classifyLaunch decision table + the write-on-dismissal contract is covered
 * without module-reset gymnastics.
 *
 * Current build version for these tests is whatever __APP_VERSION__ resolves to
 * (the Vite define = package.json version). The decision function takes the
 * current version as an explicit arg, so the tests are independent of it.
 */

const CURRENT = '0.3.1'

describe('classifyLaunch — decision table', () => {
  it('no stored version → FIRST INSTALL → welcome', () => {
    expect(classifyLaunch(CURRENT, null)).toBe('welcome')
  })

  it('stored < current → UPDATED → whats-new', () => {
    expect(classifyLaunch('0.3.1', '0.3.0')).toBe('whats-new')
    expect(classifyLaunch('0.3.1', '0.2.9')).toBe('whats-new')
    // numeric, not lexical (0.2.10 > 0.2.9)
    expect(classifyLaunch('0.2.10', '0.2.9')).toBe('whats-new')
    expect(classifyLaunch('1.0.0', '0.9.9')).toBe('whats-new')
  })

  it('stored === current → normal launch → nothing', () => {
    expect(classifyLaunch(CURRENT, CURRENT)).toBeNull()
    expect(classifyLaunch('0.2.6', '0.2.6')).toBeNull()
  })

  it('stored > current → DOWNGRADE → nothing (never nag backwards)', () => {
    expect(classifyLaunch('0.3.0', '0.3.1')).toBeNull()
    expect(classifyLaunch('0.2.9', '0.2.10')).toBeNull()
    expect(classifyLaunch('0.9.9', '1.0.0')).toBeNull()
  })
})

describe('classifyLaunch — corrupt / unparseable stored version', () => {
  it('garbage string degrades to first install (welcome), not a throw', () => {
    expect(classifyLaunch(CURRENT, 'garbage')).toBe('welcome')
  })

  it('empty string degrades to first install', () => {
    expect(classifyLaunch(CURRENT, '')).toBe('welcome')
  })

  it('a non-numeric prefix degrades to first install', () => {
    expect(classifyLaunch(CURRENT, 'v0.3.0')).toBe('welcome')
    expect(classifyLaunch(CURRENT, 'beta')).toBe('welcome')
  })

  it('a valid core with a prerelease tail is still parseable (not corrupt)', () => {
    // 0.3.1-rc1 has a valid core prefix → parseable. Same core as current →
    // treated as equal → nothing (the documented rc→stable-same-core behavior).
    expect(classifyLaunch('0.3.1', '0.3.1-rc1')).toBeNull()
    // An rc of an OLDER core is still a real "older" version → whats-new.
    expect(classifyLaunch('0.3.1', '0.3.0-rc1')).toBe('whats-new')
  })
})

describe('write-on-dismissal contract', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it('dismissal writes the current version; a second launch shows nothing', () => {
    // First launch: no stored version → welcome.
    expect(classifyLaunch(CURRENT, readLastSeenVersion())).toBe('welcome')
    // User dismisses → version is recorded.
    writeLastSeenVersion(CURRENT)
    expect(readLastSeenVersion()).toBe(CURRENT)
    // Second launch: stored === current → nothing.
    expect(classifyLaunch(CURRENT, readLastSeenVersion())).toBeNull()
  })

  it('after an update, dismissal records the new version and a relaunch shows nothing', () => {
    // User had seen 0.3.0.
    writeLastSeenVersion('0.3.0')
    expect(classifyLaunch(CURRENT, readLastSeenVersion())).toBe('whats-new')
    // Dismiss the what's-new screen → records the new current.
    writeLastSeenVersion(CURRENT)
    expect(classifyLaunch(CURRENT, readLastSeenVersion())).toBeNull()
  })

  it('a crash BEFORE dismissal (version never written) re-shows the screen next launch', () => {
    // First install, screen shown, but the user force-quits before dismissing
    // → nothing was written → the next launch still sees no stored version.
    expect(readLastSeenVersion()).toBeNull()
    expect(classifyLaunch(CURRENT, readLastSeenVersion())).toBe('welcome')

    // Same for the update path: stored is the OLD version, crash before dismiss
    // → the old version is still stored → next launch still sees "updated".
    writeLastSeenVersion('0.3.0')
    // (no writeLastSeenVersion(CURRENT) — the crash)
    expect(classifyLaunch(CURRENT, readLastSeenVersion())).toBe('whats-new')
  })
})

describe('streamlinkProbeFromResult — present never yields the install path', () => {
  it('a present install resolves to "present" (install commands never render for it)', () => {
    const r = streamlinkProbeFromResult({ present: true, platform: 'linux' })
    expect(r.state).toBe('present')
    expect(r.platform).toBe('linux')
  })

  it('a missing install resolves to "missing" and carries the platform', () => {
    const r = streamlinkProbeFromResult({ present: false, platform: 'macos' })
    expect(r.state).toBe('missing')
    expect(r.platform).toBe('macos')
  })

  it('passes the platform through for every OS (used to pick the install command)', () => {
    expect(streamlinkProbeFromResult({ present: false, platform: 'windows' }).platform).toBe('windows')
    expect(streamlinkProbeFromResult({ present: true, platform: 'windows' }).state).toBe('present')
  })
})
