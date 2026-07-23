import { emit, listen } from '@tauri-apps/api/event'
import { isTauri } from '@tauri-apps/api/core'
import { WebviewWindow } from '@tauri-apps/api/webviewWindow'
import { settings } from './settings.svelte.ts'

// Picture-in-Picture for this app is implemented as a SECOND, borderless,
// always-on-top Tauri window (the native HTML5 `requestPictureInPicture` API
// returns `false` on WebKitGTK). The main window passes its already-resolved
// HLS playlist URL to the PiP window; the PiP window is the audio authority
// while open and the main video is force-muted (without persisting that mute).
//
// Everything is coordinated over Tauri global events:
//   main -> pip   ks://pip-init       { url, channel, quality, volume, muted, mediaKind? }
//   main -> pip   ks://pip-stream     { url, mediaKind? }    (channel/quality change)
//   main -> pip   ks://pip-do-close                        (main requests close)
//   pip  -> main  ks://pip-ready                           (pip listening, wants init)
//   pip  -> main  ks://pip-volume     { volume, muted }    (pip is audio authority)
//   pip  -> main  ks://pip-closed     { rect? }            (pip window closed)

const PIP_LABEL = 'pip'
const RECT_KEY = 'pip-window-rect-v1'

const EV_READY = 'ks://pip-ready'
const EV_INIT = 'ks://pip-init'
const EV_STREAM = 'ks://pip-stream'
const EV_VOLUME = 'ks://pip-volume'
const EV_CLOSED = 'ks://pip-closed'
const EV_DO_CLOSE = 'ks://pip-do-close'

interface PipRect {
  x: number
  y: number
  width: number
  height: number
}

interface StreamInfo {
  url: string
  channel: string
  quality: string
  mediaKind?: 'hls' | 'mp4'
}

function readRect(): PipRect | null {
  try {
    const raw = localStorage.getItem(RECT_KEY)
    if (!raw) return null
    const v = JSON.parse(raw) as Partial<PipRect>
    if (
      typeof v.x !== 'number' || typeof v.y !== 'number' ||
      typeof v.width !== 'number' || typeof v.height !== 'number'
    ) return null
    if (v.width < 160 || v.height < 90) return null
    return { x: v.x, y: v.y, width: v.width, height: v.height }
  } catch {
    return null
  }
}

function writeRect(rect: PipRect): void {
  try {
    localStorage.setItem(RECT_KEY, JSON.stringify(rect))
  } catch {
    /* ignore */
  }
}

class PipController {
  /** Reactive: true while the PiP window is open. */
  isOpen = $state(false)
  /**
   * Reactive: true while the controller is forcing the main `<video>` element
   * to be muted. PlayerControls reads this to skip persisting the forced mute.
   */
  overridingMainMute = $state(false)

  private videoEl: HTMLVideoElement | null = null
  private currentStream: StreamInfo | null = null
  private savedMainMuted = false
  private unlistenReady: (() => void) | null = null
  private unlistenVolume: (() => void) | null = null
  private unlistenClosed: (() => void) | null = null
  private closeFallbackTimer: ReturnType<typeof setTimeout> | null = null

  constructor() {
    if (!isTauri()) return
    void listen(EV_READY, () => { void this.sendInit() })
      .then((u) => { this.unlistenReady = u })
    void listen<{ volume: number; muted: boolean }>(EV_VOLUME, (e) => {
      const { volume, muted } = e.payload
      // PiP is the audio authority; its volume/mute ARE the persisted truth.
      settings.setVolume(volume)
      settings.setMuted(muted)
    }).then((u) => { this.unlistenVolume = u })
    void listen<{ rect?: PipRect }>(EV_CLOSED, (e) => {
      if (e.payload?.rect) writeRect(e.payload.rect)
      void this.onPipClosed()
    }).then((u) => { this.unlistenClosed = u })
  }

  /** App.svelte calls this (reactively) so the controller can mute/unmute it. */
  setVideoElement(el: HTMLVideoElement | null | undefined): void {
    this.videoEl = el ?? null
  }

  /** Called after a stream successfully attaches (and on quality change). */
  setStream(info: StreamInfo): void {
    this.currentStream = info
    if (!this.isOpen) return
    if (!isTauri()) return
    void emit(EV_STREAM, { url: info.url, mediaKind: info.mediaKind ?? 'hls' })
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
    const saved = readRect()
    const wv = new WebviewWindow(PIP_LABEL, {
      url,
      title: 'kappastream — PiP',
      width: saved?.width ?? 320,
      height: saved?.height ?? 180,
      minWidth: 200,
      minHeight: 113,
      resizable: true,
      decorations: false,
      alwaysOnTop: true,
      skipTaskbar: true,
      shadow: true,
      ...(saved ? { x: saved.x, y: saved.y } : {}),
    })
    wv.once('tauri://error', () => { void this.onPipClosed() })

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
      volume: settings.volume,
      muted: false,
    })
  }

  private async close(): Promise<void> {
    if (!isTauri()) return
    // Ask the PiP window to close itself. It emits ks://pip-closed (with its
    // last rect) on its way out, which drives onPipClosed().
    void emit(EV_DO_CLOSE)
    // Safety net: if the PiP window is unresponsive and never reports closed,
    // restore main audio so the user is not stuck muted.
    if (this.closeFallbackTimer) clearTimeout(this.closeFallbackTimer)
    this.closeFallbackTimer = setTimeout(() => {
      this.closeFallbackTimer = null
      if (this.isOpen) void this.onPipClosed()
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
