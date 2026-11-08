import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it, expect, beforeEach, vi } from 'vitest'

/*
 * The Flatpak MPRIS stand-in's page half (see src-tauri/src/mpv/mpris.rs
 * for the Rust side). The Tauri boundary is the only thing mocked (the
 * pip-controller/update suite pattern): invoke is a dispatch table, listen
 * captures handlers. What is pinned:
 *
 *  - the state token derives from the element's own signals (anything
 *    unloaded/failed/ended is "stopped", which drops the window's note);
 *  - the reporter sends the FIRST note always, skips identical ones,
 *    keeps at most one note in flight with the latest queued behind it,
 *    strips title/art from stopped notes, and goes quiet forever after an
 *    answer that is not true or a rejection (native builds, where the
 *    webview's own bridge must not gain a competitor);
 *  - the action binding scopes its listener to the calling window, routes
 *    play/pause through the same guarded toggle the Media Session
 *    handlers use, ignores junk payloads, and unbinds cleanly even if
 *    called before the listen registration resolves;
 *  - the wiring in App/PipWindow is pinned as a source contract (the
 *    real-App mount harness covers the shared toggle path already).
 */

const tauri = vi.hoisted(() => ({
  tauriEnabled: true,
  invokeImpl: (): Promise<unknown> => Promise.resolve(true),
  invokeCalls: [] as Array<{ cmd: string; args?: Record<string, unknown> }>,
  listeners: [] as Array<{
    name: string
    handler: (e: { payload: unknown }) => void
    options?: unknown
    unlisten: ReturnType<typeof vi.fn>
  }>,
  listenResolvers: [] as Array<() => void>,
  holdListen: false,
  reset(): void {
    this.tauriEnabled = true
    this.invokeImpl = (): Promise<unknown> => Promise.resolve(true)
    this.invokeCalls = []
    this.listeners = []
    this.listenResolvers = []
    this.holdListen = false
  },
}))

vi.mock('@tauri-apps/api/core', () => ({
  isTauri: (): boolean => tauri.tauriEnabled,
  invoke: (cmd: string, args?: Record<string, unknown>) => {
    tauri.invokeCalls.push({ cmd, args })
    return tauri.invokeImpl()
  },
}))

vi.mock('@tauri-apps/api/event', () => ({
  listen: (name: string, handler: (e: { payload: unknown }) => void, options?: unknown): Promise<() => void> => {
    const unlisten = vi.fn()
    tauri.listeners.push({ name, handler, options, unlisten })
    return tauri.holdListen
      ? new Promise((resolve) => tauri.listenResolvers.push(() => resolve(unlisten)))
      : Promise.resolve(unlisten)
  },
}))

import {
  PAGE_MPRIS_ACTION_EVENT,
  bindPageMprisActions,
  createPageMprisReporter,
  pageMediaElement,
  pageMediaState,
  watchMediaElement,
  type PageMediaElement,
} from './page-mpris'
import { HtmlVideoBackend, type VideoBackend } from './video-backend'

beforeEach(() => {
  tauri.reset()
})

const el = (over: Partial<PageMediaElement>): PageMediaElement =>
  ({
    paused: false,
    ended: false,
    readyState: 4,
    error: null,
    ...over,
  }) as PageMediaElement

describe('pageMediaState', () => {
  it('reports stopped for nothing loaded, failed, or ended', () => {
    expect(pageMediaState(null)).toBe('stopped')
    expect(pageMediaState(el({ readyState: 0, paused: true }))).toBe('stopped')
    expect(pageMediaState(el({}), true)).toBe('stopped')
    expect(pageMediaState(el({ error: {} as MediaError }))).toBe('stopped')
    expect(pageMediaState(el({ ended: true }))).toBe('stopped')
  })

  it('reports paused or playing once media is loaded', () => {
    expect(pageMediaState(el({ paused: true }))).toBe('paused')
    expect(pageMediaState(el({ paused: false }))).toBe('playing')
  })
})

