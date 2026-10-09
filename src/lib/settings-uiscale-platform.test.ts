import { describe, it, expect, beforeEach, vi } from 'vitest'

/*
 * Platform-dependent out-of-the-box UI scale (Windows 1×, elsewhere 1.25×).
 *
 * The split resolves asynchronously: the store is constructed at module
 * load — before the authoritative `target_os` round-trip can answer — so it
 * boots on the cross-platform default and App.svelte calls notePlatformOs()
 * once the platform is known. The contract pinned here:
 *  - Windows with NO saved scale adopts 1× and PERSISTS it, so the next
 *    launch constructs the store at 1× synchronously — without the write,
 *    every Windows launch would paint its first frame at 1.25× (the zoom
 *    is applied in the constructor, long before the platform resolves) and
 *    visibly snap;
 *  - a saved scale is never overridden (the absent-key-only rule);
 *  - other platforms keep the 1.25× default and never write the key;
 *  - the reset target (uiScaleDefault) follows the platform.
 *
 * The settings store is a singleton constructed at module load and reads
 * localStorage at construction time, so each test re-imports the module
 * (`vi.resetModules`) on a clean localStorage to assert launch behavior —
 * the same pattern as settings.test.ts.
 */

type SettingsMod = typeof import('./settings.svelte')
let S: SettingsMod

beforeEach(async () => {
  vi.resetModules()
  localStorage.clear()
  S = await import('./settings.svelte')
})

const KEY = 'app-ui-scale-v1'

describe('out-of-the-box UI scale by platform', () => {
  it('boots at the cross-platform default before the platform resolves', () => {
    expect(S.settings.uiScale).toBe(S.UI_SCALE_DEFAULT)
    expect(S.settings.uiScaleDefault).toBe(S.UI_SCALE_DEFAULT)
    expect(localStorage.getItem(KEY)).toBeNull()
  })

  it('Windows adopts 1× when no scale was ever saved, and persists it', () => {
    S.settings.notePlatformOs('windows')
    expect(S.settings.uiScale).toBe(S.UI_SCALE_DEFAULT_WINDOWS)
    expect(S.settings.uiScaleDefault).toBe(S.UI_SCALE_DEFAULT_WINDOWS)
    expect(localStorage.getItem(KEY)).toBe('1')
    expect(document.documentElement.style.zoom).toBe('1')
  })

  it('the persisted 1× is the NEXT launch’s synchronous start (no flash)', async () => {
    S.settings.notePlatformOs('windows')
    vi.resetModules()
    const next = await import('./settings.svelte')
    // Constructed straight at 1× — the constructor applies the zoom before
    // any platform call could, which is exactly why the adoption persists.
    expect(next.settings.uiScale).toBe(1)
    expect(document.documentElement.style.zoom).toBe('1')
    // And the resolved platform changes nothing on top of it.
    next.settings.notePlatformOs('windows')
    expect(next.settings.uiScale).toBe(1)
    expect(localStorage.getItem(KEY)).toBe('1')
  })

  it('a saved scale is never overridden — absent-key rule', async () => {
    localStorage.setItem(KEY, '2')
    vi.resetModules()
    const mod = await import('./settings.svelte')
    mod.settings.notePlatformOs('windows')
    expect(mod.settings.uiScale).toBe(2)
    expect(localStorage.getItem(KEY)).toBe('2')
    // The reset target still follows the platform.
    expect(mod.settings.uiScaleDefault).toBe(mod.UI_SCALE_DEFAULT_WINDOWS)
  })

  it('non-Windows platforms keep 1.25× and write nothing', () => {
    S.settings.notePlatformOs('linux')
    expect(S.settings.uiScale).toBe(S.UI_SCALE_DEFAULT)
    expect(S.settings.uiScaleDefault).toBe(S.UI_SCALE_DEFAULT)
    expect(localStorage.getItem(KEY)).toBeNull()
    S.settings.notePlatformOs('macos')
    expect(S.settings.uiScaleDefault).toBe(S.UI_SCALE_DEFAULT)
    expect(localStorage.getItem(KEY)).toBeNull()
  })

  it('resetUiScale targets the platform default', () => {
    S.settings.notePlatformOs('windows')
    S.settings.setUiScale(1.5)
    S.settings.resetUiScale()
    expect(S.settings.uiScale).toBe(S.UI_SCALE_DEFAULT_WINDOWS)
    expect(localStorage.getItem(KEY)).toBe('1')
  })
})
