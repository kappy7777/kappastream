import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

// Drift guard for the window/transparency posture of the embedded-libmpv
// engine (feature `mpv-embed`, see src-tauri/src/mpv/).
//
// THE RULE (owner scope decision 2026-09-18): the engine is LINUX-ONLY and
// needs NO transparency ANYWHERE — the Linux surface draws video ABOVE the
// fully opaque webview. Concretely:
//   - no config, base or overlay, may set `macOSPrivateApi` (the flag once
//     existed only for the removed macOS below-webview surface, and had to
//     be carried by every overlay to satisfy tauri-build's exact
//     feature-equality check — the overlays tauri.linux.conf.json and
//     tauri.macos.conf.json existed for exactly that and are deleted),
//   - no config may declare a `transparent: true` window,
//   - Cargo.toml must not enable tauri's `macos-private-api` feature,
//   - the only per-target overlay is tauri.windows.conf.json, and its ONLY
//     job is the bundled-streamlink resource (unrelated to mpv).

// (node:path resolution rather than `new URL(relative, import.meta.url)`:
// the test environment's URL implementation does not resolve relative
// references against file:// bases.)
const here = dirname(fileURLToPath(import.meta.url))
const confDir = join(here, '../../src-tauri')
const readConfig = (name: string): Record<string, unknown> =>
  JSON.parse(readFileSync(join(confDir, name), 'utf8')) as Record<string, unknown>

type Conf = {
  app?: { macOSPrivateApi?: boolean; windows?: Array<Record<string, unknown>> }
  build?: { beforeBundleCommand?: string }
  bundle?: { macOS?: Record<string, unknown>; resources?: Record<string, string> }
}

/** Every tauri*.conf.json currently in src-tauri (base + overlays). */
const configFiles = readdirSync(confDir)
  .filter((f) => /^tauri.*\.conf\.json$/.test(f))
  .sort()
const configs: Array<[string, Conf]> = configFiles.map((f) => [f, readConfig(f) as Conf])
const base = readConfig('tauri.conf.json') as Conf
const windows = readConfig('tauri.windows.conf.json') as Conf

describe('tauri.conf.json window opacity (mpv engine is Linux-only)', () => {
  it('the config set is exactly the base + the Windows streamlink overlay', () => {
    // tauri.linux.conf.json and tauri.macos.conf.json existed ONLY to carry
    // macOSPrivateApi for tauri-build's feature-equality check; with no
    // platform needing transparency they must stay deleted.
    expect(configFiles).toEqual(['tauri.conf.json', 'tauri.windows.conf.json'])
  })

  it('NO config sets macOSPrivateApi (anywhere it could hide)', () => {
    for (const [name, conf] of configs) {
      expect(conf.app?.macOSPrivateApi ?? false, `${name}.app.macOSPrivateApi`).toBe(false)
    }
  })

  it('NO config declares a transparent window', () => {
    for (const [name, conf] of configs) {
      for (const [i, win] of (conf.app?.windows ?? []).entries()) {
        expect(win.transparent ?? false, `${name}.app.windows[${i}].transparent`).toBe(false)
      }
    }
    expect(base.app?.windows).toHaveLength(1)
  })

  it('the Windows overlay carries ONLY the bundled-streamlink resource (no mpv payloads)', () => {
    expect(windows.app).toBeUndefined()
    expect(windows.bundle?.resources).toEqual({ '../streamlink-bundle/': 'streamlink/' })
  })

  it("Cargo.toml does not enable tauri's macos-private-api feature", () => {
    const cargo = readFileSync(join(confDir, 'Cargo.toml'), 'utf8')
    const line = cargo.split('\n').find((l) => /^tauri = \{/.test(l))
    expect(line).toBeDefined()
    const features = line!.match(/features = \[([^\]]*)\]/)?.[1] ?? ''
    expect(features).not.toContain('macos-private-api')
    expect(features).toContain('"tray-icon"')
  })

  it('the base config declares no macOS bundle hooks (no entitlements, no dylib bundle)', () => {
    expect(base.build?.beforeBundleCommand).toBeUndefined()
    // minimumSystemVersion / signingIdentity stay; the entitlements
    // reference (disable-library-validation for the removed dylib bundle)
    // must not come back.
    expect(base.bundle?.macOS).toBeDefined()
    expect(base.bundle?.macOS?.entitlements).toBeUndefined()
    expect(existsSync(join(here, '../../packaging/macos'))).toBe(false)
  })
})