describe('watchMediaElement', () => {
  it('re-reports on media events and unsubscribes cleanly', () => {
    const video = document.createElement('video')
    const cb = vi.fn()
    const unwatch = watchMediaElement(video, cb)
    video.dispatchEvent(new Event('play'))
    expect(cb).toHaveBeenCalledTimes(1)
    unwatch()
    video.dispatchEvent(new Event('pause'))
    expect(cb).toHaveBeenCalledTimes(1)
  })
})

describe('pageMediaElement', () => {
  it('follows the multi-view authority tile', () => {
    const authority = document.createElement('video')
    expect(pageMediaElement({ multiView: true, authorityVideo: authority, backend: null })).toBe(authority)
    // An mpv authority tile has no element here: stopped.
    expect(pageMediaElement({ multiView: true, authorityVideo: null, backend: null })).toBeNull()
  })

  it('uses the single-view element only while it is the hls backend', () => {
    const video = document.createElement('video')
    const hls = new HtmlVideoBackend(video)
    expect(pageMediaElement({ multiView: false, authorityVideo: null, backend: hls })).toBe(video)
    // The native engine serves itself; the page reports nothing.
    const mpvLike = {} as unknown as VideoBackend | null
    expect(pageMediaElement({ multiView: false, authorityVideo: null, backend: mpvLike })).toBeNull()
  })
})

describe('createPageMprisReporter', () => {
  it('sends the first note and skips identical ones', async () => {
    const reporter = createPageMprisReporter()
    const note = { state: 'playing' as const, title: 'somechannel', artUrl: null }
    reporter.report(note)
    reporter.report(note)
    await vi.waitFor(() => expect(tauri.invokeCalls.length).toBe(1))
    expect(tauri.invokeCalls[0]).toEqual({
      cmd: 'mpris_note_page',
      args: { state: 'playing', title: 'somechannel', artUrl: null },
    })
  })

  it('sends a changed note', async () => {
    const reporter = createPageMprisReporter()
    reporter.report({ state: 'playing', title: 'somechannel', artUrl: null })
    await vi.waitFor(() => expect(tauri.invokeCalls.length).toBe(1))
    reporter.report({ state: 'paused', title: 'somechannel', artUrl: null })
    await vi.waitFor(() => expect(tauri.invokeCalls.length).toBe(2))
    expect(tauri.invokeCalls[1]?.args?.state).toBe('paused')
  })

  it('strips title and art from stopped notes', async () => {
    const reporter = createPageMprisReporter()
    reporter.report({ state: 'stopped', title: 'somechannel', artUrl: 'https://x.invalid/a.png' })
    await vi.waitFor(() => expect(tauri.invokeCalls.length).toBe(1))
    expect(tauri.invokeCalls[0]?.args).toEqual({ state: 'stopped', title: null, artUrl: null })
  })

  it('queues at most one note and sends only the latest', async () => {
    // A wrapper object: TS does not track assignments made inside the
    // invokeImpl closure, so a bare `let` stays narrowed to null.
    const gate: { resolve: ((answer: unknown) => void) | null } = { resolve: null }
    tauri.invokeImpl = () => new Promise((resolve) => (gate.resolve = resolve))
    const reporter = createPageMprisReporter()
    reporter.report({ state: 'playing', title: 'chan1', artUrl: null })
    // Still in flight: both notes queue, only the latest survives.
    reporter.report({ state: 'paused', title: 'chan1', artUrl: null })
    reporter.report({ state: 'stopped', title: 'chan1', artUrl: null })
    expect(tauri.invokeCalls.length).toBe(1)
    gate.resolve?.(true)
    await vi.waitFor(() => expect(tauri.invokeCalls.length).toBe(2))
    expect(tauri.invokeCalls[1]?.args?.state).toBe('stopped')
  })

  it('goes quiet after an answer that is not true', async () => {
    tauri.invokeImpl = () => Promise.resolve(false)
    const reporter = createPageMprisReporter()
    reporter.report({ state: 'playing', title: 'somechannel', artUrl: null })
    await vi.waitFor(() => expect(tauri.invokeCalls.length).toBe(1))
    reporter.report({ state: 'paused', title: 'somechannel', artUrl: null })
    reporter.report({ state: 'stopped', title: null, artUrl: null })
    expect(tauri.invokeCalls.length).toBe(1)
  })

  it('goes quiet after a rejection', async () => {
    tauri.invokeImpl = () => Promise.reject(new Error('no such command'))
    const reporter = createPageMprisReporter()
    reporter.report({ state: 'playing', title: 'somechannel', artUrl: null })
    await vi.waitFor(() => expect(tauri.invokeCalls.length).toBe(1))
    reporter.report({ state: 'stopped', title: null, artUrl: null })
    expect(tauri.invokeCalls.length).toBe(1)
  })

  it('sends nothing outside Tauri', () => {
    tauri.tauriEnabled = false
    const reporter = createPageMprisReporter()
    reporter.report({ state: 'playing', title: 'somechannel', artUrl: null })
    expect(tauri.invokeCalls.length).toBe(0)
  })
})

