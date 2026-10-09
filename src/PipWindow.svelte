<script lang="ts">
  import { onMount, onDestroy } from 'svelte'
  import Hls from 'hls.js'
  import { emit, listen } from '@tauri-apps/api/event'
  import { isTauri } from '@tauri-apps/api/core'
  import { getCurrentWindow } from '@tauri-apps/api/window'
  import { PhysicalSize } from '@tauri-apps/api/dpi'
  import { shouldRecoverStallAfterPause, toKsvodProxyUrl } from './lib/playback'
  import { bindMediaSessionPlayPause } from './lib/media-session'
  import { PlaybackSession } from './lib/playback-session.svelte'
  import { readSavedPipRect, writeSavedPipRect, type PipRectShape } from './lib/pip-rect'
  import { STORAGE_KEYS } from './lib/storage-keys'
  import { fetchVideoExtras, type VodChapter, type VodMuteSpan } from './lib/gql'
  import { chapterAt, parseStoryboard, storyboardThumbAt, type Storyboard } from './lib/vod-extras'
  import { qualityLabel } from './lib/qualities'
  import { t } from './lib/i18n/index.svelte'

  // Minimal PiP window: a single <video> fed by hls.js from the URL the main
  // window hands us. This window is the audio authority while open; the main
  // window is force-muted. See src/lib/pip-controller.svelte.ts for the
  // full event protocol and the main-window side of this.

  const EV_READY = 'ks://pip-ready'
  const EV_INIT = 'ks://pip-init'
  const EV_STREAM = 'ks://pip-stream'
  const EV_VOLUME = 'ks://pip-volume'
  const EV_CLOSED = 'ks://pip-closed'
  const EV_DO_CLOSE = 'ks://pip-do-close'
  const EV_QUALITIES = 'ks://pip-qualities'
  const EV_QUALITY_REQ = 'ks://pip-quality'

  interface InitPayload {
    url: string
    volume: number
    muted: boolean
    quality?: string
    qualities?: string[]
    mediaKind?: 'hls' | 'mp4'
    isLive?: boolean
    lowLatency?: boolean
    startAt?: number
    vodId?: string
  }
  interface StreamPayload {
    url: string
    mediaKind?: 'hls' | 'mp4'
    isLive?: boolean
    lowLatency?: boolean
    startAt?: number
    vodId?: string
  }

  let videoEl: HTMLVideoElement | undefined = $state()
  // VOD resume handoff: where this window should start (set per loadSource),
  // and where it actually got to (reported to main on close).
  let pendingStart: number | null = null
  let lastPosition = 0
  let lastDuration = 0
  // The playback engine (hls.js attach / manifest timeout / stall recovery /
  // teardown) — the same PlaybackSession the main player and every multi-view
  // tile run on. PiP keeps only its own policy: gesture handling, aspect-lock
  // snapping, the volume hand-off.
  const playback = new PlaybackSession()
  // Whether the CURRENT source is a live stream (gates stall recovery — an
  // absent flag means not live; VODs and clips must never be force-seeked —
  // and hides the seek bar, which only VODs and clips show).
  let isLive = $state(false)
  let muted = $state(false)
  let volume = $state(1)
  let paused = $state(true)
  let loading = $state(true)
  let errorMsg = $state('')
  let endedLive = $state(false)
  let needsGesture = $state(false)
  let controlsVisible = $state(true)
  let hideTimer: ReturnType<typeof setTimeout> | null = null
  const unlisteners: Array<() => void> = []
  // Aspect-lock (16:9) snap state. Wayland compositors drive the resize drag
  // themselves, so the window can't be locked mid-drag; instead we snap to
  // exact 16:9 shortly after the drag settles (and on first open). The
  // `suppressSnapUntil` window ignores the resize our own setSize produces so
  // we don't feedback-loop.
  let snapTimer: ReturnType<typeof setTimeout> | null = null
  let suppressSnapUntil = 0

  // Window-rect persistence: the last settled geometry is written to the
  // shared localStorage key on every resize/move WHILE THE WINDOW IS ALIVE
  // (saving at close time proved fragile — a failed query against a
  // tearing-down window left a stale size restored forever). All values are
  // RAW PHYSICAL pixels, relayed verbatim: resize events and
  // setSize(PhysicalSize) provably speak the same units on every compositor
  // tested (including KDE at 200%, where the window's scaleFactor() query
  // returns 1 while events are physical — dividing by it doubled the window
  // every cycle). No conversion, no query, nothing to disagree.
  let rectSaveTimer: ReturnType<typeof setTimeout> | null = null
  let liveRect: PipRectShape = readSavedPipRect(STORAGE_KEYS.pipWindowRect) ?? {
    x: 0,
    y: 0,
    width: 320,
    height: 180,
  }

  function scheduleRectSave(): void {
    if (rectSaveTimer) clearTimeout(rectSaveTimer)
    rectSaveTimer = setTimeout(() => {
      rectSaveTimer = null
      writeSavedPipRect(STORAGE_KEYS.pipWindowRect, liveRect)
    }, 400)
  }

  /** Write a pending save at once (close/teardown paths must not lose the
   *  last resize to the debounce). */
  function flushRectSave(): void {
    if (!rectSaveTimer) return
    clearTimeout(rectSaveTimer)
    rectSaveTimer = null
    writeSavedPipRect(STORAGE_KEYS.pipWindowRect, liveRect)
  }

  function onRectResized(width: number, height: number): void {
    liveRect = {
      ...liveRect,
      width: Math.max(1, Math.round(width)),
      height: Math.max(1, Math.round(height)),
    }
    scheduleRectSave()
  }

  function onRectMoved(x: number, y: number): void {
    liveRect = { ...liveRect, x: Math.round(x), y: Math.round(y) }
    scheduleRectSave()
  }

  // Seek bar — VODs and clips only, mirroring the main player (a live stream
  // shows no scrubber; the live edge is all there is to see). Spans
  // 0..duration once known; live playback leaves the bounds at zero, which
  // also neuters the arrow-key seek below.
  let seekHead = $state(0)
  let seekMin = $state(0)
  let seekMax = $state(0)
  let seekBuffered = $state(0)
  let hoverTime: number | null = $state(null)

  // VOD scrub-bar extras — the same chapters, muted-segment stripes, and
  // storyboard hover previews the main player's scrubber shows, fetched here
  // for the VOD the window is holding (vodId rides the init/stream payloads).
  // All immutable per VOD: a self-contained fetch can never go stale or land
  // on the wrong VOD the way forwarded copies could. Live and clips carry no
  // vodId and render the baseline bar.
  let chapters = $state<VodChapter[]>([])
  let mutedSpans = $state<VodMuteSpan[]>([])
  let storyboard = $state<Storyboard | null>(null)

  // Quality menu — the same semantics as the main player's gear menu: the
  // list rides ks://pip-init (from the controller's cache) and refreshes via
  // ks://pip-qualities when the main window's variant probe answers late.
  // An EMPTY list (clips — quality is fixed) hides the button entirely,
  // mirroring how the native OSD gear treats clips. Switching is a REQUEST
  // (ks://pip-quality): the main window owns the re-resolve (platform proxy
  // routing, the unavailable→best fallback ladder, the per-channel quality
  // preference) and the result comes back as a normal ks://pip-stream reload.
  let pipQuality = $state('')
  let pipQualities = $state<string[]>([])
  let qualityMenuOpen = $state(false)

  function applyQualityMenu(quality: unknown, qualities: unknown): void {
    pipQuality = typeof quality === 'string' ? quality : ''
    pipQualities = Array.isArray(qualities) ? qualities.filter((q): q is string => typeof q === 'string') : []
    if (pipQualities.length === 0) qualityMenuOpen = false
  }

  function toggleQualityMenu(): void {
    qualityMenuOpen = !qualityMenuOpen
  }

  function selectQuality(q: string): void {
    qualityMenuOpen = false
    if (q === pipQuality || !isTauri()) return
    // The VOD playhead rides along so the re-resolved stream continues where
    // this window is; live streams carry no position.
    const pos = !isLive && videoEl && Number.isFinite(videoEl.currentTime) ? videoEl.currentTime : undefined
    void emit(EV_QUALITY_REQ, pos === undefined ? { quality: q } : { quality: q, position: pos })
  }

  // `lowLatency` always arrives in the payload (init + stream): this window
  // keeps its OWN settings-store instance, booted once at creation, so a
  // toggle in the main window while PiP is open would leave a stale read
  // here — and an hls.js config that disagrees with the playlist is the
  // micro-stutter mode hls-config.ts exists to prevent. VODs and clips never
  // carry it (absent = false, matching their non-low-latency config).
  function loadSource(
    url: string,
    mediaKind: 'hls' | 'mp4' = 'hls',
    live?: boolean,
    startAt?: number,
    lowLatency?: boolean,
    vodId?: string,
  ): void {
    if (!videoEl) return
    isLive = live === true
    pendingStart = typeof startAt === 'number' && Number.isFinite(startAt) && startAt > 0.5 ? startAt : null
    lastPosition = 0
    lastDuration = 0
    chapters = []
    mutedSpans = []
    storyboard = null
    // Tear down the PREVIOUS engine before anything else: the mp4 branch
    // assigns videoEl.src directly, and an hls.js instance left attached to
    // the element keeps its whole pipeline alive (segment fetches, timers,
    // the MediaSource) against the swapped source. teardown bumps the
    // generation itself — running it BEFORE nextGeneration() keeps the new
    // load's token the authoritative one.
    playback.teardown(videoEl)
    loading = true
    errorMsg = ''
    endedLive = false
    needsGesture = false
    // Seek bar: stale bounds from the previous source must not flash (or
    // arm a seek against a half-loaded seekable window).
    seekHead = 0
    seekMin = 0
    seekMax = 0
    seekBuffered = 0
    hoverTime = null
    // Real staleness guard: the main window drives PiP asynchronously
    // (quality change, channel change, VOD open, back-to-live all re-fire
    // here), so a superseded attach must never win its race. Same
    // generation discipline as App and Tile.
    const gen = playback.nextGeneration()
    playback.clearStallRecover()
    // A new source implies the user wants playback; clear stale pause-intent.
    playback.userPaused = false
    if (typeof vodId === 'string' && vodId && live !== true) {
      void loadVodExtras(vodId, gen, url)
    }

    // The mp4 branch stays hand-written: it is pure policy (gesture
    // handling, no error overlay), and a paused clip must never be touched
    // by the live stall recovery.
    if (mediaKind === 'mp4') {
      videoEl.src = url
      videoEl
        .play()
        .then(() => {
          loading = false
        })
        .catch(() => {
          needsGesture = true
          loading = false
        })
      return
    }

    if (Hls.isSupported()) {
      void playback
        .attachHls({
          video: videoEl,
          url,
          lowLatency: lowLatency === true,
          isCurrent: () => gen === playback.generation,
          onManifestParsed: () => {
            loading = false
          },
          onPlayBlocked: () => {
            needsGesture = true
          },
          // A stream that dies mid-playback (the playlist 404s once the
          // broadcast ends, a network drop) surfaces like a load failure —
          // PiP shows no raw error strings, same as the branch below.
          onFatalAfterStart: () => {
            errorMsg = t('pip_streamError')
            loading = false
          },
        })
        .then((r) => {
          if (gen !== playback.generation) return // superseded by a newer loadSource
          if (!r.ok) {
            errorMsg = t('pip_streamError')
            loading = false
          }
        })
      return
    }
    if (videoEl.canPlayType('application/vnd.apple.mpegurl')) {
      void playback.attachNative(videoEl, url, {}).then((r) => {
        if (gen !== playback.generation) return
        loading = false
        if (!r.ok) needsGesture = true
      })
      return
    }
    errorMsg = t('pip_hlsNotSupported')
    loading = false
  }

  // Seek to the handed-off resume position once the seekable range covers
  // it. Called from loadedmetadata and then from every append (progress)
  // until it lands — an hls.js VOD's seekable window grows with the first
  // fragments, so the metadata pass alone can be too early.
  function applyPendingStart(): void {
    if (pendingStart == null || isLive || !videoEl) return
    const seekable = videoEl.seekable
    if (seekable.length === 0 || pendingStart > seekable.end(seekable.length - 1)) return
    const target = pendingStart
    pendingStart = null
    try {
      videoEl.currentTime = target
    } catch {
      /* ignore — stay at the start rather than fight the element */
    }
  }

  function emitVolume(): void {
    if (isTauri()) void emit(EV_VOLUME, { volume, muted })
  }

  function applyVolume(v: number): void {
    volume = Math.max(0, Math.min(1, v))
    if (videoEl) videoEl.volume = volume
    if (volume > 0 && muted) applyMuted(false)
    emitVolume()
  }
  function applyMuted(m: boolean): void {
    muted = m
    if (videoEl) videoEl.muted = m
    emitVolume()
  }
  function toggleMuted(): void {
    applyMuted(!muted)
  }

  function togglePlay(): void {
    if (!videoEl) return
    if (videoEl.paused) {
      playback.userPaused = false
      void videoEl.play()
    } else {
      // Flag the user pause BEFORE pausing (mirrors App) so onPipPause can
      // tell a deliberate pause from a webkit2gtk stall-induced one.
      playback.userPaused = true
      videoEl.pause()
    }
  }

  // Media keys pause this window's stream through the same discipline (the
  // PiP webview is its own document with its own Media Session). Without the
  // handler a hardware pause looks like a stall and recovery force-resumes it.
  onMount(() =>
    bindMediaSessionPlayPause(() => {
      const el = videoEl
      return el ? { playing: () => !el.paused, toggle: togglePlay } : null
    }),
  )

  async function gesturePlay(): Promise<void> {
    if (!videoEl) return
    qualityMenuOpen = false
    needsGesture = false
    // Explicit play intent (also cleared by the onplaying handler).
    playback.userPaused = false
    try {
      await videoEl.play()
    } catch {
      needsGesture = true
    }
  }

  // ---- live stall recovery (mirrors App.svelte; live-only) ----
  // webkit2gtk PAUSES on a low-latency underrun instead of just buffering,
  // and never self-resumes — so both `waiting` and a non-user `pause` arm
  // the recovery, which snaps to the live edge after ~1s. Gated on isLive:
  // a paused VOD/clip must never be force-seeked (its seekable end is the
  // END of the video).
  function onVideoWaiting(): void {
    // A blocked recovery resume must surface as the tap-for-sound prompt —
    // PiP has no control-bar fallback, and a silently dead window is the
    // one failure mode this surface cannot afford.
    if (isLive && videoEl)
      playback.scheduleStallRecover(videoEl, {
        onPlayBlocked: () => {
          needsGesture = true
        },
      })
  }

  function onVideoPlaying(): void {
    playback.clearStallRecover()
    playback.userPaused = false
  }

  function onPipPause(): void {
    if (shouldRecoverStallAfterPause(isLive, playback.userPaused) && videoEl) {
      playback.scheduleStallRecover(videoEl, {
        onPlayBlocked: () => {
          needsGesture = true
        },
      })
    }
  }

  // ---- seek bar ----

  /** Chapters + muted segments + storyboard previews for the held VOD —
   *  the main player's VodPlaybackController.loadExtras, self-contained so
   *  nothing has to be streamed across after the fact. The generation guard
   *  mirrors the load token: a slow response for a superseded source is
   *  dropped, not applied to whatever replaced it. */
  async function loadVodExtras(vodId: string, gen: number, mediaUrl: string): Promise<void> {
    // The storyboard JSON rides the ksvod proxy (the VOD CDN sends no CORS);
    // the strip IMAGES are plain background-images straight from the CDN,
    // CORS-exempt. The proxy form is derived from the media URL this window
    // received, which the main window already rewrote for this platform.
    const windowsForm = mediaUrl.startsWith('http://ksvod.localhost/')
    let extras
    try {
      extras = await fetchVideoExtras(vodId)
    } catch {
      return // optional data — no chapters/mutes/previews is fine
    }
    if (gen !== playback.generation) return
    chapters = extras.chapters
    mutedSpans = extras.mutedSpans
    storyboard = null
    const url = extras.seekPreviewsUrl
    if (!url) return
    try {
      const res = await fetch(toKsvodProxyUrl(url, windowsForm))
      if (!res.ok) return
      const sb = parseStoryboard(await res.json(), url)
      if (gen !== playback.generation) return
      storyboard = sb
    } catch {
      /* storyboard is the most optional of the extras */
    }
  }

  /** Refresh the scrub bar's bounds and playhead from the element (VODs and
   *  clips only — live keeps the zero bounds that hide the bar). */
  function syncSeekBounds(): void {
    if (!videoEl || isLive) return
    const b = videoEl.buffered
    if (b.length > 0 && Number.isFinite(b.end(b.length - 1))) seekBuffered = b.end(b.length - 1)
    const d = videoEl.duration
    if (Number.isFinite(d) && d > 1) {
      seekMin = 0
      seekMax = d
      if (Number.isFinite(videoEl.currentTime)) seekHead = videoEl.currentTime
    }
  }

  function applyScrub(raw: number): void {
    if (!videoEl) return
    const pos = Math.min(Math.max(raw, seekMin), seekMax)
    try {
      videoEl.currentTime = pos
    } catch {
      /* ignore — an unseekable element keeps playing where it was */
    }
  }

  function nudgeSeek(delta: number): void {
    if (seekMax - seekMin < 2) return
    applyScrub(seekHead + delta)
  }

  // Percent geometry for the scrub bar. All decorations (ticks, stripes,
  // hover bubble) are pointer-events:none so pointer math always sees the
  // bar itself, exactly like the main player's scrubber.
  function seekPct(at: number): number {
    const span = seekMax - seekMin
    if (!(span > 0)) return 0
    return Math.max(0, Math.min(100, ((at - seekMin) / span) * 100))
  }

  function timeAtPct(pct: number): number {
    return seekMin + Math.max(0, Math.min(1, pct)) * (seekMax - seekMin)
  }

  function onScrubClick(e: MouseEvent): void {
    const el = e.currentTarget as HTMLElement
    applyScrub(timeAtPct(e.offsetX / el.offsetWidth))
  }

  function onScrubMove(e: MouseEvent): void {
    const el = e.currentTarget as HTMLElement
    hoverTime = timeAtPct(e.offsetX / el.offsetWidth)
  }

  function onScrubLeave(): void {
    hoverTime = null
  }

  function onScrubKey(e: KeyboardEvent): void {
    if (seekMax - seekMin <= 0) return
    const step = e.shiftKey ? 30 : 5
    if (e.key === 'ArrowLeft') {
      e.preventDefault()
      e.stopPropagation() // the window-level arrow handler must not double it
      applyScrub(seekHead - step)
    } else if (e.key === 'ArrowRight') {
      e.preventDefault()
      e.stopPropagation()
      applyScrub(seekHead + step)
    } else if (e.key === 'Home') {
      e.preventDefault()
      e.stopPropagation()
      applyScrub(seekMin)
    } else if (e.key === 'End') {
      e.preventDefault()
      e.stopPropagation()
      applyScrub(seekMax)
    }
  }

  function formatTime(s: number): string {
    if (!isFinite(s) || s < 0) return '0:00'
    const h = Math.floor(s / 3600)
    const m = Math.floor((s % 3600) / 60)
    const sec = Math.floor(s % 60)
    if (h > 0) return h + ':' + m.toString().padStart(2, '0') + ':' + sec.toString().padStart(2, '0')
    return m + ':' + sec.toString().padStart(2, '0')
  }

  const hoverThumb = $derived(hoverTime !== null && storyboard ? storyboardThumbAt(storyboard, hoverTime) : null)
  const hoverChapterLabel = $derived(hoverTime !== null ? (chapterAt(chapters, hoverTime)?.label ?? '') : '')

  function mutedSpanStyle(span: VodMuteSpan): string {
    const left = seekPct(span.startSec)
    const width = Math.max(0, seekPct(Math.min(span.endSec, seekMax)) - left)
    return `left: ${left}%; width: ${width}%`
  }

  function onVideoEnded(): void {
    // A live source that runs to its end means the broadcast ended; VODs and
    // clips end naturally and keep their last frame (the main window owns
    // navigation either way). The 'pause' just before 'ended' armed the
    // stall recovery — cancel it, or a second later it would seek the ended
    // element back into its tail and replay it.
    if (!isLive) return
    playback.clearStallRecover()
    endedLive = true
    loading = false
  }

  async function emitClosed(): Promise<void> {
    if (!isTauri()) return
    // No window-geometry queries here: the rect is persisted on resize/move
    // while the window is alive (see onRectResized), never at close — a
    // query racing teardown fails silently and used to leave a stale size
    // saved forever. The media position/duration ride along so main can
    // resume a VOD where this window left off (isLive lets main ignore a
    // meaningless live playhead).
    try {
      await emit(EV_CLOSED, {
        position: lastPosition,
        duration: lastDuration,
        isLive,
      })
    } catch {
      /* ignore */
    }
  }

  async function requestClose(): Promise<void> {
    // `close()` emits a close-requested event; our onCloseRequested handler
    // fires (emits ks://pip-closed with the rect) and then lets the window
    // destroy. Calling close() (not destroy()) keeps the close path uniform
    // whether the user hits our close button, Escape, or the WM shortcut.
    if (!isTauri()) return
    try {
      await getCurrentWindow().close()
    } catch {
      /* ignore */
    }
  }

  // The PiP window is borderless (decorations:false), so KWin/others give it
  // no server-side resize edges. We provide our own edge/corner handles that
  // drive tao's interactive resize via startResizeDragging. (Tauri ships a
  // data attribute only for *moving* windows, not for resizing.)
  // Tauri's startResizeDragging takes a ResizeDirection union it doesn't
  // export, so derive the type from the typed method signature.
  type ResizeDirection = Parameters<ReturnType<typeof getCurrentWindow>['startResizeDragging']>[0]

  function startResize(direction: ResizeDirection): void {
    if (!isTauri()) return
    void getCurrentWindow().startResizeDragging(direction)
  }

  function bumpControls(): void {
    controlsVisible = true
    if (hideTimer) clearTimeout(hideTimer)
    hideTimer = setTimeout(() => {
      hideTimer = null
      controlsVisible = false
    }, 2_500)
  }

  // A faded-out control bar takes its menu with it — otherwise an invisible
  // menu stays armed for the next reveal.
  $effect(() => {
    if (!controlsVisible) qualityMenuOpen = false
  })

  function onKeydown(e: KeyboardEvent): void {
    if (e.key === 'Escape') {
      e.preventDefault()
      // An open menu takes Escape first; only a bare Escape closes the window.
      if (qualityMenuOpen) {
        qualityMenuOpen = false
        return
      }
      void requestClose()
    } else if (e.key === 'm' || e.key === 'M') {
      toggleMuted()
    } else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      // The focused seek slider handles its own arrows; this window-level
      // arm covers the common case of nothing being focused in the bar.
      if (e.target instanceof HTMLInputElement) return
      e.preventDefault()
      nudgeSeek(e.key === 'ArrowLeft' ? -10 : 10)
    }
  }

  // Same context-menu suppression as the main window: the native menu's
  // Reload reloads this webview out from under the pip↔main coordination.
  onMount(() => {
    const prevent = (e: MouseEvent): void => e.preventDefault()
    document.addEventListener('contextmenu', prevent, { capture: true })
    return () => document.removeEventListener('contextmenu', prevent, { capture: true })
  })

  onMount(async () => {
    if (!isTauri()) {
      errorMsg = t('pip_notInTauri')
      loading = false
      return
    }
    const win = getCurrentWindow()

    // Re-assert always-on-top once the window is mapped. tao applies the
    // creation-time option via gtk_window_set_keep_above, which on Wayland is
    // a no-op (xdg-shell has no always-on-top), so this mainly solidifies the
    // state on X11. On KWin Wayland the only reliable fix is a Window Rule
    // (see README/AGENTS notes); nothing the app can do there.
    try {
      await win.setAlwaysOnTop(true)
    } catch {
      /* ignore */
    }

    const uInit = await listen<InitPayload>(EV_INIT, (e) => {
      const p = e.payload
      volume = typeof p.volume === 'number' ? Math.max(0, Math.min(1, p.volume)) : 1
      muted = !!p.muted
      if (videoEl) {
        videoEl.volume = volume
        videoEl.muted = muted
      }
      applyQualityMenu(p.quality, p.qualities)
      loadSource(p.url, p.mediaKind ?? 'hls', p.isLive, p.startAt, p.lowLatency, p.vodId)
    })
    unlisteners.push(uInit)

    const uStream = await listen<StreamPayload>(EV_STREAM, (e) => {
      loadSource(
        e.payload.url,
        e.payload.mediaKind ?? 'hls',
        e.payload.isLive,
        e.payload.startAt,
        e.payload.lowLatency,
        e.payload.vodId,
      )
    })
    unlisteners.push(uStream)

    const uQualities = await listen<{ quality?: string; qualities?: string[] }>(EV_QUALITIES, (e) => {
      applyQualityMenu(e.payload?.quality, e.payload?.qualities)
    })
    unlisteners.push(uQualities)

    const uDoClose = await listen(EV_DO_CLOSE, () => {
      void requestClose()
    })
    unlisteners.push(uDoClose)

    // Snap the window to exact 16:9 after a resize settles. setSize keeps the
    // top-left fixed, so width-authoritative snapping behaves cleanly for the
    // left/right edges and bottom corners (the handles we keep). The epsilon
    // check breaks the feedback loop once the window is already 16:9.
    try {
      const uResize = await win.onResized(({ payload }) => {
        const width = payload.width
        const height = payload.height
        // Persist first — the suppress check below must not skip this: the
        // suppressed events are the snap's own setSize results, which are
        // exactly the final settled size worth saving.
        onRectResized(width, height)
        if (Date.now() < suppressSnapUntil) return
        if (snapTimer) clearTimeout(snapTimer)
        snapTimer = setTimeout(() => {
          snapTimer = null
          const targetH = Math.round((width * 9) / 16)
          if (Math.abs(height - targetH) <= 1) return
          suppressSnapUntil = Date.now() + 500
          void win.setSize(new PhysicalSize(width, targetH)).catch(() => {
            /* ignore */
          })
        }, 250)
      })
      unlisteners.push(uResize)
    } catch {
      /* ignore — aspect-lock is best-effort */
    }

    // Position persistence (X11 reports real positions; on Wayland the
    // values are garbage-but-harmless — the restore move is a no-op there).
    try {
      const uMoved = await win.onMoved(({ payload }) => {
        onRectMoved(payload.x, payload.y)
      })
      unlisteners.push(uMoved)
    } catch {
      /* ignore — position restore is best-effort */
    }

    // Restore the saved size AFTER the resize listener is attached: the
    // resize events and setSize(PhysicalSize) speak the same physical units
    // (the snap has always relied on that), so the stored raw event values
    // are re-applied verbatim — no scale-factor or monitor queries in THIS
    // window, which mixed-DPI setups can misreport (KDE at 200% reporting
    // scaleFactor 1). The MAIN window's controller clamps the stored rect
    // and validates its position against its own monitor queries at open,
    // before this window is even created.
    {
      const savedRect = readSavedPipRect(STORAGE_KEYS.pipWindowRect)
      if (savedRect) {
        liveRect = savedRect
        try {
          await win.setSize(new PhysicalSize(savedRect.width, savedRect.height))
        } catch {
          /* ignore */
        }
      }
    }

    try {
      const uClose = await win.onCloseRequested(async () => {
        flushRectSave()
        await emitClosed()
      })
      unlisteners.push(uClose)
    } catch {
      /* ignore — fallback pagehide below still emits closed */
    }

    // Fallback: if the webview is torn down without a close-requested event
    // (e.g. process exit), best-effort flush the pending rect save and
    // signal closed.
    window.addEventListener('pagehide', () => {
      flushRectSave()
      void emitClosed()
    })

    bumpControls()
    void emit(EV_READY)
  })

  onDestroy(() => {
    playback.dispose(videoEl)
    if (hideTimer) clearTimeout(hideTimer)
    if (snapTimer) clearTimeout(snapTimer)
    flushRectSave()
    for (const u of unlisteners) {
      try {
        u()
      } catch {
        /* ignore */
      }
    }
    unlisteners.length = 0
  })
