import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

// Source contract: the app ships its own borderless resize handles because
// the window is decorations:false (no server-side edges on Wayland), and on
// Linux they are the ONLY working mouse-resize path once the native engine
// has booted — the engine's GTK reparent disables tauri's built-in
// undecorated-resize handler for the rest of the session (see
// src-tauri/src/mpv/linux.rs). This pins all 8 handles so a cleanup pass
// cannot drop them as redundant.
describe('borderless resize handles (App.svelte source contract)', () => {
  const source = readFileSync(join(process.cwd(), 'src/App.svelte'), 'utf8')
  const handles = [
    ['n', 'North'],
    ['s', 'South'],
    ['w', 'West'],
    ['e', 'East'],
    ['nw', 'NorthWest'],
    ['ne', 'NorthEast'],
    ['sw', 'SouthWest'],
    ['se', 'SouthEast'],
  ] as const

  it('keeps all 8 edge handles, each wired to startWinResize', () => {
    for (const [edge, dir] of handles) {
      expect(source).toMatch(
        new RegExp(`class="rz rz-${edge}"[^>]*onmousedown=\\{\\(\\) => startWinResize\\('${dir}'\\)\\}`),
      )
    }
    expect(source.match(/class="rz rz-/g)).toHaveLength(8)
  })

  it('documents that on Linux these are the only working resize path', () => {
    expect(source).toMatch(/ONLY working mouse-resize path/)
    expect(source).toMatch(/undecorated-resize handler/)
  })
})
