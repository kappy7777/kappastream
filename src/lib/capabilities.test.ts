import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

// Drift guard for the window-capability split: the main window holds the
// full permission set, and the PiP window — a second webview whose page
// renders the same app bundle — holds ONLY the window APIs its code
// actually calls (close/destroy, sizing, always-on-top, dragging, events).
// A permission silently added to the pip capability (or the pip window
// creeping back into default.json) widens what a compromised PiP page
// could reach, so the shape is pinned here.

// (node:path resolution rather than `new URL(relative, import.meta.url)`:
// the test environment's URL implementation does not resolve relative
// references against file:// bases.)
const here = dirname(fileURLToPath(import.meta.url))
const capsDir = join(here, '../../src-tauri/capabilities')

interface Capability {
  identifier: string
  windows: string[]
  permissions: string[]
}

function readCapability(name: string): Capability {
  return JSON.parse(readFileSync(join(capsDir, name), 'utf8')) as Capability
}

describe('the PiP window capability (pip.json)', () => {
  const pip = readCapability('pip.json')

  it('applies only to the pip window', () => {
    expect(pip.windows).toEqual(['pip'])
  })

  it('grants exactly the window APIs PipWindow calls', () => {
    expect([...pip.permissions].sort()).toEqual(
      [
        'core:window:allow-close',
        'core:window:allow-destroy',
        'core:window:allow-set-size',
        'core:window:allow-set-always-on-top',
        'core:window:allow-start-dragging',
        'core:window:allow-start-resize-dragging',
        'core:event:allow-emit',
        'core:event:allow-listen',
        'core:event:allow-unlisten',
      ].sort(),
    )
  })

  it('grants no plugin or webview-creation power at all', () => {
    for (const perm of pip.permissions) {
      expect(
        perm.startsWith('updater:') ||
          perm.startsWith('process:') ||
          perm.startsWith('notification:') ||
          perm.startsWith('core:webview:') ||
          perm.startsWith('core:window:allow-outer-') ||
          perm.startsWith('core:window:allow-available-monitors') ||
          perm.startsWith('core:window:allow-current-monitor'),
        `unexpected pip permission ${perm}`,
      ).toBe(false)
    }
  })
})

describe('the main window capability (default.json)', () => {
  const main = readCapability('default.json')

  it('applies only to the main window', () => {
    expect(main.windows).toEqual(['main'])
  })
})
