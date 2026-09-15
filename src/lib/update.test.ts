import { describe, it, expect, beforeEach, vi } from 'vitest'

/*
 * Unit tests for src/lib/update.svelte.ts — the in-app updater store.
 *
 * The plugin boundary is the ONLY thing mocked (the pip-controller suite's
 * pattern): `check` and `relaunch` are captured closures, `isTauri` is a
 * switch, and each test re-imports the module (vi.resetModules) so the
 * exported singleton starts clean. The fake Update handle carries a vi.fn
 * downloadAndInstall so "nothing downloads without an explicit click" is
 * assertable.
 *
 * The load-bearing contract under test is the header's silence rule: a
 * FAILED check must never surface UI. The AUR clause especially — there the
 * plugins are unregistered and `check()` rejects immediately; a regression
 * that shows a banner there is both a bug report and an embarrassment. The
 * one path allowed to show UI is 'error', and only because the user clicked.
 */

const updater = vi.hoisted(() => ({
  // Swapped per test; resolves to a fake Update handle or null.
  checkImpl: async (): Promise<unknown> => null,
  checkCalls: 0,
  relaunchCalls: 0,
  tauriEnabled: true,
}))

vi.mock('@tauri-apps/plugin-updater', () => ({
  check: (opts: unknown): Promise<unknown> => {
    updater.checkCalls++
    void opts
    return updater.checkImpl()
  },
}))
vi.mock('@tauri-apps/plugin-process', () => ({
  relaunch: (): Promise<void> => {
    updater.relaunchCalls++
    return Promise.resolve()
  },
}))
vi.mock('@tauri-apps/api/core', () => ({
  isTauri: () => updater.tauriEnabled,
}))

type UpdateMod = typeof import('./update.svelte')
let U: UpdateMod
let store: UpdateMod['updateStore']

interface FakeUpdateOpts {
  version?: string
  currentVersion?: string
  body?: string | null
  date?: string | null
  downloadAndInstall?: (onEvent?: (e: { event: string; data: never }) => void) => Promise<void>
}

/** The plugin's Update handle, reduced to the fields the store reads. */
function fakeUpdate(opts: FakeUpdateOpts = {}) {
  const handle: {
    version: string
    currentVersion: string
    body: string | null
    date: string | null
    downloadAndInstall: NonNullable<FakeUpdateOpts['downloadAndInstall']>
  } = {
    version: opts.version ?? '1.0.5',
    currentVersion: opts.currentVersion ?? '1.0.4',
    body: 'Release notes for 1.0.5.',
    date: '2026-09-15T00:00:00Z',
    downloadAndInstall: opts.downloadAndInstall ?? vi.fn(async () => {}),
  }
  // Explicit null must survive (null and "unset" differ for body/date).
  if (opts.body !== undefined) handle.body = opts.body
  if (opts.date !== undefined) handle.date = opts.date
  return handle
}

beforeEach(async () => {
  vi.resetModules()
  localStorage.clear()
  updater.checkCalls = 0
  updater.relaunchCalls = 0
  updater.tauriEnabled = true
  updater.checkImpl = async () => null
  // The store logs failures to the console by design; keep test output clean.
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
  U = await import('./update.svelte')
  store = U.updateStore
})

describe('silent-failure contract (the header rule)', () => {
  it('a network-style check rejection stays fully silent', async () => {
    updater.checkImpl = async () => {
      throw new Error('network error: failed to fetch latest.json')
    }
    await store.check()
    expect(store.status).toBe('idle')
    expect(store.visible).toBe(false)
    expect(store.errorMsg).toBeNull()
  })

  it('a plugin-not-found rejection (the AUR path) stays fully silent', async () => {
    updater.checkImpl = async () => {
      throw new Error('plugin updater not found')
    }
    await store.check()
    expect(store.status).toBe('idle')
    expect(store.visible).toBe(false)
    expect(store.errorMsg).toBeNull()
  })

  it('check() resolving null (no update) stays idle with no UI', async () => {
    updater.checkImpl = async () => null
    await store.check()
    expect(store.status).toBe('idle')
    expect(store.visible).toBe(false)
    expect(store.errorMsg).toBeNull()
    expect(store.version).toBeNull()
  })
})

describe('environment gating', () => {
  it('isTauri() false: check() returns without calling the plugin at all', async () => {
    updater.tauriEnabled = false
    await store.check()
    expect(updater.checkCalls).toBe(0)
    expect(store.status).toBe('idle')
    expect(store.visible).toBe(false)
  })
})

describe('the isVersionNewer gate', () => {
  it('an EQUAL version does not produce a banner', async () => {
    updater.checkImpl = async () => fakeUpdate({ version: '1.0.4', currentVersion: '1.0.4' })
    await store.check()
    expect(store.status).toBe('idle')
    expect(store.visible).toBe(false)
    expect(store.version).toBeNull()
  })

  it('an OLDER version does not produce a banner (downgrade guard)', async () => {
    updater.checkImpl = async () => fakeUpdate({ version: '1.0.3', currentVersion: '1.0.4' })
    await store.check()
    expect(store.status).toBe('idle')
    expect(store.visible).toBe(false)
    expect(store.version).toBeNull()
  })
})

