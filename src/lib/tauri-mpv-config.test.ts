import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

// Drift guard for the embedded-libmpv engine's window/transparency posture
// (feature `mpv-embed`, see src-tauri/src/mpv/). Windows/macOS place the
// native video surface BELOW a TRANSPARENT webview (Linux instead draws video
// ABOVE a fully opaque page — no transparency anywhere), so the two
// below-webview platforms override the window config in their per-platform
// overlays with `transparent: true`.
//
// THE RULE: the BASE tauri.conf.json stays platform-neutral — no
// `transparent: true`, no `macOSPrivateApi`. Platform overrides live ONLY in
// the overlays, each of which carries the COMPLETE `app.windows` entry
// (Tauri merges overlays with RFC 7396, which REPLACES arrays wholesale — a
// delta windows array would drop every base window key).
//
// WHY macOSPrivateApi SITS IN ALL THREE OVERLAYS, not just the macOS one:
// tauri-build's allowlist check (tauri-build src/manifest.rs) requires the
// Cargo.toml `tauri` feature list to EXACTLY equal the merged platform
// config's `app.features()` for EVERY build target — and the manifest is one
// static file. With the flag in the macos overlay alone, the Linux/Windows
// check demands the `macos-private-api` feature be REMOVED while the macOS
// check demands it be PRESENT (both error directions verified empirically
// 2026-09-17; current upstream master has the same exact-equality check).
// The flag is semantically inert off macOS (wry cfg-gates the private-API
// path to macOS), so duplicating it into every overlay is what keeps every
// target's expectation identical — the only arrangement that leaves the base
// config clean AND every target compiling. Removing it from ANY overlay (or
// from the Cargo.toml feature list) re-breaks a platform build; this test
// pins all four sides of that invariant.

// (node:path resolution rather than `new URL(relative, import.meta.url)`:
// the test environment's URL implementation does not resolve relative
// references against file:// bases.)
const here = dirname(fileURLToPath(import.meta.url))
const readConfig = (name: string): unknown => JSON.parse(readFileSync(join(here, '../../src-tauri', name), 'utf8'))

type Conf = {
  app: { macOSPrivateApi?: boolean; windows: Array<Record<string, unknown>> }
}
const base = readConfig('tauri.conf.json') as Conf
const linux = readConfig('tauri.linux.conf.json') as Conf
const windows = readConfig('tauri.windows.conf.json') as Conf
const macos = readConfig('tauri.macos.conf.json') as Conf

describe('tauri.conf.json window opacity (mpv-embed posture)', () => {
  it('the BASE config is platform-neutral: no transparent window, no macOSPrivateApi', () => {
    expect(base.app.windows).toHaveLength(1)
    expect(base.app.windows[0].transparent ?? false).toBe(false)
    expect(base.app.macOSPrivateApi ?? false).toBe(false)
  })

  it('the below-webview platforms (windows/macos overlays) make the window transparent — each with the FULL windows entry (RFC 7396 replaces arrays)', () => {
    for (const conf of [windows, macos]) {
      expect(conf.app.windows).toHaveLength(1)
      // The overlay entry must be complete, not a delta — every base window
      // key repeated — or the merged config would silently lose the rest.
      for (const key of Object.keys(base.app.windows[0])) {
        expect(conf.app.windows[0]).toHaveProperty(key)
      }
      expect(conf.app.windows[0].transparent).toBe(true)
    }
  })

  it('macOSPrivateApi is carried by ALL THREE overlays (tauri-build allowlist coupling — see header)', () => {
    // The macOS build needs the private API for a transparent WKWebView;
    // Linux/Windows must carry the SAME flag so their allowlist check keeps
    // expecting the `macos-private-api` Cargo feature this repo enables
    // unconditionally (one static manifest cannot satisfy different
    // per-target expectations).
    for (const conf of [linux, windows, macos]) {
      expect(conf.app.macOSPrivateApi).toBe(true)
    }
  })

  it("Cargo.toml enables tauri's macos-private-api feature (the manifest half of the allowlist invariant)", () => {
    const cargo = readFileSync(join(here, '../../src-tauri/Cargo.toml'), 'utf8')
    const line = cargo.split('\n').find((l) => /^tauri = \{/.test(l))
    expect(line).toBeDefined()
    const features = line!.match(/features = \[([^\]]*)\]/)?.[1] ?? ''
    expect(features).toContain('"macos-private-api"')
    expect(features).toContain('"tray-icon"')
  })
})
