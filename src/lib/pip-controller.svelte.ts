import { emit, listen } from '@tauri-apps/api/event'
import { isTauri } from '@tauri-apps/api/core'
import { WebviewWindow } from '@tauri-apps/api/webviewWindow'
import { currentMonitor } from '@tauri-apps/api/window'
import { settings } from './settings.svelte.ts'
import { STORAGE_KEYS } from './storage-keys'
import { clampRectToMonitor, readSavedPipRect, writeSavedPipRect } from './pip-rect'

// Picture-in-Picture for this app is implemented as a SECOND, borderless,
// always-on-top Tauri window (the native HTML5 `requestPictureInPicture` API
// returns `false` on WebKitGTK). The main window passes its already-resolved
// HLS playlist URL to the PiP window; the PiP window is the audio authority
// while open and the main video is force-muted (without persisting that mute).
//
// Everything is coordinated over Tauri global events:
//   main -> pip   ks://pip-init       { url, channel, quality, volume, muted, mediaKind?, isLive?, lowLatency?, startAt?, qualities? }
//   main -> pip   ks://pip-stream     { url, mediaKind?, isLive?, lowLatency?, startAt? }    (channel/quality change)
//   main -> pip   ks://pip-qualities  { quality, qualities }   (menu refresh: probe answered / selection changed)
//   main -> pip   ks://pip-do-close                        (main requests close)
//   pip  -> main  ks://pip-ready                           (pip listening, wants init)
//   pip  -> main  ks://pip-volume     { volume, muted }    (pip is audio authority)
//   pip  -> main  ks://pip-quality     { quality, position? }  (pip wants a quality switch)
//   pip  -> main  ks://pip-closed     { position?, duration?, isLive? }  (pip window closed)
//
// `isLive` (absent = false) gates the PiP stall recovery: a live edge snap
// must never force-seek a paused VOD (its seekable end is the END of the
// video). The main window derives it from its playback kind at every
// setStream call site. `startAt` / the closed position report are the VOD
// resume handoff: PiP continues where the main player was, and the main
// player resumes where PiP left off.
//
// The PiP window persists its own rect: PipWindow writes the shared
// localStorage key (same origin) on every settled resize/move while the
// window is alive. Nothing saves the rect at close time — a close-time
// query of a tearing-down window is exactly the kind of thing that fails
// silently and leaves a stale size saved forever.

const PIP_LABEL = 'pip'

const EV_READY = 'ks://pip-ready'
const EV_INIT = 'ks://pip-init'
const EV_STREAM = 'ks://pip-stream'
const EV_VOLUME = 'ks://pip-volume'
const EV_CLOSED = 'ks://pip-closed'
const EV_DO_CLOSE = 'ks://pip-do-close'
const EV_QUALITIES = 'ks://pip-qualities'
const EV_QUALITY_REQ = 'ks://pip-quality'

interface StreamInfo {
  url: string
  channel: string
  quality: string
  mediaKind?: 'hls' | 'mp4'
  /** Whether the URL is a LIVE stream (gates PiP stall recovery). Absent = false. */
  isLive?: boolean
  /** The low-latency setting this URL was resolved under. Rides BOTH payloads
   *  so the floating window's hls.js config always matches the playlist: the
   *  PiP webview keeps its OWN settings-store instance (booted once at window
   *  creation), which goes stale when the user toggles the setting while PiP
   *  is open — the exact playlist/config mismatch hls-config.ts warns about.
   *  Absent = false (VODs and clips are never low-latency). */
  lowLatency?: boolean
  /** VOD position (seconds) the floating window should start at — the resume
   * half of the PiP position handoff. Absent or <= 0.5 = play from the
   * start; live streams never carry one. */
  startAt?: number
  /** The VOD's numeric id — lets the floating window fetch its own scrub-bar
   * extras (chapters, muted segments, storyboard previews). Live streams and
   * clips never carry one. */
  vodId?: string
}

/** The startAt payload field only when it carries a real position — payloads
 *  (and the tests pinning their exact shape) stay identical when no resume
 *  applies, and a live stream can never grow one. */
function startAtProp(info: StreamInfo): { startAt?: number } {
  return info.isLive === true ||
    typeof info.startAt !== 'number' ||
    !Number.isFinite(info.startAt) ||
    info.startAt <= 0.5
    ? {}
    : { startAt: info.startAt }
}

class PipController {
  /** Reactive: true while the PiP window is open. */
  isOpen = $state(false)
  /**
   * Reactive: true while the controller is forcing the main `<video>` element
   * to be muted. PlayerControls reads this to skip persisting the forced mute.
   */
  overridingMainMute = $state(false)
  /**
   * The floating window's last reported media position on close — the
   * main-player resume half of the VOD handoff, set from ks://pip-closed
   * right before isOpen flips false. Null when the window played live (or
   * reported nothing): there is no meaningful position to resume to. App
   * consumes it when restoring the stopped main player.
   */
  closedMedia: { position: number; duration: number } | null = null
  /**
   * The floating window's quality-menu request (ks://pip-quality). App wires
   * this: only the main window knows the platform proxy routing, the
   * per-channel quality preference, and the unavailable→best fallback
   * ladder, so the floating window asks instead of resolving itself.
   * `position` is the floating window's VOD playhead (absent for live) so
   * the re-resolved stream continues where it is.
   */
  onQualityRequest: ((quality: string, position: number | undefined) => void) | null = null