describe('a genuine update', () => {
  it('sets status available with metadata, and downloads/installs NOTHING without a click', async () => {
    const dl = vi.fn(async () => {})
    updater.checkImpl = async () => fakeUpdate({ downloadAndInstall: dl })
    await store.check()
    expect(store.status).toBe('available')
    expect(store.visible).toBe(true)
    expect(store.version).toBe('1.0.5')
    expect(store.currentVersion).toBe('1.0.4')
    expect(store.notes).toBe('Release notes for 1.0.5.')
    expect(store.pubDate).toBe('2026-09-15T00:00:00Z')
    // The silence of the plugin is the point: no download, no install, no
    // relaunch until the user explicitly clicks Update.
    expect(dl).not.toHaveBeenCalled()
    expect(updater.relaunchCalls).toBe(0)
  })

  it('a null body/date surfaces as null (not undefined, not a placeholder)', async () => {
    updater.checkImpl = async () => fakeUpdate({ body: null, date: null })
    await store.check()
    expect(store.status).toBe('available')
    expect(store.notes).toBeNull()
    expect(store.pubDate).toBeNull()
  })
})

describe('getters', () => {
  it('visible is false only for idle, and a dismissed banner stays hidden', async () => {
    expect(store.visible).toBe(false) // idle

    updater.checkImpl = async () => fakeUpdate()
    await store.check()
    expect(store.visible).toBe(true) // available

    store.dismiss()
    expect(store.dismissed).toBe(true)
    expect(store.visible).toBe(false) // dismissed pins it off
  })

  it('visible stays true through the busy statuses and the error status', async () => {
    for (const status of ['downloading', 'installing', 'error'] as const) {
      store.status = status
      expect(store.visible, status).toBe(true)
    }
  })

  it('busy is true only while downloading or installing', () => {
    expect(store.busy).toBe(false) // idle
    store.status = 'available'
    expect(store.busy).toBe(false)
    store.status = 'downloading'
    expect(store.busy).toBe(true)
    store.status = 'installing'
    expect(store.busy).toBe(true)
    store.status = 'error'
    expect(store.busy).toBe(false)
  })

  it('fraction is null without a contentLength, exact in between, clamped to 1 past it', () => {
    store.downloaded = 50
    store.contentLength = 0
    expect(store.fraction).toBeNull() // unknown total → no progress bar

    store.contentLength = 200
    expect(store.fraction).toBe(0.25)

    store.downloaded = 999
    expect(store.fraction).toBe(1) // never > 1 on a lying contentLength
  })
})

describe('apply() — the explicit-click path', () => {
  async function makeAvailable(downloadAndInstall: FakeUpdateOpts['downloadAndInstall']): Promise<void> {
    updater.checkImpl = async () => fakeUpdate({ downloadAndInstall })
    await store.check()
  }

  it('apply() without a pending update is a no-op', async () => {
    await store.apply()
    expect(store.status).toBe('idle')
    expect(updater.relaunchCalls).toBe(0)
  })

  it('drives Started/Progress/Finished events into the visible state, then relaunches', async () => {
    await makeAvailable(async (onEvent) => {
      onEvent?.({ event: 'Started', data: { contentLength: 100 } as never })
      onEvent?.({ event: 'Progress', data: { chunkLength: 40 } as never })
      onEvent?.({ event: 'Progress', data: { chunkLength: 40 } as never })
      onEvent?.({ event: 'Finished', data: {} as never })
    })
    await store.apply()
    expect(store.status).toBe('installing')
    expect(store.downloaded).toBe(80)
    expect(store.contentLength).toBe(100)
    expect(store.fraction).toBe(0.8)
    expect(updater.relaunchCalls).toBe(1)
  })

  it('dismiss() is ignored while busy (the × control is hidden by contract)', async () => {
    let finish!: () => void
    await makeAvailable(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve
        }),
    )
    const applying = store.apply()
    expect(store.status).toBe('downloading')
    store.dismiss()
    expect(store.dismissed).toBe(false)
    expect(store.visible).toBe(true)
    finish()
    await applying
  })

  it('a failed download sets status error and populates errorMsg (UI allowed: user clicked)', async () => {
    await makeAvailable(async () => {
      throw new Error('invalid minisign signature')
    })
    await store.apply()
    expect(store.status).toBe('error')
    expect(store.errorMsg).toBe('invalid minisign signature')
    expect(store.visible).toBe(true)
    expect(updater.relaunchCalls).toBe(0)
  })

  it('a non-Error rejection stringifies into errorMsg', async () => {
    await makeAvailable(async () => {
      throw 'plain string failure'
    })
    await store.apply()
    expect(store.status).toBe('error')
    expect(store.errorMsg).toBe('plain string failure')
  })
})
