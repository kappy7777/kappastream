// Media Session routing for OS-level media controls on the WEBVIEW's own
// playback: keyboard media keys, GNOME's media widget, Windows' SMTC.
// Without action handlers the engine delivers a hardware pause as a plain
// `pause` event on the active <video> — indistinguishable from a
// webkit2gtk underrun stall, so live stall recovery force-resumes it ~1s
// later (shouldRecoverStallAfterPause in playback.ts). Registering
// handlers takes the default behavior over: the surface pauses through
// its own userPaused discipline (the same path its play/pause button
// uses), which stall recovery correctly leaves alone.
//
// This covers the hls engine (a real media element drives the session).
// The NATIVE engine cannot work this way — WebKitGTK's MPRIS bridge only
// registers real, audio-producing media elements, and a stand-in element
// (muted or not) never registers — so native media keys are served by the
// Rust-side MPRIS D-Bus service instead (src-tauri/src/mpv/mpris.rs).
//
// Feature-detected per action: engines without Media Session, or that
// reject an action name, keep the previous behavior and bind nothing.
// One binding per document — App binds the single-view player or the
// multi-view audio authority; the PiP window (a separate webview) binds
// its own.

export interface MediaSessionControls {
  /** Whether the bound surface is currently playing. */
  playing: () => boolean
  /** The surface's play/pause path — it sets its own userPaused flag. */
  toggle: () => void
}

/**
 * Route the pause/play media actions into the surface `getControls`
 * returns. Each action only toggles when it would actually change the
 * state — a 'pause' key press while paused must never resume. The
 * returned function unbinds (a no-op when nothing bound).
 */
export function bindMediaSessionPlayPause(getControls: () => MediaSessionControls | null): () => void {
  const ms = typeof navigator === 'undefined' ? undefined : navigator.mediaSession
  if (!ms) return () => {}
  const bound: MediaSessionAction[] = []
  const intents: Array<{ action: MediaSessionAction; when: (playing: boolean) => boolean }> = [
    { action: 'pause', when: (playing) => playing },
    { action: 'play', when: (playing) => !playing },
  ]
  for (const { action, when } of intents) {
    try {
      ms.setActionHandler(action, () => {
        const controls = getControls()
        if (controls && when(controls.playing())) controls.toggle()
      })
      bound.push(action)
    } catch {
      // Unsupported action on this engine — its default behavior stays.
    }
  }
  return () => {
    for (const action of bound) {
      try {
        ms.setActionHandler(action, null)
      } catch {
        /* ignore */
      }
    }
  }
}

/**
 * Give desktop media controls a title to show (without one, some engines
 * never surface controls or route media keys at all). null clears it.
 * Best-effort: does nothing where MediaMetadata is unavailable.
 */
export function setMediaSessionTitle(title: string | null): void {
  const ms = typeof navigator === 'undefined' ? undefined : navigator.mediaSession
  if (!ms) return
  try {
    ms.metadata = title === null ? null : new MediaMetadata({ title })
  } catch {
    /* ignore */
  }
}