  private videoEl: HTMLVideoElement | null = null
  private currentStream: StreamInfo | null = null
  /** The last quality menu App pushed (the probed variant list + the current
   *  selection). Cached so the init handshake can serve it without a fresh
   *  push — the probe is async and often answers AFTER the window opens. */
  private qualityMenu: { qualities: string[]; quality: string } | null = null
  private savedMainMuted = false
  private unlistenReady: (() => void) | null = null
  private unlistenVolume: (() => void) | null = null
  private unlistenQualityReq: (() => void) | null = null
  private unlistenClosed: (() => void) | null = null
  private closeFallbackTimer: ReturnType<typeof setTimeout> | null = null

  constructor() {
    if (!isTauri()) return
    void listen(EV_READY, () => {
      void this.sendInit()
    }).then((u) => {
      this.unlistenReady = u
    })
    void listen<{ volume: number; muted: boolean }>(EV_VOLUME, (e) => {
      const { volume, muted } = e.payload
      // PiP is the audio authority; its volume/mute ARE the persisted truth.
      settings.setVolume(volume)
      settings.setMuted(muted)
    }).then((u) => {
      this.unlistenVolume = u
    })
    void listen<{ quality?: unknown; position?: unknown }>(EV_QUALITY_REQ, (e) => {
      const p = e.payload
      if (!p || typeof p.quality !== 'string' || !p.quality) return
      const pos = typeof p.position === 'number' && Number.isFinite(p.position) ? p.position : undefined
      this.onQualityRequest?.(p.quality, pos)
    }).then((u) => {
      this.unlistenQualityReq = u
    })
    void listen<{ position?: number; duration?: number; isLive?: boolean }>(EV_CLOSED, (e) => {
      const p = e.payload
      this.closedMedia =
        p && typeof p.position === 'number' && Number.isFinite(p.position) && p.isLive !== true
          ? {
              position: p.position,
              duration: typeof p.duration === 'number' && Number.isFinite(p.duration) ? p.duration : 0,
            }
          : null
      void this.onPipClosed()
    }).then((u) => {
      this.unlistenClosed = u
    })
  }

  /** App.svelte calls this (reactively) so the controller can mute/unmute it. */
  setVideoElement(el: HTMLVideoElement | null | undefined): void {
    this.videoEl = el ?? null
  }

  /** Cache + push the quality menu to the floating window (App feeds this
   *  from the same probed variant list its own gear menu uses — the floating
   *  window has NO probe of its own, so a second streamlink spawn per open
   *  is avoided). The push is also the late-probe refresh: the list starts
   *  as the full vocabulary and sharpens when the probe answers, sometimes
   *  after the window opened. Cached so the NEXT sendInit serves the
   *  current menu without a fresh push. */
  pushQualityMenu(qualities: readonly string[], quality: string): void {
    this.qualityMenu = { qualities: [...qualities], quality }
    if (!this.isOpen || !isTauri()) return
    void emit(EV_QUALITIES, this.qualityMenu)
  }

  /** Called after a stream successfully attaches (and on quality change). */
  setStream(info: StreamInfo): void {
    this.currentStream = info
    if (!this.isOpen) return
    if (!isTauri()) return
    void emit(EV_STREAM, {
      url: info.url,
      mediaKind: info.mediaKind ?? 'hls',
      isLive: info.isLive === true,
      lowLatency: info.lowLatency === true,
      ...startAtProp(info),
      ...(info.vodId ? { vodId: info.vodId } : {}),
    })
  }

  /** Refresh the resume position on the stored stream as PiP takes over a
   *  VOD/clip mid-playback: the floating window must continue at the WATCHED
   *  position, not the attach-time one the loader primed. No event — the
   *  window is still booting and reads this through the init handshake. */
  updatePosition(startAt: number): void {
    if (!this.currentStream || this.currentStream.isLive === true) return
    this.currentStream = { ...this.currentStream, startAt }
  }

  /** Called when the stream tears down (channel change, stop). Closes PiP. */
  clearStream(): void {
    this.currentStream = null
    if (this.isOpen) void this.close()
  }

  async toggle(): Promise<void> {
    if (this.isOpen) {
      await this.close()
      return
    }
    await this.open()
  }

