<script lang="ts">
  import { onMount, onDestroy } from 'svelte'
  import Hls from 'hls.js'
  import { emit, listen } from '@tauri-apps/api/event'
  import { isTauri } from '@tauri-apps/api/core'
  import { getCurrentWindow } from '@tauri-apps/api/window'
  import { PhysicalSize } from '@tauri-apps/api/dpi'

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

  interface InitPayload {
    url: string
    volume: number
    muted: boolean
  }
  interface StreamPayload {
    url: string
  }

  let videoEl: HTMLVideoElement | undefined = $state()
  let hls: Hls | null = null
  let muted = $state(false)
  let volume = $state(1)
  let loading = $state(true)
  let errorMsg = $state('')
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

  function loadSource(url: string): void {
    if (!videoEl) return
    loading = true
    errorMsg = ''
    needsGesture = false
    if (hls) { try { hls.destroy() } catch { /* ignore */ } hls = null }

    if (Hls.isSupported()) {
      const inst = new Hls({ enableWorker: true, lowLatencyMode: true, backBufferLength: 30 })
      hls = inst
      inst.on(Hls.Events.MANIFEST_PARSED, () => {
        loading = false
        videoEl?.play().catch(() => { needsGesture = true })
      })
      inst.on(Hls.Events.ERROR, (_e, data) => {
        if (!data.fatal) return
        errorMsg = 'Stream error'
        loading = false
      })
      inst.loadSource(url)
      inst.attachMedia(videoEl)
    } else if (videoEl.canPlayType('application/vnd.apple.mpegurl')) {
      videoEl.src = url
      videoEl.play().then(() => { loading = false }).catch(() => {
        needsGesture = true
        loading = false
      })
    } else {
      errorMsg = 'HLS not supported'
      loading = false
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

  async function gesturePlay(): Promise<void> {
    if (!videoEl) return
    needsGesture = false
    try { await videoEl.play() } catch { needsGesture = true }
  }

  async function emitClosedWithRect(): Promise<void> {
    if (!isTauri()) return
    let rect: { x: number; y: number; width: number; height: number } | undefined
    try {
      const win = getCurrentWindow()
      const pos = await win.outerPosition()
      const size = await win.outerSize()
      rect = { x: pos.x, y: pos.y, width: size.width, height: size.height }
    } catch {
      /* ignore — send closed without rect */
    }
    try { await emit(EV_CLOSED, { rect }) } catch { /* ignore */ }
  }

  async function requestClose(): Promise<void> {
    // `close()` emits a close-requested event; our onCloseRequested handler
    // fires (emits ks://pip-closed with the rect) and then lets the window
    // destroy. Calling close() (not destroy()) keeps the close path uniform
    // whether the user hits our close button, Escape, or the WM shortcut.
    if (!isTauri()) return
    try { await getCurrentWindow().close() } catch { /* ignore */ }
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
    hideTimer = setTimeout(() => { hideTimer = null; controlsVisible = false }, 2_500)
  }

  function onKeydown(e: KeyboardEvent): void {
    if (e.key === 'Escape') {
      e.preventDefault()
      void requestClose()
    } else if (e.key === 'm' || e.key === 'M') {
      toggleMuted()
    }
  }

  onMount(async () => {
    if (!isTauri()) { errorMsg = 'Not running in Tauri'; loading = false; return }
    const win = getCurrentWindow()

    // Re-assert always-on-top once the window is mapped. tao applies the
    // creation-time option via gtk_window_set_keep_above, which on Wayland is
    // a no-op (xdg-shell has no always-on-top), so this mainly solidifies the
    // state on X11. On KWin Wayland the only reliable fix is a Window Rule
    // (see README/AGENTS notes); nothing the app can do there.
    try { await win.setAlwaysOnTop(true) } catch { /* ignore */ }

    const uInit = await listen<InitPayload>(EV_INIT, (e) => {
      const p = e.payload
      volume = typeof p.volume === 'number' ? Math.max(0, Math.min(1, p.volume)) : 1
      muted = !!p.muted
      if (videoEl) { videoEl.volume = volume; videoEl.muted = muted }
      loadSource(p.url)
    })
    unlisteners.push(uInit)

    const uStream = await listen<StreamPayload>(EV_STREAM, (e) => {
      loadSource(e.payload.url)
    })
    unlisteners.push(uStream)

    const uDoClose = await listen(EV_DO_CLOSE, () => { void requestClose() })
    unlisteners.push(uDoClose)

    // Snap the window to exact 16:9 after a resize settles. setSize keeps the
    // top-left fixed, so width-authoritative snapping behaves cleanly for the
    // left/right edges and bottom corners (the handles we keep). The epsilon
    // check breaks the feedback loop once the window is already 16:9.
    try {
      const uResize = await win.onResized(({ payload }) => {
        const width = payload.width
        const height = payload.height
        if (Date.now() < suppressSnapUntil) return
        if (snapTimer) clearTimeout(snapTimer)
        snapTimer = setTimeout(() => {
          snapTimer = null
          const targetH = Math.round((width * 9) / 16)
          if (Math.abs(height - targetH) <= 1) return
          suppressSnapUntil = Date.now() + 500
          void win.setSize(new PhysicalSize(width, targetH)).catch(() => { /* ignore */ })
        }, 250)
      })
      unlisteners.push(uResize)
    } catch {
      /* ignore — aspect-lock is best-effort */
    }

    try {
      const uClose = await win.onCloseRequested(async () => {
        await emitClosedWithRect()
      })
      unlisteners.push(uClose)
    } catch {
      /* ignore — fallback pagehide below still emits closed */
    }

    // Fallback: if the webview is torn down without a close-requested event
    // (e.g. process exit), best-effort signal closed first.
    window.addEventListener('pagehide', () => { void emitClosedWithRect() })

    bumpControls()
    void emit(EV_READY)
  })

  onDestroy(() => {
    if (hideTimer) clearTimeout(hideTimer)
    if (snapTimer) clearTimeout(snapTimer)
    for (const u of unlisteners) { try { u() } catch { /* ignore */ } }
    unlisteners.length = 0
    if (hls) { try { hls.destroy() } catch { /* ignore */ } hls = null }
  })
</script>

<svelte:window onkeydown={onKeydown} onmousemove={bumpControls} />

<div
  class="pip-root"
  data-tauri-drag-region
  class:controls-visible={controlsVisible}
>
  <video
    bind:this={videoEl}
    class="pip-video"
    playsinline
    data-tauri-drag-region
    onclick={gesturePlay}
  ></video>

  {#if loading}
    <div class="pip-status" data-tauri-drag-region>Loading…</div>
  {/if}
  {#if errorMsg}
    <div class="pip-status pip-error" data-tauri-drag-region>{errorMsg}</div>
  {/if}
  {#if needsGesture && !errorMsg}
    <button type="button" class="pip-gesture" onclick={gesturePlay}>Tap for sound</button>
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
    <button
      type="button"
      class="pip-btn"
      onclick={toggleMuted}
      aria-label={muted ? 'Unmute' : 'Mute'}
      aria-pressed={muted}
    >
      {#if muted}
        <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
          <path d="M16.5 12c0-1.77-1.02-3.29-2.5-4.03v2.21l2.45 2.45c.03-.2.05-.41.05-.63zm2.5 0c0 .94-.2 1.82-.54 2.64l1.51 1.51A8.796 8.796 0 0 0 21 12c0-4.28-2.99-7.86-7-8.77v2.06c2.89.86 5 3.54 5 6.71zM4.27 3 3 4.27 7.73 9H3v6h4l5 5v-6.73l4.25 4.25c-.67.52-1.42.93-2.25 1.18v2.06a8.99 8.99 0 0 0 3.69-1.81L19.73 21 21 19.73l-9-9L4.27 3zM12 4 9.91 6.09 12 8.18V4z" fill="currentColor"/>
        </svg>
      {:else}
        <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
          <path d="M3 9v6h4l5 5V4L7 9H3zm13.5 3c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02zM14 3.23v2.06c2.89.86 5 3.54 5 6.71s-2.11 5.85-5 6.71v2.06c4.01-.91 7-4.49 7-8.77s-2.99-7.86-7-8.77z" fill="currentColor"/>
        </svg>
      {/if}
    </button>

    <input
      type="range"
      class="pip-volume"
      min="0"
      max="1"
      step="0.05"
      value={volume}
      aria-label="Volume"
      oninput={(e) => applyVolume(parseFloat((e.currentTarget as HTMLInputElement).value))}
    />

    <button
      type="button"
      class="pip-btn"
      onclick={requestClose}
      aria-label="Close picture in picture"
    >
      <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
        <path d="M19 6.41 17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z" fill="currentColor"/>
      </svg>
    </button>
  </div>
</div>

<style>
  :global(html), :global(body) {
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
    font: 600 13px/1 system-ui, sans-serif;
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
    font: 600 13px/1 system-ui, sans-serif;
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
    align-items: center;
    gap: 8px;
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
  .pip-btn,
  .pip-volume {
    pointer-events: auto;
  }
  /* Borderless resize handles. z-index 20 < controls (25) so buttons always
     win where they overlap; the bar is click-through so handles stay usable
     everywhere else. */
  .rz {
    position: absolute;
    z-index: 20;
  }
  .rz-left { top: 8px; bottom: 8px; left: 0; width: 6px; cursor: ew-resize; }
  .rz-right { top: 8px; bottom: 8px; right: 0; width: 6px; cursor: ew-resize; }
  .rz-bl { bottom: 0; left: 0; width: 12px; height: 12px; cursor: nesw-resize; }
  .rz-br { bottom: 0; right: 0; width: 12px; height: 12px; cursor: nwse-resize; }
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
    flex: 1 1 auto;
    min-width: 0;
    height: 4px;
    accent-color: #9147ff;
    cursor: pointer;
  }
</style>
