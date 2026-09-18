import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

// Drift guard for the embedded-libmpv engine's window/transparency posture
// (feature `mpv-embed`, see src-tauri/src/mpv/).
//
// THE RULE: the BASE tauri.conf.json stays platform-neutral — no
// `transparent: true`, no `macOSPrivateApi`. Per-platform overrides live
// ONLY in the overlays. An overlay that overrides `app.windows` must carry
// the COMPLETE entry (Tauri merges overlays with RFC 7396, which REPLACES
// arrays wholesale — a delta windows array would drop every base window
// key); `transparent: true` is only for below-webview platforms.
//
// PLATFORM POSTURE (2026-09-18): Windows draws video ABOVE a fully OPAQUE
// page (win32.rs — the below-webview design cannot work: WebView2
// composites through DirectComposition, so a sibling HWND beneath it is
// unrevealable), so tauri.windows.conf.json carries NO windows override at
// all — it inherits the base opaque window. macOS is still the
// below-webview design (never launched; its surface redesign is a pending
// task), so its overlay keeps the FULL transparent window entry.
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
  app: { macOSPrivateApi?: boolean; windows?: Array<Record<string, unknown>> }
  bundle?: { macOS?: { entitlements?: string } }
}
const base = readConfig('tauri.conf.json') as Conf
const linux = readConfig('tauri.linux.conf.json') as Conf
const windows = readConfig('tauri.windows.conf.json') as Conf
const macos = readConfig('tauri.macos.conf.json') as Conf

describe('tauri.conf.json window opacity (mpv-embed posture)', () => {
  it('the BASE config is platform-neutral: no transparent window, no macOSPrivateApi', () => {
    expect(base.app.windows).toHaveLength(1)
    expect(base.app.windows![0].transparent ?? false).toBe(false)
    expect(base.app.macOSPrivateApi ?? false).toBe(false)
  })

  it('the Windows overlay overrides NO window keys — it inherits the base OPAQUE window (video sits above the page)', () => {
    // The old below-webview design needed a transparent window; Windows
    // now mirrors Linux (opaque page, video above). An `app.windows` array
    // here would silently reintroduce a transparent-or-stale window via
    // the RFC 7396 wholesale array replace.
    expect(windows.app.windows).toBeUndefined()
  })

  it('the macOS overlay (still below-webview) overrides the window with the FULL transparent entry (RFC 7396 replaces arrays)', () => {
    expect(macos.app.windows).toHaveLength(1)
    // The overlay entry must be complete, not a delta — every base window
    // key repeated — or the merged config would silently lose the rest.
    for (const key of Object.keys(base.app.windows![0])) {
      expect(macos.app.windows![0]).toHaveProperty(key)
    }
    expect(macos.app.windows![0].transparent).toBe(true)
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

  it('the macOS overlay ships the disable-library-validation entitlement (library-validation launch fix, 2026-09-18)', () => {
    // tauri-bundler signs the main executable ad-hoc WITH hardened runtime
    // (bundle.macOS.hardenedRuntime defaults true) → library validation on →
    // the separately ad-hoc-signed mpv-libs dylibs (no team identity to
    // match) are rejected and dyld kills the app before main(). The
    // entitlement opts out of exactly that check. release.yml's signing
    // gate verifies the SHIPPED .app carries it; this pins the config side.
    expect(macos.bundle?.macOS?.entitlements).toBe('packaging/macos/Entitlements.plist')
    const plist = readFileSync(join(here, '../../packaging/macos/Entitlements.plist'), 'utf8')
    expect(plist).toContain('com.apple.security.cs.disable-library-validation')
    expect(plist).toContain('<true/>')
  })
})
