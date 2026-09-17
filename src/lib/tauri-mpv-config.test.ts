import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

// Drift guard for the embedded-libmpv engine's transparency posture
// (feature `mpv-embed`, see src-tauri/src/mpv/). The video hole is opened at
// RUNTIME by the platform surfaces: the webview's own background is set
// fully transparent and GTK blends it into the OPAQUE toplevel buffer, so
// the GLArea underneath shows through the page's hole. The toplevel itself
// must NOT be a translucent window — a transparent Wayland toplevel loses
// the compositor's opaque-region hint and made every repaint of the whole
// app crawl on NVIDIA (laggy UI, tooltips sticking, ~30 s until the first
// video frame). A build-time overlay (src-tauri/tauri.mpv.conf.json, with
// `transparent: true` + `macOSPrivateApi`) once carried this; it was
// deleted when transparency moved runtime-only. This test makes a quiet
// re-introduction (e.g. someone "fixing" the hole via the main config) a CI
// failure instead.

// (node:path resolution rather than `new URL(relative, import.meta.url)`:
// the test environment's URL implementation does not resolve relative
// references against file:// bases.)
const here = dirname(fileURLToPath(import.meta.url))
const readConfig = (name: string): unknown => JSON.parse(readFileSync(join(here, '../../src-tauri', name), 'utf8'))
const base = readConfig('tauri.conf.json') as {
  app: { macOSPrivateApi?: boolean; windows: Array<Record<string, unknown>> }
}

describe('tauri.conf.json window opacity (mpv-embed posture)', () => {
  it('the main window is NOT transparent — the mpv hole is runtime webview alpha, not a translucent toplevel', () => {
    expect(base.app.windows).toHaveLength(1)
    expect(base.app.windows[0].transparent ?? false).toBe(false)
    // The private-API flag existed only to enable window transparency on
    // macOS; in the base config it would affect every default build.
    expect(base.app.macOSPrivateApi ?? false).toBe(false)
  })
})
