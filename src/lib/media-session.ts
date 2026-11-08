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
// Inside the Flatpak that bridge never registers at all, and the Rust
// service stands in for the webview player too — its desktop play/pause
// requests arrive as an event routed through the same applyMediaAction
// (see page-mpris.ts).
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

/** Apply one media action through the surface's controls: a pause request
 * while paused must never resume, and vice versa — the same discipline the
 * action handlers below and the Rust MPRIS stand-in's play/pause event
 * both need. */
export function applyMediaAction(action: 'play' | 'pause', controls: MediaSessionControls | null): void {
  if (!controls) return
  if (action === 'pause' && controls.playing()) controls.toggle()
  if (action === 'play' && !controls.playing()) controls.toggle()
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
  for (const action of ['pause', 'play'] as const) {
    try {
      ms.setActionHandler(action, () => applyMediaAction(action, getControls()))
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
 * Give desktop media controls what they display: a title (without one,
 * some engines never surface controls or route media keys at all) and,
 * when known, cover art (the channel avatar). A null title with no
 * artwork clears the metadata. Best-effort: does nothing where
 * MediaMetadata is unavailable.
 */
export function setMediaSessionMetadata(title: string | null, artworkUrl?: string | null): void {
  const ms = typeof navigator === 'undefined' ? undefined : navigator.mediaSession
  if (!ms) return
  try {
    if (title === null && !artworkUrl) {
      ms.metadata = null
      return
    }
    const artwork = artworkUrl ? [{ src: artworkUrl, sizes: '70x70', type: imageTypeOf(artworkUrl) }] : []
    ms.metadata = new MediaMetadata({ title: title ?? '', artwork })
  } catch {
    /* ignore */
  }
}

/** Twitch avatars are png; stay honest about the odd webp/jpeg. */
function imageTypeOf(url: string): string {
  if (url.endsWith('.png')) return 'image/png'
  if (url.endsWith('.webp')) return 'image/webp'
  return 'image/jpeg'
}
