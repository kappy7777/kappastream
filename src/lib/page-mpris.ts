// Webview-player reporting for the Rust MPRIS service inside the Flatpak
// (the counterpart of src-tauri/src/mpv/mpris.rs). WebKitGTK's own
// media-session bridge — what serves desktop media controls for the hls
// engine on native builds — never registers inside that sandbox, so the
// page reports what its player is doing and the service stands in:
// widgets see the channel title and avatar, and desktop play/pause comes
// back as an event on exactly the window that reported. The Rust command
// answers false outside the Flatpak (and rejects where it does not
// exist), after which the reporter stays silent — nothing ever competes
// with WebKitGTK's bridge there.

import { invoke, isTauri } from '@tauri-apps/api/core'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import { applyMediaAction, type MediaSessionControls } from './media-session'
import { HtmlVideoBackend, type VideoBackend } from './video-backend'

/** The Rust event a desktop play/pause request arrives on (own window). */
export const PAGE_MPRIS_ACTION_EVENT = 'ks://mpris-action'

/** What the page reports: anything not loaded or failed is "stopped",
 * which drops the window's MPRIS note. */
export type PageMediaState = 'playing' | 'paused' | 'stopped'

/** The element surface pageMediaState reads — the four fields are all it
 * needs, which keeps tests free of a real <video>. */
export type PageMediaElement = Pick<HTMLMediaElement, 'paused' | 'ended' | 'readyState' | 'error'> | null

export function pageMediaState(el: PageMediaElement, failed = false): PageMediaState {
  if (!el || failed || el.error !== null || el.ended) return 'stopped'
  // readyState HAVE_NOTHING: nothing loaded yet, nothing to control.
  if (el.readyState < 1) return 'stopped'
  return el.paused ? 'paused' : 'playing'
}

/** Media events that can change the reported state. */
const PAGE_MEDIA_EVENTS = ['play', 'pause', 'playing', 'ended', 'emptied', 'loadedmetadata', 'error'] as const

/** Re-report on every media event that could move the state. Returns the
 * unsubscribe function. */
export function watchMediaElement(el: HTMLMediaElement, onChange: () => void): () => void {
  for (const type of PAGE_MEDIA_EVENTS) el.addEventListener(type, onChange)
  return () => {
    for (const type of PAGE_MEDIA_EVENTS) el.removeEventListener(type, onChange)
  }
}

/** The element the page reports on: the multi-view audio-authority tile's
 * video, or the single-view player's element while it is the hls backend.
 * Native playback is served by the engines themselves; null (an mpv
 * authority tile, no playback) reports "stopped". */
export function pageMediaElement(opts: {
  multiView: boolean
  authorityVideo: HTMLVideoElement | null
  backend: VideoBackend | null
}): HTMLVideoElement | null {
  if (opts.multiView) return opts.authorityVideo
  return opts.backend instanceof HtmlVideoBackend ? opts.backend.element : null
}

export interface PageMprisReport {
  state: PageMediaState
  title: string | null
  artUrl: string | null
}

export interface PageMprisReporter {
  report(note: PageMprisReport): void
}

/** The reporting side: identical notes are skipped, the first note always
 * sends (it also clears a leftover note from a previous surface), at most
 * one note is in flight with the latest queued behind it (invokes have no
 * guaranteed arrival order), and the reporter goes quiet forever after an
 * answer that is not true or a rejection. */
export function createPageMprisReporter(): PageMprisReporter {
  let disabled = false
  let inFlight = false
  let queued: PageMprisReport | null = null
  let lastSent: string | null = null

  const send = (note: PageMprisReport): void => {
    inFlight = true
    invoke('mpris_note_page', {
      state: note.state,
      // A stopped note drops title and art: the Rust side removes it.
      title: note.state === 'stopped' ? null : note.title,
      artUrl: note.state === 'stopped' ? null : note.artUrl,
    })
      .then((answer) => {
        inFlight = false
        if (answer !== true) {
          disabled = true
          queued = null
          return
        }
        const next = queued
        queued = null
        if (next) send(next)
      })
      .catch(() => {
        disabled = true
        inFlight = false
        queued = null
      })
  }

  return {
    report(note: PageMprisReport): void {
      if (disabled || !isTauri()) return
      const key = JSON.stringify(note)
      if (lastSent === key) return
      lastSent = key
      if (inFlight) {
        queued = note
        return
      }
      send(note)
    },
  }
}

/** Listen for desktop play/pause on OUR window (the Rust side scopes the
 * event to the window that reported playback) and route it through the
 * same controls the Media Session handlers use. `label` comes from the
 * window API; a non-string (non-Tauri hosts) binds nothing. */
export function bindPageMprisActions(label: unknown, getControls: () => MediaSessionControls | null): () => void {
  if (typeof label !== 'string' || !isTauri()) return () => {}
  let unlisten: UnlistenFn | null = null
  let active = true
  void listen<{ action: 'play' | 'pause' }>(
    PAGE_MPRIS_ACTION_EVENT,
    (e) => {
      const action = e.payload?.action
      if (action !== 'play' && action !== 'pause') return
      applyMediaAction(action, getControls())
    },
    { target: label },
  )
    .then((fn) => {
      if (active) unlisten = fn
      else fn()
    })
    .catch(() => {
      // A failed registration (host without the event transport) binds
      // nothing; desktop actions simply stay with the webview session.
    })
  return () => {
    active = false
    unlisten?.()
    unlisten = null
  }
}