</script>

<svelte:window onkeydown={onKeydown} onmousemove={bumpControls} />

<div class="pip-root" data-tauri-drag-region class:controls-visible={controlsVisible}>
  <video
    bind:this={videoEl}
    class="pip-video"
    playsinline
    data-tauri-drag-region
    onclick={gesturePlay}
    onloadedmetadata={() => {
      applyPendingStart()
      syncSeekBounds()
    }}
    onprogress={applyPendingStart}
    ontimeupdate={() => {
      if (videoEl && Number.isFinite(videoEl.currentTime)) lastPosition = videoEl.currentTime
      syncSeekBounds()
    }}
    ondurationchange={() => {
      if (videoEl && Number.isFinite(videoEl.duration)) lastDuration = videoEl.duration
      syncSeekBounds()
    }}
    onplay={() => {
      paused = false
      bumpControls()
    }}
    onpause={() => {
      paused = true
      bumpControls()
      onPipPause()
    }}
    onwaiting={onVideoWaiting}
    onplaying={onVideoPlaying}
    onended={onVideoEnded}
  ></video>

  {#if loading}
    <div class="pip-status" data-tauri-drag-region>{t('loading')}</div>
  {/if}
  {#if errorMsg}
    <div class="pip-status pip-error" data-tauri-drag-region>{errorMsg}</div>
  {/if}
  {#if endedLive && !errorMsg}
    <div class="pip-status" data-tauri-drag-region>{t('offline')}</div>
  {/if}
  {#if needsGesture && !errorMsg}
    <button type="button" class="pip-gesture" onclick={gesturePlay}>{t('pip_tapForSound')}</button>
  {/if}

  <!-- Borderless resize handles. We keep only the left/right edges and bottom
       corners: under width-authoritative 16:9 snapping (setSize keeps the
       top-left fixed), these anchor cleanly with no position jumps. The top
       edge / top corners are omitted because the snap restores height from
       width, which would re-anchor the top. -->
  <div class="rz rz-left" aria-hidden="true" onmousedown={() => startResize('West')}></div>
  <div class="rz rz-right" aria-hidden="true" onmousedown={() => startResize('East')}></div>
  <div class="rz rz-bl" aria-hidden="true" onmousedown={() => startResize('SouthWest')}></div>
  <div class="rz rz-br" aria-hidden="true" onmousedown={() => startResize('SouthEast')}></div>

  <div class="pip-controls">
    {#if !loading && !errorMsg && !endedLive && !isLive && seekMax - seekMin > 2}
      <!-- A miniature of the main player's scrubber: track + buffered +
           played, chapter ticks, muted-segment stripes, and the storyboard
           hover preview with time + chapter label. All decorations are
           pointer-events:none so the click/hover math always sees the bar. -->
      <div
        class="pip-seek"
        role="slider"
        tabindex="0"
        aria-label={t('pc_seek')}
        aria-valuemin={Math.floor(seekMin)}
        aria-valuemax={Math.floor(seekMax)}
        aria-valuenow={Math.floor(seekHead)}
        onclick={onScrubClick}
        onmousemove={onScrubMove}
        onmouseleave={onScrubLeave}
        onkeydown={onScrubKey}
      >
        <div class="pip-seek-buffered" style="width: {seekPct(seekBuffered)}%"></div>
        <div class="pip-seek-played" style="width: {seekPct(seekHead)}%"></div>
        {#each mutedSpans as span (span.startSec)}
          {#if span.endSec > seekMin && span.startSec < seekMax}
            <div class="pip-seek-muted" style={mutedSpanStyle(span)} aria-hidden="true"></div>
          {/if}
        {/each}
        {#each chapters as chapter (chapter.startSec)}
          {#if chapter.startSec > seekMin}
            <div class="pip-seek-chapter" style="left: {seekPct(chapter.startSec)}%" aria-hidden="true"></div>
          {/if}
        {/each}
        {#if hoverTime !== null}
          <div class="pip-seek-hover" style="left: {seekPct(hoverTime)}%">
            {#if hoverThumb}
              <div
                class="pip-seek-thumb"
                style="width: {storyboard?.width}px; height: {storyboard?.height}px; background-image: url('{hoverThumb.url}'); background-size: {(storyboard?.cols ??
                  1) * (storyboard?.width ?? 0)}px {(storyboard?.rows ?? 1) *
                  (storyboard?.height ?? 0)}px; background-position: {hoverThumb.x}px {hoverThumb.y}px;"
                aria-hidden="true"
              ></div>
            {/if}
            <div class="pip-seek-bubble">
              {formatTime(hoverTime)}{#if hoverChapterLabel}<span class="pip-seek-chap">
                  · {hoverChapterLabel}</span
                >{/if}
            </div>
          </div>
        {/if}
      </div>
    {/if}
    <div class="pip-row">
      <button
        type="button"
        class="pip-btn"
        onclick={togglePlay}
        aria-label={paused ? t('pc_play') : t('pc_pause')}
        aria-pressed={!paused}
      >
        {#if paused}
          <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
            <path d="M8 5v14l11-7z" fill="currentColor" />
          </svg>
        {:else}
          <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
            <rect x="6" y="5" width="4" height="14" fill="currentColor" />
            <rect x="14" y="5" width="4" height="14" fill="currentColor" />
          </svg>
        {/if}
      </button>

      <button
        type="button"
        class="pip-btn"
        onclick={toggleMuted}
        aria-label={muted ? t('pc_unmute') : t('pc_mute')}
        aria-pressed={muted}
      >
        {#if muted}
          <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
            <path
              d="M16.5 12c0-1.77-1.02-3.29-2.5-4.03v2.21l2.45 2.45c.03-.2.05-.41.05-.63zm2.5 0c0 .94-.2 1.82-.54 2.64l1.51 1.51A8.796 8.796 0 0 0 21 12c0-4.28-2.99-7.86-7-8.77v2.06c2.89.86 5 3.54 5 6.71zM4.27 3 3 4.27 7.73 9H3v6h4l5 5v-6.73l4.25 4.25c-.67.52-1.42.93-2.25 1.18v2.06a8.99 8.99 0 0 0 3.69-1.81L19.73 21 21 19.73l-9-9L4.27 3zM12 4 9.91 6.09 12 8.18V4z"
              fill="currentColor"
            />
          </svg>
        {:else}
          <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
            <path
              d="M3 9v6h4l5 5V4L7 9H3zm13.5 3c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02zM14 3.23v2.06c2.89.86 5 3.54 5 6.71s-2.11 5.85-5 6.71v2.06c4.01-.91 7-4.49 7-8.77s-2.99-7.86-7-8.77z"
              fill="currentColor"
            />
          </svg>
        {/if}
      </button>

      <input
        type="range"
        class="pip-volume"
        min="0"
        max="1"
        step="0.05"
        value={muted ? 0 : volume}
        aria-label={t('volume')}
        oninput={(e) => applyVolume(parseFloat((e.currentTarget as HTMLInputElement).value))}
      />

      <div class="pip-spacer" aria-hidden="true"></div>

      {#if pipQualities.length > 0}
        <!-- The main player's quality gear in miniature: the same probed
             variant list (never the bare vocabulary once the probe has
             answered), the same active-row checkmark. Clips never render
             it — their quality is fixed. -->
        <div class="pip-menu-wrap">
          <button
            type="button"
            class="pip-btn"
            onclick={toggleQualityMenu}
            aria-label={t('quality')}
            aria-haspopup="menu"
            aria-expanded={qualityMenuOpen}
          >
            <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
              <path
                d="M19.14 12.94c.04-.31.06-.62.06-.94s-.02-.63-.07-.94l2.03-1.58c.18-.14.23-.41.12-.61l-1.92-3.32c-.12-.22-.37-.29-.59-.22l-2.39.96c-.5-.38-1.03-.7-1.62-.94l-.36-2.54c-.04-.24-.24-.41-.48-.41h-3.84c-.24 0-.43.17-.47.41l-.36 2.54c-.59.24-1.13.57-1.62.94l-2.39-.96c-.22-.08-.47 0-.59.22L2.74 8.87c-.12.21-.08.47.12.61l2.03 1.58c-.05.31-.09.63-.09.94s.02.63.07.94l-2.03 1.58c-.18.14-.23.41-.12.61l1.92 3.32c.12.22.37.29.59.22l2.39-.96c.5.38 1.03.7 1.62.94l.36 2.54c.05.24.24.41.48.41h3.84c.24 0 .44-.17.47-.41l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.22.08.47 0 .59-.22l1.92-3.32c.12-.22.07-.47-.12-.61l-2.01-1.58zM12 15.6c-1.98 0-3.6-1.62-3.6-3.6s1.62-3.6 3.6-3.6 3.6 1.62 3.6 3.6-1.62 3.6-3.6 3.6z"
                fill="currentColor"
              />
            </svg>
          </button>
          {#if qualityMenuOpen}
            <div class="pip-menu" role="menu">
              <div class="pip-menu-label">{t('quality')}</div>
              {#each pipQualities as qid (qid)}
                <button
                  type="button"
                  class="pip-menu-item"
                  class:pip-menu-item--active={pipQuality === qid}
                  role="menuitemradio"
                  aria-checked={pipQuality === qid}
                  onclick={() => selectQuality(qid)}
                >
                  <span>{qualityLabel(qid)}</span>
                  {#if pipQuality === qid}
                    <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true">
                      <path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41L9 16.17z" fill="currentColor" />
                    </svg>
                  {/if}
                </button>
              {/each}
            </div>
          {/if}
        </div>
      {/if}

      <button type="button" class="pip-btn" onclick={requestClose} aria-label={t('pip_close')}>
        <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
          <path
            d="M19 6.41 17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"
            fill="currentColor"
          />
        </svg>
      </button>
    </div>
  </div>
</div>

<style>
  :global(html),
  :global(body) {
    margin: 0;
    padding: 0;
    height: 100%;
    background: #000;
    overflow: hidden;
  }
  :global(#app) {
    height: 100%;
  }
  .pip-root {
    position: relative;
    width: 100vw;
    height: 100vh;
    background: #000;
    overflow: hidden;
    user-select: none;
  }
  .pip-video {
    width: 100%;
    height: 100%;
    /* cover (not contain): the window cannot be aspect-locked on Linux
       (tao exposes no aspect-ratio API), so filling the window avoids black
       letterbox bars when the compositor opens it at a non-16:9 size. */
    object-fit: cover;
    display: block;
    background: #000;
  }
  .pip-status {
    position: absolute;
    top: 50%;
    left: 50%;
    transform: translate(-50%, -50%);
    color: #fff;
    font:
      600 13px/1 system-ui,
      sans-serif;
    text-shadow: 0 1px 3px rgba(0, 0, 0, 0.8);
    pointer-events: none;
    z-index: 30;
  }
  .pip-error {
    color: #ff8a8a;
  }
  .pip-gesture {
    position: absolute;
    top: 50%;
    left: 50%;
    transform: translate(-50%, -50%);
    padding: 6px 14px;
    border: 1px solid rgba(255, 255, 255, 0.3);
    border-radius: 6px;
    background: rgba(0, 0, 0, 0.6);
    color: #fff;
    font:
      600 13px/1 system-ui,
      sans-serif;
    cursor: pointer;
    z-index: 30;
  }
  .pip-gesture:hover {
    background: rgba(0, 0, 0, 0.8);
  }
  .pip-controls {
    position: absolute;
    left: 0;
    right: 0;
    bottom: 0;
    display: flex;
    flex-direction: column;
    gap: 2px;
    padding: 6px 8px;
    background: linear-gradient(to top, rgba(0, 0, 0, 0.7), rgba(0, 0, 0, 0));
    opacity: 0;
    transition: opacity 0.15s ease;
    /* The bar itself stays click-through so the resize handles beneath stay
       grabbable; only the interactive children re-enable pointer events. */
    pointer-events: none;
    z-index: 25;
  }
  .pip-root.controls-visible .pip-controls {
    opacity: 1;
  }
  .pip-row {
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .pip-btn,
  .pip-volume {
    pointer-events: auto;
  }
  /* Unlike the buttons, the seek bar spans the full window width and would
     shadow the edge/corner resize handles while the bar is faded out, so it
     is only hit-testable while visible (any mousemove reveals the bar). */
  .pip-seek {
    pointer-events: none;
  }
  .pip-root.controls-visible .pip-seek {
    pointer-events: auto;
  }
  /* Miniature of the main player's scrubber (PlayerControls' .progress at a
     fixed scale — the PiP window does not apply uiScale or theme vars). */
  .pip-seek {
    position: relative;
    height: 12px;
    margin: 0 2px;
    cursor: pointer;
    display: flex;
    align-items: center;
  }
  .pip-seek::before {
    content: '';
    position: absolute;
    left: 0;
    right: 0;
    height: 3px;
    background: rgba(255, 255, 255, 0.25);
    border-radius: 2px;
  }
  .pip-seek-buffered,
  .pip-seek-played {
    position: absolute;
    left: 0;
    height: 3px;
    border-radius: 2px;
    pointer-events: none;
  }
  .pip-seek-buffered {
    background: rgba(255, 255, 255, 0.45);
  }
  .pip-seek-played {
    background: #6d5dd3;
  }
  .pip-seek-muted {
    position: absolute;
    top: 50%;
    transform: translateY(-50%);
    height: 3px;
    border-radius: 2px;
    background: repeating-linear-gradient(
      45deg,
      rgba(229, 57, 53, 0.95) 0,
      rgba(229, 57, 53, 0.95) 3px,
      rgba(120, 20, 20, 0.95) 3px,
      rgba(120, 20, 20, 0.95) 6px
    );
    pointer-events: none;
  }
  .pip-seek-chapter {
    position: absolute;
    top: 50%;
    transform: translate(-50%, -50%);
    width: 2px;
    height: 9px;
    border-radius: 1px;
    background: rgba(255, 255, 255, 0.55);
    pointer-events: none;
  }
  .pip-seek:hover::before,
  .pip-seek:hover .pip-seek-buffered,
  .pip-seek:hover .pip-seek-played,
  .pip-seek:hover .pip-seek-muted {
    height: 5px;
  }
  .pip-seek-hover {
    position: absolute;
    bottom: calc(100% + 2px);
    transform: translateX(-50%);
    pointer-events: none;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 4px;
  }
  .pip-seek-thumb {
    flex: 0 0 auto;
    border-radius: 3px;
    border: 1px solid rgba(255, 255, 255, 0.3);
    background-color: #000;
    background-repeat: no-repeat;
  }
  .pip-seek-bubble {
    background: rgba(0, 0, 0, 0.8);
    color: #fff;
    padding: 2px 6px;
    border-radius: 3px;
    font:
      600 11px/1.2 system-ui,
      sans-serif;
    white-space: nowrap;
  }
  .pip-seek-chap {
    display: inline-block;
    max-width: 140px;
    overflow: hidden;
    text-overflow: ellipsis;
    vertical-align: bottom;
    color: rgba(255, 255, 255, 0.7);
  }
  /* Borderless resize handles. z-index 20 < controls (25) so buttons always
     win where they overlap; the bar is click-through so handles stay usable
     everywhere else. */
  .rz {
    position: absolute;
    z-index: 20;
  }
  .rz-left {
    top: 8px;
    bottom: 8px;
    left: 0;
    width: 6px;
    cursor: ew-resize;
  }
  .rz-right {
    top: 8px;
    bottom: 8px;
    right: 0;
    width: 6px;
    cursor: ew-resize;
  }
  .rz-bl {
    bottom: 0;
    left: 0;
    width: 12px;
    height: 12px;
    cursor: nesw-resize;
  }
  .rz-br {
    bottom: 0;
    right: 0;
    width: 12px;
    height: 12px;
    cursor: nwse-resize;
  }
  .pip-btn {
    flex: 0 0 auto;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 24px;
    height: 24px;
    padding: 0;
    border: none;
    border-radius: 4px;
    background: transparent;
    color: #fff;
    cursor: pointer;
  }
  .pip-btn:hover {
    background: rgba(255, 255, 255, 0.15);
  }
  .pip-volume {
    flex: 0 1 90px;
    min-width: 40px;
    height: 4px;
    accent-color: #6d5dd3;
    cursor: pointer;
  }
  .pip-spacer {
    flex: 1 1 auto;
  }
  /* Quality menu — the gear menu opens UP from the bottom bar, right-aligned
     under its button (the PiP window has no theme vars; fixed dark surface
     like every other pip overlay). */
  .pip-menu-wrap {
    position: relative;
    display: inline-flex;
  }
  .pip-menu,
  .pip-menu-item {
    pointer-events: auto;
  }
  .pip-menu {
    position: absolute;
    right: 0;
    bottom: calc(100% + 6px);
    min-width: 118px;
    max-height: 150px;
    overflow-y: auto;
    padding: 4px;
    border-radius: 6px;
    background: rgba(18, 18, 22, 0.97);
    border: 1px solid rgba(255, 255, 255, 0.14);
    box-shadow: 0 4px 14px rgba(0, 0, 0, 0.5);
    display: flex;
    flex-direction: column;
    gap: 1px;
  }
  .pip-menu-label {
    padding: 4px 8px 3px;
    color: rgba(255, 255, 255, 0.55);
    font:
      600 10px/1.2 system-ui,
      sans-serif;
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }
  .pip-menu-item {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
    padding: 4px 8px;
    border: none;
    border-radius: 4px;
    background: transparent;
    color: #fff;
    font:
      500 12px/1.4 system-ui,
      sans-serif;
    text-align: left;
    cursor: pointer;
  }
  .pip-menu-item:hover {
    background: rgba(255, 255, 255, 0.12);
  }
  .pip-menu-item--active {
    color: #a99cf0;
  }
</style>