  private async open(): Promise<void> {
    if (!isTauri() || this.isOpen) return
    if (!this.currentStream) return // nothing to play yet

    // Force the main video muted BEFORE flipping the guard so the resulting
    // `volumechange` event does not persist a mute we'll undo on close.
    this.savedMainMuted = this.videoEl?.muted ?? false
    this.overridingMainMute = true
    if (this.videoEl) this.videoEl.muted = true

    const url = window.location.href.split('#')[0] + '#pip'
    // The stored rect is in RAW PHYSICAL pixels (the floating window relays
    // resize-event values verbatim — see PipWindow). Clamp it HERE, in the
    // main window, whose monitor query is the trustworthy one (in the PiP
    // window currentMonitor() fails on some compositors, e.g. KDE Wayland),
    // and write the clamped value back so the floating window's own restore
    // reads a healed rect. The constructor takes LOGICAL pixels, so the
    // clamped physical size is divided by the monitor's scale factor — the
    // constructor size is only a pre-map starting point; the floating window
    // re-asserts the stored physical size after mapping.
    const saved = readSavedPipRect(STORAGE_KEYS.pipWindowRect)
    let ctorSize: { width: number; height: number; x: number; y: number } | null = null
    if (saved) {
      try {
        const mon = await currentMonitor()
        if (mon) {
          const clamped = clampRectToMonitor(saved, mon.size.width, mon.size.height)
          const sf = mon.scaleFactor > 0 ? mon.scaleFactor : 1
          ctorSize = {
            width: Math.max(1, Math.round(clamped.width / sf)),
            height: Math.max(1, Math.round(clamped.height / sf)),
            x: Math.round(clamped.x / sf),
            y: Math.round(clamped.y / sf),
          }
          writeSavedPipRect(STORAGE_KEYS.pipWindowRect, clamped)
        }
      } catch {
        /* ignore — no monitor answer; the floating window restores the
           stored physical size itself, unclamped this once */
      }
    }
    const wv = new WebviewWindow(PIP_LABEL, {
      url,
      title: 'kappastream — PiP',
      width: ctorSize?.width ?? 320,
      height: ctorSize?.height ?? 180,
      minWidth: 200,
      minHeight: 113,
      resizable: true,
      decorations: false,
      alwaysOnTop: true,
      skipTaskbar: true,
      shadow: true,
      ...(ctorSize ? { x: ctorSize.x, y: ctorSize.y } : {}),
    })
    void wv.once('tauri://error', () => {
      void this.onPipClosed()
    })

    // Flip optimistically so the button reflects state immediately. Corrected
    // (to false) by onPipClosed if creation failed.
    this.isOpen = true
  }

  private async sendInit(): Promise<void> {
    if (!isTauri() || !this.currentStream) return
    await emit(EV_INIT, {
      url: this.currentStream.url,
      channel: this.currentStream.channel,
      quality: this.currentStream.quality,
      mediaKind: this.currentStream.mediaKind ?? 'hls',
      isLive: this.currentStream.isLive === true,
      lowLatency: this.currentStream.lowLatency === true,
      ...startAtProp(this.currentStream),
      ...(this.currentStream.vodId ? { vodId: this.currentStream.vodId } : {}),
      // The cached quality menu (pushed by App's probe feed) — the floating
      // window's menu seed; late probe answers refresh it via ks://pip-qualities.
      ...(this.qualityMenu ? { qualities: this.qualityMenu.qualities } : {}),
      volume: settings.volume,
      // The floating window CONTINUES the main player's audio state — it
      // does not reset it. Starting from the persisted mute (not a hardcoded
      // unmute) keeps a muted session muted instead of blasting sound the
      // user had explicitly turned off.
      muted: settings.muted === true,
    })
  }

  private async close(): Promise<void> {
    if (!isTauri()) return
    // Ask the PiP window to close itself. It emits ks://pip-closed on its way
    // out, which drives onPipClosed().
    void emit(EV_DO_CLOSE)
    // Safety net: if the PiP window is unresponsive and never reports closed,
    // destroy it outright and restore main audio. Without the destroy a hung
    // window would float on forever — always-on-top, undecorated,
    // skip-taskbar, unreachable — and the NEXT open would fail on the
    // duplicate label.
    if (this.closeFallbackTimer) clearTimeout(this.closeFallbackTimer)
    this.closeFallbackTimer = setTimeout(() => {
      this.closeFallbackTimer = null
      if (!this.isOpen) return
      void (async () => {
        // getByLabel is async in the Tauri v2 API; a failed destroy (the
        // window already dying on its own) must still close the controller.
        const orphan = await WebviewWindow.getByLabel(PIP_LABEL)
        if (orphan) void orphan.destroy().catch(() => {})
        void this.onPipClosed()
      })()
    }, 1500)
  }

  private async onPipClosed(): Promise<void> {
    if (this.closeFallbackTimer) {
      clearTimeout(this.closeFallbackTimer)
      this.closeFallbackTimer = null
    }
    if (!this.isOpen && !this.overridingMainMute) return
    this.isOpen = false
    // Resync the main video to the persisted truth (PiP may have changed it).
    this.overridingMainMute = false
    if (this.videoEl) {
      this.videoEl.muted = settings.muted
      this.videoEl.volume = settings.volume
    }
  }
}

export const pipController = new PipController()
