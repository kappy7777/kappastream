<script lang="ts">
  import { settings } from './settings.svelte.ts'
  import { pipController } from './pip-controller.svelte.ts'
  import { tooltip } from './tooltip.ts'
  import type { LiveStatus } from './favorites.svelte.ts'
  import { isTauri } from '@tauri-apps/api/core'

  interface QualityOption {
    id: string
    label: string
  }

  const QUALITY_OPTIONS: ReadonlyArray<QualityOption> = [
    { id: 'best', label: 'Source' },
    { id: '1080p60', label: '1080p60' },
    { id: '720p60', label: '720p60' },
    { id: '720p', label: '720p' },
    { id: '480p', label: '480p' },
    { id: '360p', label: '360p' },
    { id: '160p', label: '160p' },
    { id: 'audio_only', label: 'Audio only' },
  ]

  interface Props {
    video: HTMLVideoElement | null | undefined
    visible: boolean
    quality: string
    onqualitychange: (q: string) => void
    onmpv: () => void
    onstop: () => void
    onplayintent: (playing: boolean) => void
    activeStatus: LiveStatus
  }

  const { video, visible, quality, onqualitychange, onmpv, onstop, onplayintent, activeStatus }: Props = $props()

  function formatViewers(n: number): string {
    if (n < 1000) return n.toString()
    if (n < 1_000_000) {
      const k = n / 1000
      return (k < 100 ? k.toFixed(1).replace(/\.0$/, '') : Math.round(k).toString()) + 'K'
    }
    return (n / 1_000_000).toFixed(1).replace(/\.0$/, '') + 'M'
  }

  function toggleTheater(): void {
    settings.toggleTheaterMode()
    closeMenu()
  }

  let playing = $state(false)
  let muted = $state(false)
  let volume = $state(1)
  let currentTime = $state(0)
  let duration = $state(0)
  let buffered = $state(0)
  let isFullscreen = $state(false)
  let hoverTime: number | null = $state(null)
  let menuOpen = $state(false)
  // PiP here is a custom floating Tauri window (the native HTML5
  // `requestPictureInPicture` API is unavailable on WebKitGTK). It only works
  // under the Tauri runtime, which is where this control ships.
  const pipSupported = isTauri()
  const pipActive = $derived(pipController.isOpen)
  let volumeHydrated = false
  let lastActivityAt = $state(Date.now())
  let controlsShown = $state(true)
  const IDLE_HIDE_MS = 4_000

  function bumpActivity(): void {
    lastActivityAt = Date.now()
    controlsShown = true
  }

  function attach(v: HTMLVideoElement): () => void {
    const onPlay = () => { playing = true }
    const onPause = () => { playing = false }
    const onTime = () => { currentTime = v.currentTime }
    const onMeta = () => { duration = v.duration }
    const onVol = () => {
      volume = v.volume
      muted = v.muted
      if (volumeHydrated) {
        settings.setVolume(v.volume)
        // While the PiP window is open the controller force-mutes this video;
        // don't persist that transient mute (it is restored on PiP close).
        if (!pipController.overridingMainMute) {
          settings.setMuted(v.muted)
        }
      }
    }
    const onProgress = () => {
      try {
        if (v.buffered.length > 0) {
          buffered = v.buffered.end(v.buffered.length - 1)
        }
      } catch {
        /* ignore */
      }
    }
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      const step = 0.05
      const dir = e.deltaY < 0 ? 1 : -1
      const current = v.muted ? 0 : v.volume
      const next = Math.max(0, Math.min(1, current + dir * step))
      if (next > 0 && v.muted) v.muted = false
      v.volume = next
    }
    v.addEventListener('play', onPlay)
    v.addEventListener('pause', onPause)
    v.addEventListener('timeupdate', onTime)
    v.addEventListener('loadedmetadata', onMeta)
    v.addEventListener('durationchange', onMeta)
    v.addEventListener('volumechange', onVol)
    v.addEventListener('progress', onProgress)
    v.addEventListener('wheel', onWheel, { passive: false })

    v.volume = settings.volume
    v.muted = settings.muted
    volume = v.volume
    muted = v.muted
    volumeHydrated = true
    playing = !v.paused
    duration = isFinite(v.duration) ? v.duration : 0

    return () => {
      volumeHydrated = false
      v.removeEventListener('play', onPlay)
      v.removeEventListener('pause', onPause)
      v.removeEventListener('timeupdate', onTime)
      v.removeEventListener('loadedmetadata', onMeta)
      v.removeEventListener('durationchange', onMeta)
      v.removeEventListener('volumechange', onVol)
      v.removeEventListener('progress', onProgress)
      v.removeEventListener('wheel', onWheel)
    }
  }

  $effect(() => {
    if (!video) return
    const detach = attach(video)
    const onFs = () => { isFullscreen = !!document.fullscreenElement }
    document.addEventListener('fullscreenchange', onFs)

    const v: HTMLVideoElement = video
    const onEnter = () => { bumpActivity() }
    const onLeave = () => { lastActivityAt = Date.now() }
    const onMove = () => { bumpActivity() }
    const onClick = () => { bumpActivity() }
    v.addEventListener('mouseenter', onEnter)
    v.addEventListener('mouseleave', onLeave)
    v.addEventListener('mousemove', onMove)
    v.addEventListener('click', onClick)
    bumpActivity()

    const ro = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const w = entry.contentRect.width
        if (w > 0) playerWidth = w
      }
    })
    ro.observe(v)
    const initialW = v.getBoundingClientRect().width
    if (initialW > 0) playerWidth = initialW

    return () => {
      detach()
      document.removeEventListener('fullscreenchange', onFs)
      v.removeEventListener('mouseenter', onEnter)
      v.removeEventListener('mouseleave', onLeave)
      v.removeEventListener('mousemove', onMove)
      v.removeEventListener('click', onClick)
      ro.disconnect()
    }
  })

  $effect(() => {
    if (!visible) return
    const id = setInterval(() => {
      if (Date.now() - lastActivityAt >= IDLE_HIDE_MS) controlsShown = false
    }, 500)
    return () => clearInterval(id)
  })

  function togglePlay(): void {
    if (!video) return
    if (video.paused) {
      void video.play()
      onplayintent(true)
    } else {
      // Flag the user pause BEFORE calling pause() so App's onVideoPause
      // sees userPaused and doesn't auto-resume a deliberate pause.
      onplayintent(false)
      video.pause()
    }
  }

  function toggleMute(): void {
    if (!video) return
    video.muted = !video.muted
  }

  function setVolume(v: number): void {
    if (!video) return
    video.volume = v
    if (v > 0 && video.muted) video.muted = false
  }

  function seekTo(t: number): void {
    if (!video) return
    video.currentTime = Math.max(0, Math.min(t, isFinite(duration) ? duration : t))
  }

  function seekFromEvent(e: MouseEvent, el: HTMLElement): void {
    const rect = el.getBoundingClientRect()
    const pct = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width))
    seekTo(pct * (isFinite(duration) ? duration : 0))
  }

  function onProgressMove(e: MouseEvent, el: HTMLElement): void {
    const rect = el.getBoundingClientRect()
    const pct = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width))
    hoverTime = pct * (isFinite(duration) ? duration : 0)
  }

  function toggleFullscreen(): void {
    if (!video) return
    if (document.fullscreenElement) {
      void document.exitFullscreen()
    } else {
      const el = video.parentElement ?? video
      void el.requestFullscreen?.()
    }
  }

  function toggleMenu(): void {
    menuOpen = !menuOpen
  }

  function closeMenu(): void {
    menuOpen = false
  }

  function selectQuality(q: string): void {
    if (q === quality) {
      closeMenu()
      return
    }
    closeMenu()
    onqualitychange(q)
  }

  async function togglePip(): Promise<void> {
    menuOpen = false
    await pipController.toggle()
  }

  function formatTime(s: number): string {
    if (!isFinite(s) || s < 0) return '0:00'
    const h = Math.floor(s / 3600)
    const m = Math.floor((s % 3600) / 60)
    const sec = Math.floor(s % 60)
    if (h > 0) return h + ':' + m.toString().padStart(2, '0') + ':' + sec.toString().padStart(2, '0')
    return m + ':' + sec.toString().padStart(2, '0')
  }

  function progressPct(t: number): number {
    if (!isFinite(duration) || duration <= 0) return 0
    return Math.max(0, Math.min(100, (t / duration) * 100))
  }

  let progressEl: HTMLElement | undefined = $state()

  let playerWidth = $state(640)
  const CTRL_SCALE_BASELINE = 640
  const CTRL_SCALE_MIN = 0.65
  const CTRL_SCALE_MAX = 1.6

  let ctrlScale = $derived(
    Math.max(
      CTRL_SCALE_MIN,
      Math.min(CTRL_SCALE_MAX, playerWidth / CTRL_SCALE_BASELINE),
    ),
  )

  function onProgressClick(e: MouseEvent): void {
    if (progressEl) seekFromEvent(e, progressEl)
  }
  function onProgressHover(e: MouseEvent): void {
    if (progressEl) onProgressMove(e, progressEl)
  }
  function onProgressLeave(): void {
    hoverTime = null
  }

  function onProgressKey(e: KeyboardEvent): void {
    if (!isFinite(duration) || duration <= 0) return
    const step = e.shiftKey ? 30 : 5
    if (e.key === 'ArrowLeft') {
      e.preventDefault()
      seekTo(currentTime - step)
    } else if (e.key === 'ArrowRight') {
      e.preventDefault()
      seekTo(currentTime + step)
    } else if (e.key === 'Home') {
      e.preventDefault()
      seekTo(0)
    } else if (e.key === 'End') {
      e.preventDefault()
      seekTo(duration)
    }
  }

  function onControlsKey(e: KeyboardEvent): void {
    if (e.key === 'Escape' && menuOpen) {
      e.preventDefault()
      closeMenu()
    }
  }
