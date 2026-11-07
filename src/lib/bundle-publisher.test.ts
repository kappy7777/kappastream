import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

// Drift guard for `bundle.publisher` in tauri.conf.json.
//
// When the publisher key is absent, tauri derives it from the SECOND element
// of the identifier: `dev.kappy.kappastream` → `kappy`, but
// `io.github.kappy7777.kappastream` → `github`. On Windows the NSIS installer
// keys its registry data under `Software\<publisher>\<productName>` (previous
// install dir, uninstall entry, language choice), so letting it silently
// follow the identifier would orphan the pre-rename install data on upgrade.
// The deb/rpm Maintainer is unaffected — it comes from Cargo.toml `authors`.

// (node:path resolution rather than `new URL(relative, import.meta.url)`:
// the test environment's URL implementation does not resolve relative
// references against file:// bases.)
const here = dirname(fileURLToPath(import.meta.url))
const conf = JSON.parse(readFileSync(join(here, '../../src-tauri/tauri.conf.json'), 'utf8')) as {
  identifier: string
  bundle?: { publisher?: string }
}

describe('tauri.conf.json bundle.publisher', () => {
  it('is pinned to the pre-rename value', () => {
    expect(conf.bundle?.publisher).toBe('kappy')
  })

  it('does not match the identifier-derived default', () => {
    // If the identifier ever changes again, this pins the coupling that makes
    // the explicit key necessary: the derived default is the second segment.
    const derived = conf.identifier.split('.')[1]
    expect(derived).not.toBe('kappy')
  })
})
