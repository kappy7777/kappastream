// VOD playback support extracted from App.svelte: the scrub-bar extras
// (chapters / muted segments / storyboard seek-previews), the resume
// machinery (position save/restore + the transient "Resumed from …" bar),
// and the shared time formatter. App.svelte owns the PLAYER lifecycle
// (resolve/attach/quality); this class owns everything that hangs off a VOD
// id + the <video> element's position.
//
// Every piece of extras data is OPTIONAL by design — a fetch failure leaves
// chapters/mutes/previews empty and the scrubber renders its baseline state.
//
// `position` is playlist-relative (the VOD runs through the ksvod proxy and
// currentTime is relative to that playlist). The same player writes and reads
// it, so it is self-consistent — but it does NOT match Twitch's broadcast
// offset. Clips are out of scope (too short). See vod-positions.svelte.ts for
// the bounded storage + thresholds.

import { parseStoryboard, type Storyboard } from './vod-extras'
import { fetchVideoExtras, type VodChapter, type VodMuteSpan } from './gql'
import { vodPositions } from './vod-positions.svelte.ts'

/** Transient bar shown after auto-resuming a VOD (null = no bar). */
export interface ResumeBar {
  vodId: string
  position: number
}

export function formatVodTime(s: number): string {
  if (!Number.isFinite(s) || s < 0) s = 0
  const total = Math.floor(s)
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const sec = total % 60
  const mm = h > 0 ? m.toString().padStart(2, '0') : String(m)
  return (h > 0 ? h + ':' : '') + mm + ':' + sec.toString().padStart(2, '0')
}

const VOD_SAVE_INTERVAL_MS = 5_000
const RESUME_BAR_TIMEOUT_MS = 8_000

export class VodPlaybackController {
  /** Chapter markers on the scrub bar (see vod-extras.ts). */
  chapters = $state<VodChapter[]>([])
  /** Muted-segment spans striped onto the scrub bar. */
  mutedSpans = $state<VodMuteSpan[]>([])
  /** Seek-hover storyboard thumbnails (null when the VOD has none / fetch failed). */
  storyboard = $state<Storyboard | null>(null)
  /** The transient resume bar; rendered by App when non-null. */
  resumeBar = $state<ResumeBar | null>(null)

  private extrasToken = 0
  private resumeBarTimer: ReturnType<typeof setTimeout> | null = null
  private lastSaveAt = 0

  constructor(private readonly opts: {
    /** Rewrites an https URL to the ksvod-proxy form for the current platform. */
    proxyUrl: (httpsUrl: string) => string
    /** The <video> element positions are saved from / restored to (may be
     *  briefly absent mid source-swap). */
    getVideo: () => HTMLVideoElement | undefined
  }) {}

  /** Reset the scrub-bar extras. Called on every playback-mode change. */
  clearExtras(): void {
    this.extrasToken++
    this.chapters = []
    this.mutedSpans = []
    this.storyboard = null
  }

  /**
   * Fetch chapters + muted segments (+ the storyboard JSON, through the ksvod
   * proxy — the VOD CDN sends no CORS; the strip IMAGES are plain
   * background-images straight from the CDN, CORS-exempt). A token guards
   * against a stale response landing after the playback mode changed.
   */
  async loadExtras(videoId: string): Promise<void> {
    const myToken = ++this.extrasToken
    let extras
    try {
      extras = await fetchVideoExtras(videoId)
    } catch {
      return // optional data — no chapters/mutes/previews is fine
    }
    if (myToken !== this.extrasToken) return
    this.chapters = extras.chapters
    this.mutedSpans = extras.mutedSpans
    this.storyboard = null
    const url = extras.seekPreviewsUrl
    if (!url) return
    try {
      const res = await fetch(this.opts.proxyUrl(url))
      if (!res.ok) return
      const sb = parseStoryboard(await res.json(), url)
      if (myToken !== this.extrasToken) return
      this.storyboard = sb
    } catch {
      /* storyboard is the most optional of the extras */
    }
  }

  /**
   * Throttled save of the current VOD position. Called from timeupdate
   * (every frame, throttled to VOD_SAVE_INTERVAL_MS) and force-flushed on
   * pause and on leaving the VOD. No-op when videoId is null (not in VOD
   * playback — the caller passes null for live/clip).
   */
  save(videoId: string | null, force = false): void {
    if (!videoId) return
    const el = this.opts.getVideo()
    if (!el) return
    const now = Date.now()
    if (!force && now - this.lastSaveAt < VOD_SAVE_INTERVAL_MS) return
    this.lastSaveAt = now
    vodPositions.save(videoId, el.currentTime, Number.isFinite(el.duration) ? el.duration : 0)
  }

  /**
   * Seek the just-loaded VOD to its saved position (if any) once the seekable
   * range covers it, and surface the "Resumed from … — Restart" bar. HLS VOD
   * playlists list every segment, so seekable usually covers the full duration
   * right after manifest parse; a short progress-listener poll is the safety
   * net for the rare case it does not.
   */
  restore(videoId: string): void {
    const saved = vodPositions.get(videoId)
    if (!saved || saved.position < 30) return
    const el = this.opts.getVideo()
    if (!el) return
    let tries = 0
    const attempt = (): boolean => {
      const seekable = el.seekable
      if (seekable.length === 0) return false
      if (saved.position > seekable.end(seekable.length - 1)) return false
      try { el.currentTime = saved.position } catch { /* ignore */ }
      return true
    }
    if (attempt()) {
      this.showResumeBar(videoId, saved.position)
      return
    }
    const onProgress = (): void => {
      if (attempt()) {
        el.removeEventListener('progress', onProgress)
        this.showResumeBar(videoId, saved.position)
      } else if (++tries > 200) {
        el.removeEventListener('progress', onProgress)
      }
    }
    el.addEventListener('progress', onProgress)
  }

  /** Restart the VOD from 0: seek, play, forget the saved position, drop the bar. */
  restart(videoId: string | null): void {
    const el = this.opts.getVideo()
    if (el) {
      try { el.currentTime = 0 } catch { /* ignore */ }
      void el.play().catch(() => { /* ignore */ })
    }
    if (videoId) vodPositions.clear(videoId)
    this.dismissResumeBar()
  }

  showResumeBar(vodId: string, position: number): void {
    this.resumeBar = { vodId, position }
    if (this.resumeBarTimer) clearTimeout(this.resumeBarTimer)
    this.resumeBarTimer = setTimeout(() => {
      this.resumeBar = null
      this.resumeBarTimer = null
    }, RESUME_BAR_TIMEOUT_MS)
  }

  dismissResumeBar(): void {
    if (this.resumeBarTimer) {
      clearTimeout(this.resumeBarTimer)
      this.resumeBarTimer = null
    }
    this.resumeBar = null
  }

  /** Drop pending timers (App unmount). */
  dispose(): void {
    this.dismissResumeBar()
    this.extrasToken++
  }
}