</script>

{#if settings.theaterMode && activeStatus.state === 'live' && visible && controlsShown}
  <div class="theater-info">
    {#if activeStatus.avatarUrl}
      <img class="theater-info-avatar" src={activeStatus.avatarUrl} alt="" />
    {/if}
    <div class="theater-info-text">
      <div class="theater-info-title">{activeStatus.title}</div>
      <div class="theater-info-meta">
        {#if activeStatus.game}<span class="theater-info-game">{activeStatus.game}</span><span class="theater-info-dot">·</span>{/if}
        <span class="theater-info-viewers">{formatViewers(activeStatus.viewers)} viewers</span>
      </div>
    </div>
  </div>
{/if}

{#if visible && controlsShown}
  <div
    class="controls"
    role="presentation"
    onkeydown={onControlsKey}
    style="--ctrl-scale: {ctrlScale.toFixed(3)}"
  >
    {#if menuOpen}
      <button
        type="button"
        class="menu-backdrop"
        aria-label="Close menu"
        onclick={closeMenu}
      ></button>
    {/if}
    <div
      class="progress"
      bind:this={progressEl}
      onclick={onProgressClick}
      onmousemove={onProgressHover}
      onmouseleave={onProgressLeave}
      onkeydown={onProgressKey}
      role="slider"
      tabindex="0"
      aria-label="Seek"
      aria-valuemin="0"
      aria-valuemax={isFinite(duration) ? Math.floor(duration) : 0}
      aria-valuenow={Math.floor(currentTime)}
    >
      <div class="progress-buffered" style="width: {progressPct(buffered)}%"></div>
      <div class="progress-played" style="width: {progressPct(currentTime)}%"></div>
      {#if hoverTime !== null}
        <div class="progress-hover" style="left: {progressPct(hoverTime)}%">
          <div class="progress-hover-bubble">{formatTime(hoverTime)}</div>
        </div>
      {/if}
    </div>
    <div class="controls-row">
      <button
        type="button"
        class="ctrl-btn ctrl-btn--play"
        onclick={togglePlay}
        aria-label={playing ? 'Pause' : 'Play'}
        use:tooltip={playing ? 'Pause' : 'Play'}
      >
        {#if playing}
          <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
            <rect x="6" y="5" width="4" height="14" fill="currentColor"/>
            <rect x="14" y="5" width="4" height="14" fill="currentColor"/>
          </svg>
        {:else}
          <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
            <path d="M8 5v14l11-7z" fill="currentColor"/>
          </svg>
        {/if}
      </button>

      <button
        type="button"
        class="ctrl-btn"
        onclick={onstop}
        aria-label="Stop stream"
        use:tooltip={'Stop stream'}
      >
        <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
          <rect x="6" y="6" width="12" height="12" rx="1.5" fill="currentColor"/>
        </svg>
      </button>

      <button
        type="button"
        class="ctrl-btn"
        onclick={toggleMute}
        aria-label={muted || volume === 0 ? 'Unmute' : 'Mute'}
        use:tooltip={muted || volume === 0 ? 'Unmute' : 'Mute'}
      >
        {#if muted || volume === 0}
          <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
            <path d="M3 9v6h4l5 5V4L7 9H3zm13.5 3l2.7-2.7-1.4-1.4L15 10.6l-2.8-2.8-1.4 1.4L13.6 12l-2.8 2.8 1.4 1.4L15 13.4l2.7 2.7 1.4-1.4L16.4 12z" fill="currentColor"/>
          </svg>
        {:else if volume < 0.5}
          <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
            <path d="M3 9v6h4l5 5V4L7 9H3z" fill="currentColor"/>
          </svg>
        {:else}
          <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
            <path d="M3 9v6h4l5 5V4L7 9H3zm11 .2v5.6c1.5-.5 2.5-1.9 2.5-3.5s-1-3-2.5-3.5z" fill="currentColor"/>
          </svg>
        {/if}
      </button>

      <input
        class="volume"
        type="range"
        min="0"
        max="1"
        step="0.05"
        value={muted ? 0 : volume}
        oninput={(e) => setVolume(parseFloat((e.currentTarget as HTMLInputElement).value))}
        aria-label="Volume"
      />

      <span class="time" aria-live="off">{formatTime(currentTime)} / {formatTime(duration)}</span>

      <div class="spacer"></div>

      <div class="menu-wrap">
        <button
          type="button"
          class="ctrl-btn"
          onclick={toggleMenu}
          aria-label="Settings"
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          use:tooltip={'Settings'}
        >
          <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
            <path d="M19.14 12.94c.04-.31.06-.62.06-.94s-.02-.63-.07-.94l2.03-1.58c.18-.14.23-.41.12-.61l-1.92-3.32c-.12-.22-.37-.29-.59-.22l-2.39.96c-.5-.38-1.03-.7-1.62-.94l-.36-2.54c-.04-.24-.24-.41-.48-.41h-3.84c-.24 0-.43.17-.47.41l-.36 2.54c-.59.24-1.13.57-1.62.94l-2.39-.96c-.22-.08-.47 0-.59.22L2.74 8.87c-.12.21-.08.47.12.61l2.03 1.58c-.05.31-.09.63-.09.94s.02.63.07.94l-2.03 1.58c-.18.14-.23.41-.12.61l1.92 3.32c.12.22.37.29.59.22l2.39-.96c.5.38 1.03.7 1.62.94l.36 2.54c.05.24.24.41.48.41h3.84c.24 0 .44-.17.47-.41l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.22.08.47 0 .59-.22l1.92-3.32c.12-.22.07-.47-.12-.61l-2.01-1.58zM12 15.6c-1.98 0-3.6-1.62-3.6-3.6s1.62-3.6 3.6-3.6 3.6 1.62 3.6 3.6-1.62 3.6-3.6 3.6z" fill="currentColor"/>
          </svg>
        </button>
        {#if menuOpen}
          <div class="menu" role="menu">
            <div class="menu-section">
              <div class="menu-label">Quality</div>
              {#each QUALITY_OPTIONS as opt}
                <button
                  type="button"
                  class="menu-item"
                  class:menu-item--active={quality === opt.id}
                  role="menuitemradio"
                  aria-checked={quality === opt.id}
                  onclick={() => selectQuality(opt.id)}
                >
                  <span>{opt.label}</span>
                  {#if quality === opt.id}
                    <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true">
                      <path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41L9 16.17z" fill="currentColor"/>
                    </svg>
                  {/if}
                </button>
              {/each}
            </div>
          </div>
        {/if}
      </div>

      {#if pipSupported}
        <button
          type="button"
          class="ctrl-btn"
          class:ctrl-btn--active={pipActive}
          onclick={togglePip}
          aria-label={pipActive ? 'Exit Picture in Picture' : 'Picture in Picture'}
          aria-pressed={pipActive}
          use:tooltip={pipActive ? 'Exit Picture in Picture' : 'Picture in Picture'}
        >
          <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
            <path d="M19 7h-8v6h8V7zm2-4H3c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h18c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zm0 16H3V5h18v14z" fill="currentColor"/>
          </svg>
        </button>
      {/if}

      <button
        type="button"
        class="ctrl-btn"
        onclick={onmpv}
        aria-label="Play in mpv"
        use:tooltip={'Play in mpv'}
      >
        <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
          <path d="M21 3H3c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h6v2h6v-2h6c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zm0 14H3V5h18v12zM10 15l7-4-7-4z" fill="currentColor"/>
        </svg>
      </button>

      <button
        type="button"
        class="ctrl-btn"
        class:ctrl-btn--active={settings.theaterMode}
        onclick={toggleTheater}
        aria-label={settings.theaterMode ? 'Exit theater mode' : 'Theater mode'}
        aria-pressed={settings.theaterMode}
        use:tooltip={settings.theaterMode ? 'Exit theater mode' : 'Theater mode'}
      >
        <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
          <path d="M19 7H5c-1.1 0-2 .9-2 2v6c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V9c0-1.1-.9-2-2-2zm0 8H5V9h14v6zM3 4h18v2H3V4zm0 14h18v2H3v-2z" fill="currentColor"/>
        </svg>
      </button>

      <button
        type="button"
        class="ctrl-btn"
        onclick={toggleFullscreen}
        aria-label={isFullscreen ? 'Exit fullscreen' : 'Enter fullscreen'}
        use:tooltip={isFullscreen ? 'Exit fullscreen' : 'Fullscreen'}
      >
        {#if isFullscreen}
          <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
            <path d="M5 16h3v3h2v-5H5v2zm3-8H5v2h5V5H8v3zm6 11h2v-3h3v-2h-5v5zm2-11V5h-2v5h5V8h-3z" fill="currentColor"/>
          </svg>
        {:else}
          <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
            <path d="M7 14H5v5h5v-2H7v-3zm-2-4h2V7h3V5H5v5zm12 7h-3v2h5v-5h-2v3zM14 5v2h3v3h2V5h-5z" fill="currentColor"/>
          </svg>
        {/if}
      </button>
    </div>
  </div>
{/if}

<style>
  .theater-info {
    position: absolute;
    top: 0;
    left: 0;
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 10px 14px;
    background: linear-gradient(to bottom, rgba(0, 0, 0, 0.65), rgba(0, 0, 0, 0));
    color: #fff;
    z-index: 5;
    pointer-events: none;
    max-width: 60%;
  }
  .theater-info-avatar {
    width: 36px;
    height: 36px;
    border-radius: 50%;
    object-fit: cover;
    flex: 0 0 auto;
  }
  .theater-info-text {
    display: flex;
    flex-direction: column;
    min-width: 0;
  }
  .theater-info-title {
    font-size: 14px;
    font-weight: 600;
    text-shadow: 0 1px 2px rgba(0, 0, 0, 0.8);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .theater-info-meta {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 12px;
    color: rgba(255, 255, 255, 0.85);
    text-shadow: 0 1px 2px rgba(0, 0, 0, 0.8);
  }
  .theater-info-game {
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    max-width: 30vw;
  }
  .theater-info-dot {
    opacity: 0.7;
  }
  .theater-info-viewers {
    flex: 0 0 auto;
  }

  .controls {
    --ctrl-scale: 1;
    position: absolute;
    left: 0;
    right: 0;
    bottom: 0;
    padding: 0 calc(12px * var(--ctrl-scale)) calc(8px * var(--ctrl-scale));
    background: linear-gradient(to top, var(--bg-overlay), transparent);
    color: var(--text-primary);
    display: flex;
    flex-direction: column;
    gap: calc(4px * var(--ctrl-scale));
    box-sizing: border-box;
    z-index: 5;
    pointer-events: auto;
    animation: controls-fade-in 150ms ease;
  }

  @keyframes controls-fade-in {
    from { opacity: 0; }
    to { opacity: 1; }
  }

  .progress {
    position: relative;
    height: calc(14px * var(--ctrl-scale));
    cursor: pointer;
    display: flex;
    align-items: center;
  }

  .progress::before {
    content: '';
    position: absolute;
    left: 0;
    right: 0;
    height: calc(3px * var(--ctrl-scale));
    background: var(--track);
    border-radius: calc(2px * var(--ctrl-scale));
    transition: height 150ms;
  }

  .progress-buffered,
  .progress-played {
    position: absolute;
    left: 0;
    height: calc(3px * var(--ctrl-scale));
    border-radius: calc(2px * var(--ctrl-scale));
    pointer-events: none;
    transition: height 150ms;
  }

  .progress-buffered {
    background: var(--track-buffered);
  }

  .progress-played {
    background: var(--accent);
  }

  .progress:hover::before,
  .progress:hover .progress-buffered,
  .progress:hover .progress-played {
    height: calc(5px * var(--ctrl-scale));
  }

  .progress-hover {
    position: absolute;
    top: 0;
    transform: translateX(-50%);
    pointer-events: none;
    height: 100%;
    display: flex;
    align-items: flex-start;
    justify-content: center;
  }

  .progress-hover-bubble {
    background: var(--bg-overlay-strong);
    color: var(--text-primary);
    padding: calc(2px * var(--ctrl-scale)) calc(6px * var(--ctrl-scale));
    border-radius: calc(3px * var(--ctrl-scale));
    font-size: calc(11px * var(--ctrl-scale));
    white-space: nowrap;
    transform: translateY(calc(-18px * var(--ctrl-scale)));
  }

  .controls-row {
    display: flex;
    align-items: center;
    gap: calc(6px * var(--ctrl-scale));
    height: calc(32px * var(--ctrl-scale));
  }

  .ctrl-btn {
    flex: 0 0 auto;
    width: calc(32px * var(--ctrl-scale));
    height: calc(32px * var(--ctrl-scale));
    border: none;
    background: transparent;
    color: var(--text-primary);
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 0;
    border-radius: calc(4px * var(--ctrl-scale));
    transition: background 150ms;
  }

  .ctrl-btn svg {
    width: calc(18px * var(--ctrl-scale));
    height: calc(18px * var(--ctrl-scale));
  }

  .ctrl-btn:hover {
    background: var(--bg-hover-faint);
  }

  .ctrl-btn--active {
    color: var(--accent);
    background: var(--bg-hover-faint);
  }

  .ctrl-btn--play {
    width: calc(36px * var(--ctrl-scale));
  }

  .ctrl-btn--play svg {
    width: calc(20px * var(--ctrl-scale));
    height: calc(20px * var(--ctrl-scale));
  }

  .volume {
    flex: 0 0 calc(80px * var(--ctrl-scale));
    height: calc(3px * var(--ctrl-scale));
    appearance: none;
    -webkit-appearance: none;
    background: var(--track);
    border-radius: calc(2px * var(--ctrl-scale));
    outline: none;
    cursor: pointer;
    transition: background 150ms;
  }

  .volume:hover {
    background: var(--track-hover);
  }

  .volume::-webkit-slider-thumb {
    appearance: none;
    -webkit-appearance: none;
    width: calc(10px * var(--ctrl-scale));
    height: calc(10px * var(--ctrl-scale));
    border-radius: 50%;
    background: var(--text-primary);
    cursor: pointer;
  }

  .volume::-moz-range-thumb {
    width: calc(10px * var(--ctrl-scale));
    height: calc(10px * var(--ctrl-scale));
    border-radius: 50%;
    background: var(--text-primary);
    border: none;
    cursor: pointer;
  }

  .time {
    flex: 0 0 auto;
    font-size: calc(12px * var(--ctrl-scale));
    color: var(--text-secondary);
    font-variant-numeric: tabular-nums;
    font-family: 'Inter', system-ui, monospace;
    letter-spacing: 0.02em;
  }

  .spacer {
    flex: 1 1 auto;
  }

  .menu-wrap {
    position: relative;
  }

  .menu-backdrop {
    position: fixed;
    inset: 0;
    background: transparent;
    border: none;
    cursor: default;
    z-index: 4;
  }

  .menu {
    position: absolute;
    bottom: calc(100% + 6px);
    right: 0;
    min-width: calc(200px * var(--ctrl-scale));
    background: var(--bg-panel);
    border: 1px solid var(--border);
    border-radius: calc(6px * var(--ctrl-scale));
    padding: calc(6px * var(--ctrl-scale)) 0;
    box-shadow: 0 calc(8px * var(--ctrl-scale)) calc(24px * var(--ctrl-scale)) rgba(0, 0, 0, 0.5);
    z-index: 6;
    display: flex;
    flex-direction: column;
    gap: calc(2px * var(--ctrl-scale));
  }

  .menu-section {
    display: flex;
    flex-direction: column;
    padding: calc(4px * var(--ctrl-scale)) 0;
  }

  .menu-label {
    padding: calc(4px * var(--ctrl-scale)) calc(12px * var(--ctrl-scale));
    font-size: calc(11px * var(--ctrl-scale));
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: var(--text-secondary);
    font-weight: 700;
  }

  .menu-item {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: calc(8px * var(--ctrl-scale));
    padding: calc(6px * var(--ctrl-scale)) calc(12px * var(--ctrl-scale));
    border: none;
    background: transparent;
    color: var(--text-primary);
    font-size: calc(13px * var(--ctrl-scale));
    text-align: left;
    cursor: pointer;
    font-family: inherit;
    transition: background 150ms;
  }

  .menu-item svg {
    width: calc(14px * var(--ctrl-scale));
    height: calc(14px * var(--ctrl-scale));
  }

  .menu-item:hover {
    background: var(--bg-hover);
  }

  .menu-item--active {
    color: var(--accent);
  }

  .progress:focus-visible::before {
    box-shadow: 0 0 0 calc(2px * var(--ctrl-scale)) var(--accent);
  }
</style>