describe('bindPageMprisActions', () => {
  const fire = (payload: unknown): void => {
    tauri.listeners[0]?.handler({ payload })
  }

  it('binds nothing without a window label', () => {
    bindPageMprisActions(undefined, () => null)
    expect(tauri.listeners.length).toBe(0)
  })

  it('scopes the listener to the calling window and routes guarded toggles', async () => {
    let playing = true
    const toggle = vi.fn()
    const unbind = bindPageMprisActions('main', () => ({ playing: () => playing, toggle }))
    await vi.waitFor(() => expect(tauri.listeners.length).toBe(1))
    expect(tauri.listeners[0]?.name).toBe(PAGE_MPRIS_ACTION_EVENT)
    expect(tauri.listeners[0]?.options).toEqual({ target: 'main' })

    fire({ action: 'pause' })
    expect(toggle).toHaveBeenCalledTimes(1)
    // A pause while paused (or a play while playing) must never toggle.
    playing = false
    fire({ action: 'pause' })
    fire({ action: 'play' })
    expect(toggle).toHaveBeenCalledTimes(2)
    // Junk payloads are ignored.
    fire({ action: 'stop' })
    fire(null)
    fire(undefined)
    expect(toggle).toHaveBeenCalledTimes(2)
    unbind()
    expect(tauri.listeners[0]?.unlisten).toHaveBeenCalled()
  })

  it('unbinds cleanly even before the listen registration resolves', async () => {
    tauri.holdListen = true
    const unbind = bindPageMprisActions('main', () => null)
    const unlisten = tauri.listeners[0]?.unlisten
    unbind()
    // Now the registration lands: the binding must unlisten immediately.
    tauri.listenResolvers.forEach((resolve) => resolve())
    await Promise.resolve()
    expect(unlisten).toHaveBeenCalled()
  })
})

// Source contract for the wiring in the two windows (node:fs like
// capabilities.test.ts: the app's window mocks in the big mount harnesses
// predate this module, and the shared toggle path those harnesses pin is
// the one the action binding routes through).
const here = dirname(fileURLToPath(import.meta.url))

describe('window wiring (source contract)', () => {
  it('App reports its player and binds desktop actions on its own window', () => {
    const app = readFileSync(join(here, '../App.svelte'), 'utf8')
    expect(app).toContain('createPageMprisReporter()')
    expect(app).toContain('pageMediaElement({ multiView, authorityVideo: authorityTileVideo, backend: videoBackend })')
    expect(app).toContain('watchMediaElement(el,')
    expect(app).toContain('pageMpris.report({ state: pageMediaState(pageMediaEl, failed), ...meta })')
    expect(app).toContain('bindPageMprisActions(currentWin()?.label, mediaControls)')
  })

  it('PipWindow reports its own player with the channel from pip-init', () => {
    const pip = readFileSync(join(here, '../PipWindow.svelte'), 'utf8')
    expect(pip).toContain('channel?: string')
    expect(pip).toContain('pipChannel = p.channel ?? null')
    expect(pip).toContain('title: pipChannel')
    expect(pip).toContain('bindPageMprisActions(getCurrentWindow().label, mediaControls)')
    // The controller already ships the channel on ks://pip-init.
    const controller = readFileSync(join(here, 'pip-controller.svelte.ts'), 'utf8')
    expect(controller).toContain('channel: this.currentStream.channel')
  })
})
