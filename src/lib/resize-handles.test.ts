import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

// Source contract: the app ships its own borderless resize handles because
// the window is decorations:false (no server-side edges on Wayland).
// tauri's built-in undecorated-resize handler works alongside them in
// every mode (the engine's GTK reparent no longer disables it; see
// src-tauri/src/mpv/linux.rs), and the handles stay on purpose as the
// app-controlled path. This pins all 8 handles so a cleanup pass cannot
// drop them as redundant next to tauri's handler.
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

  it('documents that the handles stay despite tauri edge resize working', () => {
    expect(source).toMatch(/undecorated-resize\s+handler\s+works\s+alongside/)
    expect(source).toMatch(/never\s+remove the handles as redundant/)
  })
})
