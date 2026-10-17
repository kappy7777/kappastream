<script lang="ts">
  // One live-stream tile in the multi-view grid. Each tile owns its OWN
  // playback engine + resolve lifecycle (a fresh `resolve_stream` call per
  // play), a local generation guard for stale-request discipline, live stall
  // recovery, and an authoritative offline-vs-transient split:
  //   - genuine offline (resolve returns offline, or a live→offline status
  //     poll) → the tile is CLOSED by the store (offline-close). A tile
  //     opened while the channel was offline stays, showing the offline
  //     overlay, and reloads when the status poll sees the channel live.
  //   - transient (resolve network error / hls fatal networkish error / manifest
  //     timeout) → status 'error' overlay + an automatic bounded-backoff retry
  //     (plus the overlay's Retry button), the tile is NOT closed (mirrors the
  //     single-stream path, which only surfaces 'offline' from an authoritative
  //     resolve result).
  //
  // The engine is hls.js OR the embedded native mpv engine (mpvEnabled).
  // Both cover the same video area (inset-0) and render the SAME HTML
  // overlay controls (the page paints over the native surface's aperture
  // hole); a native tile plays the RAW resolved URL through its own engine
  // id (multi-view = one mpv core per tile; see MultiView's id allocation).
  //
  // Audio authority (mirrors src/lib/pip-controller.svelte.ts): the authority
  // tile (the one the user clicked; NOT moved by chat-tab clicks) — its volume
  // slider + mute persist to `settings`, and it is audible by default.
  // Non-authority tiles are muted unless the user manually unmuted them
  // (`manualUnmute`), so several can play at once. Every tile's control bar
  // shows a volume slider (consistent overlays); on a non-authority tile it
  // drives that tile's OWN volume (never persisted). A forced mute (authority
  // moving away) is applied directly to the <video> via applyTileAudio and is
  // NEVER written to settings — persistence happens only in the explicit
  // control handlers (the authority tile's slider, an explicit unmute that must
  // clear a blocking global mute — see planTileMuteToggle), never on a
  // volumechange event.
  //
  // Resource cleanup: the resolve path uses streamlink's --stream-url mode, so
  // streamlink EXITS on its own after returning the playlist URL (managed via
  // kill_on_drop in resolve.rs) — it is NOT a persistent per-tile process. The
  // real per-tile resource is the hls.js instance, which is destroyed here on
  // channel change, tile close, and component teardown ( onDestroy). The video
  // element is paused + has its src cleared so no segment fetches outlive it.

  import { onDestroy, untrack } from 'svelte'
  import Hls from 'hls.js'
  import { invoke } from '@tauri-apps/api/core'
  import { settings } from './settings.svelte.ts'
  import { clearApertureHole, setApertureHole } from './native-aperture.svelte'
  import { toKsvodProxyUrl, shouldRecoverStallAfterPause } from './playback'
  import { PlaybackSession, resolveLiveStream } from './playback-session.svelte'
  import { GQL_REFRESH_INTERVAL_MS } from './gql'
  import { fetchLiveStatus } from './favorites.svelte'
  import { MpvBackend, type TileShortcutHandles } from './video-backend'
  import {
    tileStore,
    tileAudible,
    tileControlsIdle,
    nextTileRetryDelayMs,
    planTileMuteToggle,
    planTileVolumeInput,
    applyTileAudio,
    type TileState,
  } from './tile-store.svelte'
  import { tooltip } from './tooltip.ts'
  import { nextVolume } from './volume'
  import { effectiveQualities, mpvQualities, qualityLabel } from './qualities'
  import { t } from './i18n/index.svelte'

  interface Props {
    tile: TileState
    isAuthority: boolean
    isWindows: boolean
    /** True while THIS tile is being dragged (visual affordance). */
    isDragging: boolean
    /** True while another tile is being dragged over this one (drop highlight). */
    isDropTarget: boolean
    /** Reports THIS tile's shortcut handles (its <video>, or its native
     *  backend while the native engine plays it, plus its togglePlay) to
     *  MultiView whenever they change; null on teardown. MultiView keys the
     *  reports by tile id and forwards the AUDIO-AUTHORITY tile's set to
     *  App — reporting per tile (rather than every tile writing three
     *  shared slots) is what keeps a non-authority tile's effect from
     *  wiping the authority's handles. */
    onTileHandles: (tileId: string, handles: TileShortcutHandles | null) => void
    /** Tile activation (video-surface click) — MultiView routes it through
     *  its merged-chats policy (a merged tile moves only audio authority). */
    onTileActivate: (tileId: string) => void
    /** Drag-handle pointer-down — MultiView owns hit-testing for the drop target. */
    onTileDragStart: (tileId: string, e: PointerEvent) => void
    /** CSS grid-area shorthand for this tile's placement (empty = auto-place). */
    gridArea?: string
    /** Native-engine tiles: play through embedded mpv (MultiView allocates
     *  the engine id; availability + the setting are checked there). */
    mpvEnabled: boolean
    /** This tile's native engine id (only meaningful with mpvEnabled). */
    mpvId: number
    /** Pixels to inset the NATIVE SURFACE on each side (1 where a splitter
     *  line straddles this tile's edge). hls draws the 2px seam line OVER
     *  the video; the native surface would COVER it (the surface sits above
     *  the whole webview), so the surface shrinks 1px per seam side and the
     *  real page line stays visible — identical seams in both engines. */
    seams: { top: number; right: number; bottom: number; left: number }
  }
  const {
    tile,
    isAuthority,
    isWindows,
    isDragging,
    isDropTarget,
    onTileHandles,
    onTileActivate,
    onTileDragStart,
    gridArea,
    mpvEnabled,
    mpvId,
    seams,
  }: Props = $props()

  let videoEl = $state<HTMLVideoElement | undefined>(undefined)
  let tileEl = $state<HTMLElement | undefined>(undefined)
  /** Quality variants this tile's channel ACTUALLY offers (the
   *  stream_qualities streamlink probe), or null while unknown — the gear
   *  menu offers only real variants (a channel transcoding 720p60
   *  but not 720p must not offer plain "720p"). Unknown → full vocabulary. */
  let availableQualities = $state<string[] | null>(null)
  /** The video REGION element — the native surface's rect anchor (the
   *  surface covers exactly this rect, inset by the seam props). */
  let areaEl = $state<HTMLElement | undefined>(undefined)
  // The playback engine (hls.js attach/manifest-timeout/stall-recovery/
  // teardown) lives in the shared PlaybackSession — one per tile. This
  // component keeps only tile POLICY: which quality, offline-close, the
  // status overlay and the audio authority.
  const playback = new PlaybackSession()
  let menuOpen = $state(false)

  // ---- Native engine (embedded mpv) -------------------------------------
  // One backend per tile, bound to the tile's engine id; created while
  // mpvEnabled holds and disposed on the flip (dispose stops the engine +
  // hides its surface). The <video> element stays mounted either way — it
  // is the hls fallback target and the input/hit-test surface.
  let mpvBackend = $state<MpvBackend | null>(null)
  /** True while the CURRENT load plays on the native engine (drives the
   *  audio-application + shortcut-target branches). */
  let nativeActive = $state(false)
  /** The tile's engine has presented its first frame — the aperture hole
   *  opens only then, mirroring the Rust-side surface reveal (see
   *  App.svelte's nativePresented). */
  let nativePresented = $state(false)
  /** The last rect pushed to mpv_set_rect for this tile's engine (visual
   *  px) — the aperture hole rides the exact same geometry. */
  let nativeTileRect = $state<{ x: number; y: number; w: number; h: number } | null>(null)
  $effect(() => {
    if (mpvEnabled && !mpvBackend) {
      mpvBackend = new MpvBackend(mpvId)
    } else if (!mpvEnabled && mpvBackend) {
      const stale = mpvBackend
      mpvBackend = null
      nativeActive = false
      nativePresented = false
      void stale.dispose()
    }
  })
  /** The list every quality surface offers (the HTML gear and its reverse
   *  map): on the native engine audio_only is absent — the native surface
   *  has no video track to present, so a tile that switched to it would
   *  show nothing in-frame (the menu must match the engine anyway). */
  const menuQualities = $derived(mpvBackend ? mpvQualities(availableQualities) : effectiveQualities(availableQualities))

  // Native playback state → tile status. An error/ended mid-playback hides
  // the surface (teardown stops the engine) so the status overlay shows.
  $effect(() => {
    const b = mpvBackend
    if (!b) return
    const un = [
      b.on('playing', () => {
        nativePresented = true
        tileStore.setStatus(tile.id, 'playing')
      }),
      b.on('waiting', () => tileStore.setStatus(tile.id, 'loading')),
      b.on('error', () => {
        playback.teardown(videoEl)
        nativeActive = false
        nativePresented = false
        failTile(b.lastError ?? 'native engine error')
      }),
      b.on('ended', () => {
        // A live stream that ends went offline; the status poll closes the
        // tile (offline-close) — meanwhile show it uncovered.
        playback.teardown(videoEl)
        nativeActive = false
        nativePresented = false
        tileStore.setStatus(tile.id, 'offline')
      }),
    ]
    return () => {
      for (const u of un) u()
    }
  })

  // The tile's controls are the SAME HTML overlay on both engines (it
  // paints over the native surface's aperture hole); no engine-side OSD is
  // fed or listened to.
  // Which variants this tile's channel ACTUALLY offers (stream_qualities
  // probe; one listing per channel change — not per quality switch).
  // Fire-and-forget: unknown (null) degrades to the full vocabulary.
  $effect(() => {
    const channel = tile.channel
    availableQualities = null
    if (!channel) return
    let disposed = false
    void invoke('stream_qualities', { channel, lowLatency: settings.lowLatency })
      .then((r) => {
        if (!disposed && tile.channel === channel) {
          availableQualities = Array.isArray(r) ? (r as string[]) : null
        }
      })
      .catch(() => {})
    return () => {
      disposed = true
    }
  })
  // Audibility (audio authority — see tileAudible): the authority tile follows
  // the global mute; a non-authority tile is audible only if the user manually
  // unmuted it. Global mute silences all.
  const audible = $derived(tileAudible(isAuthority, tile.manualUnmute, settings.muted))

  function isCurrent(gen: number, q: string): boolean {
    return gen === playback.generation && tile.quality === q
  }

  async function attach(
    channel: string,
    q: string,
    url: string,
    gen: number,
  ): Promise<{ ok: true } | { ok: false; error: string }> {
    const el = videoEl
    if (!el) return { ok: false, error: 'no video element' }
    const current = () => isCurrent(gen, q)
    if (!current()) return { ok: false, error: 'stale' }
    // Native engine first: the RAW resolved URL (mpv fetches it itself — no
    // ksvod proxy). A failed load falls through to the hls path for THIS
    // item (mirrors the single-stream policy in App.svelte). The load
    // carries the MODEL-driven audio state (same math as the audio effect):
    // the backend's local default is unmuted, so loading bare would play
    // audio before the effect corrects it (the watch-together all-audible
    // bug).
    const mpv = mpvBackend
    if (mpv) {
      const res = await playback.attachMpv(mpv, {
        url,
        kind: 'live',
        hwdec: settings.mpvHwdec,
        volume: isAuthority ? settings.volume : tile.volume,
        muted: !tileAudible(isAuthority, tile.manualUnmute, settings.muted),
        title: tile.channel,
      })
      if (res.ok) {
        nativeActive = true
        return res
      }
    }
    const sourceUrl = isWindows ? toKsvodProxyUrl(url, isWindows) : url
    if (Hls.isSupported()) {
      return await playback.attachHls({
        video: el,
        url: sourceUrl,
        lowLatency: settings.lowLatency,
        isCurrent: current,
        onManifestParsed: () => tileStore.setStatus(tile.id, 'loading'),
        onPlayed: () => tileStore.setStatus(tile.id, 'playing'),
        // A blocked autoplay still counts as "playing" for a tile (the tile
        // <video> is autoplay+muted; the overlay only covers
        // loading/offline/error) — the old local copy did the same.
        onPlayBlocked: () => tileStore.setStatus(tile.id, 'playing'),
        // Mid-playback death: same policy as the native engine's 'error'
        // handler. 'error' (not 'offline') because hls.js cannot tell a
        // 404ing ended playlist from a real network fault — the status
        // poll's offline-close removes the tile when the channel actually
        // went offline, so an honest error overlay is the safe default.
        onFatalAfterStart: (error) => failTile(error),
      })
    }
    if (el.canPlayType('application/vnd.apple.mpegurl')) {
      return await playback.attachNative(el, sourceUrl, {
        isCurrent: current,
        errorPrefix: 'native HLS play failed: ',
        onPlayed: () => tileStore.setStatus(tile.id, 'playing'),
      })
    }
    return { ok: false, error: 'HLS playback is not supported' }
  }

  // ---- error retry (bounded backoff) --------------------------------------
  // A transient failure leaves the tile alive with an error overlay; the
  // automatic retry doubles its delay per consecutive failure (capped by
  // nextTileRetryDelayMs) so a longer outage never strands a dead tile in
  // the grid while a short one costs only a few early attempts. The attempt
  // count resets on success, on a channel/quality/engine change, and on the
  // overlay's manual Retry button (which retries immediately).
  let retryTimer: ReturnType<typeof setTimeout> | null = null
  let retryAttempt = 0

  function clearRetry(): void {
    if (retryTimer) {
      clearTimeout(retryTimer)
      retryTimer = null
    }
  }

  function failTile(error: string): void {
    tileStore.setStatus(tile.id, 'error', error)
    clearRetry()
    const delay = nextTileRetryDelayMs(retryAttempt)
    retryAttempt++
    retryTimer = setTimeout(() => {
      retryTimer = null
      void load(tile.quality)
    }, delay)
  }

  function retryNow(): void {
    clearRetry()
    retryAttempt = 0
    void load(tile.quality)
  }

  async function load(q: string): Promise<void> {
    const gen = playback.nextGeneration()
    tileStore.setStatus(tile.id, 'loading')
    playback.clearStallRecover()
    playback.userPaused = false
    const resolved = await resolveLiveStream(tile.channel, q, settings.lowLatency)
    if (!isCurrent(gen, q)) return
    if (!resolved.ok) {
      if (resolved.offline) {
        tileStore.setStatus(tile.id, 'offline')
        return
      }
      if (resolved.unavailable && q !== 'best') {
        tileStore.setQuality(tile.id, 'best')
        await load('best')
        return
      }
      failTile(resolved.error ?? 'failed to resolve stream')
      return
    }
    const res = await attach(tile.channel, q, resolved.url, gen)
    if (!isCurrent(gen, q)) return
    if (!res.ok) {
      failTile(res.error)
      return
    }
    retryAttempt = 0
  }

  function changeQuality(q: string): void {
    menuOpen = false
    if (q === tile.quality) return
    tileStore.setQuality(tile.id, q)
    playback.teardown(videoEl)
    void load(q)
  }

  /** The paused read for the shortcut/media-key handles (engine-aware). */
  function isPaused(): boolean {
    const b = mpvBackend
    if (b && nativeActive) return b.paused
    return videoEl ? videoEl.paused : true
  }

  function togglePlay(): void {
    const b = mpvBackend
    if (b && nativeActive) {
      if (b.paused) {
        playback.userPaused = false
        void b.play()
      } else {
        playback.userPaused = true
        b.pause()
      }
      return
    }
    const el = videoEl
    if (!el) return
    if (el.paused) {
      playback.userPaused = false
      void el.play().catch(() => {
        /* ignore */
      })
    } else {
      playback.userPaused = true
      el.pause()
    }
  }

  // Per-tile mute. The toggle direction comes from planTileMuteToggle, which
  // derives it from the tile's EFFECTIVE audibility (the same value the icon
  // shows) — flipping the raw manualUnmute flag under a global mute was the
  // "unmute on a non-authority tile sometimes does nothing" bug: the global
  // mute kept overriding the flag. The authority tile drives the GLOBAL mute
  // (persisted); a non-authority tile flips its local manualUnmute (never
  // persisted) and, only when the global mute is what silences it, clears that
  // mute too (an explicit user unmute — the one settings write this path may
  // make, mirroring PiP's explicit-control persistence).
  function toggleMute(): void {
    const plan = planTileMuteToggle(isAuthority, tile.manualUnmute, settings.muted)
    if (plan.manualUnmute !== undefined) tileStore.setManualUnmute(tile.id, plan.manualUnmute)
    if (plan.globalMuted !== undefined) settings.setMuted(plan.globalMuted)
  }
  // Volume input from the tile's slider (rendered on EVERY tile, matching the
  // authority overlay's layout). The authority slider drives the GLOBAL
  // settings.volume (persisted — the authority is the audio source); a
  // non-authority slider drives the tile's OWN per-tile volume (never
  // persisted). On both paths dragging above 0 is an explicit unmute — it
  // mirrors PlayerControls' `if (v > 0 && video.muted) video.muted = false`,
  // so the slider can never be dragged up with no audible effect.
  function onVolumeInput(v: number): void {
    if (isAuthority) {
      settings.setVolume(v)
      if (v > 0 && settings.muted) settings.setMuted(false)
      return
    }
    const plan = planTileVolumeInput(v, settings.muted)
    tileStore.setTileVolume(tile.id, plan.tileVolume)
    tileStore.setManualUnmute(tile.id, plan.manualUnmute)
    if (plan.globalMuted !== undefined) settings.setMuted(plan.globalMuted)
  }

  function closeTile(): void {
    playback.teardown(videoEl)
    tileStore.close(tile.id)
  }

  // ---- video event handlers (live stall recovery) ----
  function onWaiting(): void {
    if (videoEl) playback.scheduleStallRecover(videoEl)
  }
  function onPlaying(): void {
    playback.clearStallRecover()
    playback.userPaused = false
  }
  // A tile is always live, hence the literal true.
  function onPause(): void {
    if (shouldRecoverStallAfterPause(true, playback.userPaused) && videoEl) playback.scheduleStallRecover(videoEl)
  }
  // A live tile that runs to the end of its playlist went offline — same
  // policy as the native engine's 'ended' handler: uncover the tile so the
  // offline overlay shows while the status poll's offline-close removes it.
  function onEnded(): void {
    playback.teardown(videoEl)
    tileStore.setStatus(tile.id, 'offline')
  }

  // ---- (re)load ONLY on a genuine channel/quality/low-latency/engine change ----
  // This effect is the fix for "opening a new channel reloads all tiles": it
  // is scoped strictly to THIS tile's own identity (videoEl + tile.channel +
  // tile.quality + settings.lowLatency + the native-engine selection) and —
  // crucially — tears down + reloads ONLY when one of those actually changed
  // (or on first mount). It is therefore idempotent: adding/reordering a
  // SIBLING cannot re-trigger it (the {#each} is keyed by the stable tile.id,
  // and none of these deps change for an existing tile on a sibling add), and
  // even a spurious re-run is a no-op. prevChannel is seeded to a sentinel so
  // the first run loads. An engine flip (mpvEnabled) also reloads — the two
  // backends attach differently and a flip must re-home the stream.
  let prevChannel = ''
  let prevQuality = ''
  let prevLowLatency: boolean | null = null
  let prevMpvEnabled: boolean | null = null
  $effect(() => {
    const el = videoEl
    if (!el) return
    const ch = tile.channel
    const q = tile.quality
    const ll = settings.lowLatency
    const mpv = mpvEnabled
    const firstRun = prevLowLatency === null
    const channelChanged = ch !== prevChannel
    const changed = firstRun || channelChanged || q !== prevQuality || ll !== prevLowLatency || mpv !== prevMpvEnabled
    prevChannel = ch
    prevQuality = q
    prevLowLatency = ll
    prevMpvEnabled = mpv
    if (!changed) return // idempotent guard — never reload on an unchanged re-run
    clearRetry()
    retryAttempt = 0
    playback.teardown(el)
    nativeActive = false
    nativePresented = false
    if (channelChanged && !firstRun) tileStore.setStatus(tile.id, 'loading')
    void load(q)
  })

  // ---- audio authority: apply audible/volume imperatively (no persist) ----
  // Centralised in applyTileAudio (tile-store.svelte): the authority tile uses
  // the global settings.volume; a non-authority tile uses its OWN per-tile
  // volume (nudged by scroll-wheel). A forced mute (authority moving away)
  // is applied directly and is never written to settings. On the native
  // engine the SAME math drives the backend (mpv's volume/mute) instead of
  // the inert <video> element. Re-running this effect (any dependency
  // change) is idempotent — the target always ends up matching tileAudible
  // of the current store state.
  $effect(() => {
    const el = videoEl
    if (!el) return
    const inputs = {
      isAuthority,
      manualUnmute: tile.manualUnmute,
      globalMuted: settings.muted,
      globalVolume: settings.volume,
      tileVolume: tile.volume,
    }
    const b = mpvBackend
    if (b && nativeActive) {
      b.setMuted(!tileAudible(inputs.isAuthority, inputs.manualUnmute, inputs.globalMuted))
      b.setVolume(inputs.isAuthority ? inputs.globalVolume : inputs.tileVolume)
      return
    }
    applyTileAudio(el, inputs)
  })

  // ---- native surface geometry ---------------------------------------------
  // The native surface covers the VIDEO AREA (inset by the seam props so
  // the splitter lines stay visible). Event-driven like App.svelte's
  // single-player pusher, coalesced to one measure per animation frame;
  // identical keys skip the invoke (the Rust side dedupes too).
  // Which signal covers which motion source:
  //  - the ResizeObserver on the video area: every SIZE change — splitter
  //    drags (the grid template is inline style), window resizes, tile
  //    add/close re-flows, sidebar and chat resizes (the grid container
  //    resizes with them);
  //  - the gridArea / seams prop reads: POSITION-only moves — a tile swap
  //    or ◀/▶ reorder at a symmetric split moves the surface without
  //    resizing it, and a tile-count change re-insets the seams;
  //  - the documentElement observer + the settings.uiScale read: a zoom
  //    change moves the stage in visual px without the CSS-px size change
  //    the stage observer would report.
  $effect(() => {
    if (!nativeActive) return
    const stage = areaEl
    if (!stage) return
    const id = mpvId
    void gridArea
    void seams.top
    void seams.right
    void seams.bottom
    void seams.left
    void settings.uiScale
    let frame = 0
    let lastKey = ''
    const push = (): void => {
      frame = 0
      if (!stage.isConnected) return
      const r = stage.getBoundingClientRect()
      if (r.width < 2 || r.height < 2) return
      // Visual px (zoom included) map 1:1 onto the native window coordinates
      // mpv_set_rect expects — the same reasoning as App.svelte's pusher.
      // The seam insets shrink the surface off the splitter lines (see the
      // prop comment) so the page's 2px seam line stays visible, matching
      // the hls.js grid exactly.
      const x = Math.round(r.left) + seams.left
      const y = Math.round(r.top) + seams.top
      const w = Math.round(r.width) - seams.left - seams.right
      const h = Math.round(r.height) - seams.top - seams.bottom
      const key = `${x},${y},${w},${h}`
      if (key === lastKey) return
      lastKey = key
      nativeTileRect = { x, y, w, h }
      void invoke('mpv_set_rect', {
        id,
        x,
        y,
        w,
        h,
      }).catch(() => {})
    }
    const schedule = (): void => {
      if (!frame) frame = requestAnimationFrame(push)
    }
    const ro = new ResizeObserver(schedule)
    ro.observe(stage)
    ro.observe(document.documentElement)
    schedule()
    return () => {
      if (frame) cancelAnimationFrame(frame)
      ro.disconnect()
    }
  })

  // The tile's aperture hole (see App.svelte's engine-0 effect): rides the
  // exact rect the pusher sent and opens only once the engine presented,
  // so the tile's loading/error overlays render over the themed page.
  $effect(() => {
    if (!nativeActive || !nativePresented) {
      clearApertureHole(mpvId)
      return
    }
    const r = nativeTileRect
    if (r) setApertureHole(mpvId, r)
    else clearApertureHole(mpvId)
  })
  // Unmount safety: a tile's hole must never outlive it. Engine ids never
  // move on a drag-reorder (MultiView's free list reassigns only on tile
  // close), but a closed tile's id goes back to the pool — a stale hole
  // keyed by it must not linger into whichever tile claims it next.
  $effect(() => () => clearApertureHole(mpvId))

  // ---- native surface pointer input -----------------------------------------
  // The page is the topmost window, so pointer input over a native tile
  // reaches the PAGE: the inset-0 .mv-tile-surface button underneath the
  // overlays carries tile activation, the wheel rides the section-level
  // scroll-volume handler below (engine-agnostic — the audio-apply effect
  // above forwards model writes to whichever backend plays the tile), and
  // the HTML controls handle everything else. No events are forwarded into
  // the engine.

  // ---- scroll-to-change-volume (reuses the shared nextVolume math that the
  // single-stream PlayerControls also uses). Scrolling a tile nudges THAT tile's
  // volume only:
  //   - authority tile → global settings.volume (persisted, it is the authority)
  //   - non-authority tile → its own per-tile volume; scrolling UP an inaudible
  //     tile unmutes it (manualUnmute=true, so it plays alongside the authority
  //     one — and if the global mute is what silences it, clears that too, same
  //     explicit-unmute rule as toggleMute), scrolling DOWN to 0 mutes it again.
  //     Mirrors the single-stream "scroll on a muted video unmutes" behaviour.
  function onWheel(e: WheelEvent): void {
    e.preventDefault()
    const dir = e.deltaY < 0 ? 1 : -1
    if (isAuthority) {
      settings.setVolume(nextVolume(settings.volume, dir))
      return
    }
    const current = tile.manualUnmute ? tile.volume : 0
    const next = nextVolume(current, dir)
    const plan = planTileVolumeInput(next, settings.muted)
    tileStore.setTileVolume(tile.id, plan.tileVolume)
    tileStore.setManualUnmute(tile.id, plan.manualUnmute)
    if (plan.globalMuted !== undefined) settings.setMuted(plan.globalMuted)
  }
  // Attach the wheel listener as NON-passive so preventDefault() can stop the
  // page/tile scroll (matches PlayerControls' { passive: false }). Bound to the
  // tile section so a wheel anywhere over the tile (incl. over the focus surface
  // that overlays the <video>) reaches it.
  $effect(() => {
    const el = tileEl
    if (!el) return
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  })

  // Report THIS tile's shortcut handles (its <video>, or its native backend
  // while the native engine plays it, plus its togglePlay — the TILE
  // session's userPaused flag is what the tile's own stall-recovery watcher
  // respects). MultiView keys the reports by tile id and forwards the AUDIO
  // AUTHORITY tile's set to App; authority selection lives there so a
  // sibling's report can never blank the authority's handles (the shared
  // three-slot wiring did — K/space/F/arrows went dead the moment a second
  // tile opened).
  $effect(() => {
    const el = videoEl
    if (!el) return
    if (nativeActive && mpvBackend) {
      onTileHandles(tile.id, {
        video: null,
        backend: mpvBackend,
        engineId: mpvId,
        controls: { togglePlay, isPaused },
      })
    } else {
      onTileHandles(tile.id, {
        video: el,
        backend: null,
        engineId: null,
        controls: { togglePlay, isPaused },
      })
    }
  })

  // ---- offline-close polling ----
  // Periodically check the channel's live status. A genuine live→offline
  // transition closes the tile (handled by the store); a transient GQL error
  // (state 'error') is ignored by the store — the tile keeps its last-known
  // status. This is the authoritative offline signal that distinguishes a real
  // outage from a transient network/hls hiccup (which only sets status 'error'
  // + retries). fetchLiveStatus never throws (it returns state 'error').
  let pollTimer: ReturnType<typeof setInterval> | null = null
  let pollToken = 0
  async function pollOnce(): Promise<void> {
    const my = ++pollToken
    const s = await fetchLiveStatus(tile.channel)
    if (my !== pollToken) return
    tileStore.setLiveStatus(tile.id, s)
  }
  $effect(() => {
    pollToken++ // invalidate any in-flight poll from a prior channel
    void pollOnce()
    pollTimer = setInterval(() => {
      void pollOnce()
    }, GQL_REFRESH_INTERVAL_MS)
    return () => {
      if (pollTimer) {
        clearInterval(pollTimer)
        pollTimer = null
      }
    }
  })

  // Cover art for this tile's native engine (desktop media widgets show it
  // for the audio authority's stream; the MPRIS service downloads + caches
  // the avatar itself and dedupes unchanged URLs, so re-sending on every
  // status refresh is free). Reject-safe: the command only exists in Linux
  // builds with the engine.
  $effect(() => {
    if (!mpvEnabled) return
    const s = tile.liveStatus
    const url = s.state === 'live' || s.state === 'offline' ? s.avatarUrl || null : null
    void invoke('mpris_set_art', { id: mpvId, url }).catch(() => {})
  })

  // A tile sitting on the offline overlay reloads when the poll sees the
  // channel live again — a tile opened on an offline channel, or a stream
  // end the poll hasn't flipped to offline yet (that later flip costs one
  // extra resolve at most, and the real offline-close removes the tile).
  // The reload's own status → 'loading' write un-arms this effect.
  $effect(() => {
    if (tile.status !== 'offline') return
    if (tile.liveStatus.state !== 'live') return
    untrack(() => {
      clearRetry()
      retryAttempt = 0
      void load(tile.quality)
    })
  })

  onDestroy(() => {
    clearRetry()
    playback.dispose(videoEl)
    const b = mpvBackend
    mpvBackend = null
    if (b) void b.dispose() // unsubscribes + mpv_stop (hides the surface)
    if (pollTimer) clearInterval(pollTimer)
    onTileHandles(tile.id, null)
  })

  // Touch + mouse interaction for control visibility (auto-hide). The
  // activity timestamp is deliberately NOT $state: bump() fires on every
  // pointermove, and a reactive read would tear the interval down and
  // recreate it on each move. The tick reads the plain variable directly;
  // only controlsShown (the reveal) needs reactivity.
  let lastActivity = Date.now()
  let controlsShown = $state(true)
  function bump(): void {
    lastActivity = Date.now()
    controlsShown = true
  }
  $effect(() => {
    const id = setInterval(() => {
      if (tileControlsIdle(Date.now(), lastActivity)) controlsShown = false
    }, 400)
    return () => clearInterval(id)
  })

  // The auto-hiding overlay chrome (bar, label, drag handle) behaves the
  // same on both engines: it paints over the native surface's aperture hole
  // exactly like it paints over the hls <video>.
  const htmlControls = $derived(controlsShown)

  const showOverlay = $derived(tile.status === 'loading' || tile.status === 'offline' || tile.status === 'error')
</script>

<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
<!-- svelte-ignore a11y_click_events_have_key_events -->
<!-- mv-tile--authority carries no visual style: the audio authority is
     marked by the status bar row + the channel label dim only (an accent
     ring would paint over the native video's aperture edges). The class
     stays as a semantic/test hook. -->
<section
  bind:this={tileEl}
  data-tile-id={tile.id}
  class="mv-tile"
  class:mv-tile--authority={isAuthority}
  class:mv-tile--native={nativeActive}
  class:mv-tile--dragging={isDragging}
  class:mv-tile--drop-target={isDropTarget}
  style={gridArea ? `grid-area:${gridArea};` : undefined}
  role="group"
  aria-label={tile.channel}
  onmousemove={bump}
  onclick={bump}
>
  <!-- The video REGION — absolute inset-0 in BOTH engines (the mpv surface
       covers exactly this rect). The control bar / label / drag handle are
       page UI painting over either engine (htmlControls). -->
  <div class="mv-video-area" bind:this={areaEl}>
    <video
      bind:this={videoEl}
      class="mv-video"
      autoplay
      muted
      playsinline
      onwaiting={onWaiting}
      onplaying={onPlaying}
      onpause={onPause}
      onended={onEnded}
    ></video>

    <button
      type="button"
      class="mv-tile-surface"
      aria-label={isAuthority ? t('mv_focusedTile') : t('mv_focusTile')}
      onclick={() => onTileActivate(tile.id)}
    ></button>

    <!-- Drag handle (pointer-events): grabbing here starts a reorder. Deliberately
         a separate element from the <video> so HTML5/native drag never touches the
         player or its controls. Keyboard users get the ◀/▶ reorder buttons below.
         Auto-hides with the rest of the tile overlay (controlsShown). -->
    {#if htmlControls}
      <button
        type="button"
        class="mv-drag-handle"
        aria-label={t('mv_dragTile')}
        use:tooltip={t('mv_dragTile')}
        onpointerdown={(e) => onTileDragStart(tile.id, e)}
      >
        <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true" fill="currentColor"
          ><circle cx="5" cy="4" r="1.3" /><circle cx="11" cy="4" r="1.3" /><circle cx="5" cy="8" r="1.3" /><circle
            cx="11"
            cy="8"
            r="1.3"
          /><circle cx="5" cy="12" r="1.3" /><circle cx="11" cy="12" r="1.3" /></svg
        >
      </button>
    {/if}

    {#if htmlControls}
      <div class="mv-tile-channel" class:mv-tile-channel--dim={!isAuthority}>{tile.channel}</div>
    {/if}

    {#if showOverlay}
      <div class="mv-tile-overlay">
        {#if tile.status === 'loading'}
          <div class="mv-spinner" aria-hidden="true"></div>
        {:else if tile.status === 'offline'}
          <span class="mv-overlay-title">{t('player_offline')}</span>
          <button type="button" class="mv-overlay-retry" onclick={retryNow}>{t('retry')}</button>
        {:else if tile.status === 'error'}
          <span class="mv-overlay-title">{t('player_streamError')}</span>
          <button type="button" class="mv-overlay-retry" onclick={retryNow}>{t('retry')}</button>
        {/if}
      </div>
    {/if}
  </div>

  {#if htmlControls}
    <!-- The auto-hiding gradient bar OVER the video — same markup on both
         engines (it paints over the native surface's aperture hole). -->
    <div class="mv-tile-controls">
      <button type="button" class="mv-ctrl" onclick={togglePlay} aria-label={t('pc_play')} use:tooltip={t('pc_play')}>
        <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"
          ><path d="M8 5v14l11-7z" fill="currentColor" /></svg
        >
      </button>
      <button
        type="button"
        class="mv-ctrl"
        class:mv-ctrl--on={audible}
        onclick={toggleMute}
        aria-label={audible ? t('pc_mute') : t('pc_unmute')}
        use:tooltip={isAuthority ? (audible ? t('pc_mute') : t('pc_unmute')) : t('mv_listenAlong')}
      >
        {#if !audible}
          <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"
            ><path
              d="M3 9v6h4l5 5V4L7 9H3zm13.5 3l2.7-2.7-1.4-1.4L15 10.6l-2.8-2.8-1.4 1.4L13.6 12l-2.8 2.8 1.4 1.4L15 13.4l2.7 2.7 1.4-1.4L16.4 12z"
              fill="currentColor"
            /></svg
          >
        {:else}
          <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"
            ><path d="M3 9v6h4l5 5V4L7 9H3zm11 .2v5.6c1.5-.5 2.5-1.9 2.5-3.5s-1-3-2.5-3.5z" fill="currentColor" /></svg
          >
        {/if}
      </button>

      <input
        class="mv-volume"
        type="range"
        min="0"
        max="1"
        step="0.05"
        value={isAuthority ? (settings.muted ? 0 : settings.volume) : audible ? tile.volume : 0}
        oninput={(e) => onVolumeInput(parseFloat((e.currentTarget as HTMLInputElement).value))}
        aria-label={t('volume')}
      />

      <div class="mv-menu-wrap">
        <button
          type="button"
          class="mv-ctrl"
          onclick={() => (menuOpen = !menuOpen)}
          aria-label={t('quality')}
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          use:tooltip={t('quality')}
        >
          <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"
            ><path
              d="M19.14 12.94c.04-.31.06-.62.06-.94s-.02-.63-.07-.94l2.03-1.58c.18-.14.23-.41.12-.61l-1.92-3.32c-.12-.22-.37-.29-.59-.22l-2.39.96c-.5-.38-1.03-.7-1.62-.94l-.36-2.54c-.04-.24-.24-.41-.48-.41h-3.84c-.24 0-.43.17-.47.41l-.36 2.54c-.59.24-1.13.57-1.62.94l-2.39-.96c-.22-.08-.47 0-.59.22L2.74 8.87c-.12.21-.08.47.12.61l2.03 1.58c-.05.31-.09.63-.09.94s.02.63.07.94l-2.03 1.58c-.18.14-.23.41-.12.61l1.92 3.32c.12.22.37.29.59.22l2.39-.96c.5.38 1.03.7 1.62.94l.36 2.54c.05.24.24.41.48.41h3.84c.24 0 .44-.17.47-.41l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.22.08.47 0 .59-.22l1.92-3.32c.12-.22.07-.47-.12-.61l-2.01-1.58zM12 15.6c-1.98 0-3.6-1.62-3.6-3.6s1.62-3.6 3.6-3.6 3.6 1.62 3.6 3.6-1.62 3.6-3.6 3.6z"
              fill="currentColor"
            /></svg
          >
        </button>
        {#if menuOpen}
          <button
            type="button"
            class="mv-menu-backdrop"
            onclick={() => (menuOpen = false)}
            aria-label={t('pc_closeMenu')}
          ></button>
          <div class="mv-menu" role="menu">
            {#each menuQualities as qid (qid)}
              <button
                type="button"
                class="mv-menu-item"
                class:mv-menu-item--active={tile.quality === qid}
                role="menuitemradio"
                aria-checked={tile.quality === qid}
                onclick={() => changeQuality(qid)}
              >
                <span>{qualityLabel(qid)}</span>
                {#if tile.quality === qid}<svg viewBox="0 0 24 24" width="12" height="12" aria-hidden="true"
                    ><path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41L9 16.17z" fill="currentColor" /></svg
                  >{/if}
              </button>
            {/each}
          </div>
        {/if}
      </div>

      <span class="mv-spacer"></span>

      {#if nativeActive}
        <!-- Engine marker mirroring the single-view bar's badge: this
             tile's playback runs on the native engine. Proper noun, not
             translatable prose. -->
        <span class="mv-engine-badge" aria-label="mpv">mpv</span>
      {/if}

      <!-- Keyboard-accessible reorder (the drag handle is mouse/pointer only).
           ◀/▶ swap this tile with its neighbour; focus stays on the button. -->
      <button
        type="button"
        class="mv-ctrl mv-reorder"
        onclick={() => tileStore.move(tile.id, -1)}
        aria-label={t('mv_moveLeft')}
        use:tooltip={t('mv_moveLeft')}
      >
        <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"
          ><path d="M14 6l-6 6 6 6V6z" fill="currentColor" /></svg
        >
      </button>
      <button
        type="button"
        class="mv-ctrl mv-reorder"
        onclick={() => tileStore.move(tile.id, 1)}
        aria-label={t('mv_moveRight')}
        use:tooltip={t('mv_moveRight')}
      >
        <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"
          ><path d="M10 6l6 6-6 6V6z" fill="currentColor" /></svg
        >
      </button>

      <button
        type="button"
        class="mv-ctrl mv-close"
        onclick={closeTile}
        aria-label={t('mv_closeTile')}
        use:tooltip={t('mv_closeTile')}
      >
        <svg
          viewBox="0 0 24 24"
          width="14"
          height="14"
          aria-hidden="true"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18" /></svg
        >
      </button>
    </div>
  {/if}
</section>

<style>
  .mv-tile {
    position: relative;
    background: #000;
    overflow: hidden;
    display: flex;
    align-items: center;
    justify-content: center;
    min-width: 0;
    min-height: 0;
  }
  /* Native-engine tile: the box and the anchor <video> stop painting so the
     aperture hole (the tile's video area, seam-inset) shows the surface
     beneath; the grid's stage backdrop paints the #000 around it — the same
     pixels the box itself painted on the hls path. */
  .mv-tile--native,
  .mv-tile--native .mv-video {
    background: transparent;
  }
  /* The video REGION: absolute inset-0 in both engines — the rect the
     native surface tracks in mpv mode (see the rect pusher). */
  .mv-video-area {
    position: absolute;
    inset: 0;
    min-width: 0;
    min-height: 0;
  }
  .mv-video {
    width: 100%;
    height: 100%;
    object-fit: contain;
    background: #000;
    display: block;
  }
  /* Invisible click layer: focuses the tile without intercepting control clicks
     (controls sit above it via z-index). */
  .mv-tile-surface {
    position: absolute;
    inset: 0;
    border: none;
    background: transparent;
    padding: 0;
    cursor: pointer;
    z-index: 1;
  }
  .mv-tile-channel {
    position: absolute;
    top: 6px;
    left: 8px;
    z-index: 3;
    padding: 2px 7px;
    border-radius: 4px;
    background: rgba(0, 0, 0, 0.6);
    color: #fff;
    font-size: 12px;
    font-weight: 600;
    pointer-events: none;
    max-width: calc(100% - 16px);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .mv-tile-channel--dim {
    opacity: 0.55;
  }

  /* Drag affordances. Dragging tiles are dimmed + scaled slightly; a valid drop
     target gets an accent ring. Playback is NOT interrupted (keyed each moves the
     DOM node; the <video>/hls.js survive the reparent). */
  .mv-tile--dragging {
    opacity: 0.4;
  }
  .mv-tile--drop-target {
    box-shadow: inset 0 0 0 2px var(--accent);
  }

  /* Drag handle: top-right grip, above the focus surface (z-index 3) so it
     receives the pointerdown. Cursor grab; the actual move/drop is driven by
     MultiView via document pointer listeners. */
  .mv-drag-handle {
    position: absolute;
    top: 6px;
    right: 6px;
    z-index: 3;
    width: 22px;
    height: 22px;
    border: none;
    border-radius: 4px;
    background: rgba(0, 0, 0, 0.55);
    color: #fff;
    cursor: grab;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 0;
    opacity: 0.7;
    transition:
      opacity 120ms,
      background 120ms;
  }
  .mv-drag-handle:hover {
    opacity: 1;
    background: rgba(0, 0, 0, 0.8);
  }
  .mv-drag-handle:active {
    cursor: grabbing;
  }
  .mv-reorder {
    color: var(--text-secondary);
  }
  .mv-tile-overlay {
    position: absolute;
    inset: 0;
    z-index: 2;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 6px;
    color: #fff;
    background: rgba(0, 0, 0, 0.45);
    pointer-events: none;
  }
  .mv-overlay-title {
    font-size: 13px;
    font-weight: 600;
    text-align: center;
    padding: 0 10px;
  }
  /* The overlay itself is pointer-events: none (it must never eat tile
     clicks); the Retry button re-enables pointer events for itself only. */
  .mv-overlay-retry {
    pointer-events: auto;
    padding: 4px 16px;
    border: 1px solid var(--border);
    border-radius: 4px;
    background: var(--bg-panel);
    color: var(--text-primary);
    font: inherit;
    font-size: 12px;
    cursor: pointer;
  }
  .mv-overlay-retry:hover {
    background: var(--bg-hover);
  }
  .mv-overlay-retry:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: -2px;
  }
  .mv-spinner {
    width: 26px;
    height: 26px;
    border: 3px solid rgba(255, 255, 255, 0.25);
    border-top-color: #fff;
    border-radius: 50%;
    animation: mv-spin 0.8s linear infinite;
  }
  @keyframes mv-spin {
    to {
      transform: rotate(360deg);
    }
  }

  .mv-tile-controls {
    position: absolute;
    left: 0;
    right: 0;
    bottom: 0;
    z-index: 4;
    display: flex;
    align-items: center;
    gap: 4px;
    padding: 5px 8px;
    background: linear-gradient(to top, var(--bg-overlay), transparent);
    color: var(--text-primary);
  }
  .mv-ctrl {
    flex: 0 0 auto;
    width: 26px;
    height: 26px;
    border: none;
    background: transparent;
    color: var(--text-primary);
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 0;
    border-radius: 4px;
  }
  .mv-ctrl:hover {
    background: var(--bg-hover-faint);
  }
  .mv-ctrl--on {
    color: var(--accent);
  }
  .mv-close:hover {
    background: rgba(229, 72, 77, 0.25);
  }
  .mv-volume {
    flex: 0 0 64px;
    height: 3px;
    appearance: none;
    -webkit-appearance: none;
    background: var(--track);
    border-radius: 2px;
    cursor: pointer;
  }
  .mv-volume::-webkit-slider-thumb {
    appearance: none;
    -webkit-appearance: none;
    width: 10px;
    height: 10px;
    border-radius: 50%;
    background: var(--text-primary);
  }
  .mv-volume::-moz-range-thumb {
    width: 10px;
    height: 10px;
    border-radius: 50%;
    background: var(--text-primary);
    border: none;
  }
  .mv-spacer {
    flex: 1 1 auto;
  }
  /* The native-engine badge, same marker (and same measured optical
     centering) as PlayerControls' .engine-badge — see its comment for
     the asymmetric-padding derivation. The tile bar is a fixed-px
     scale, so the px terms drop the --ctrl-scale factor. */
  .mv-engine-badge {
    flex: 0 0 auto;
    align-self: center;
    display: inline-flex;
    align-items: center;
    box-sizing: border-box;
    height: 15px;
    padding: 0 7px;
    padding-left: calc(7px + 0.133em);
    padding-bottom: 0.2em;
    border-radius: 999px;
    background: var(--bg-hover-faint);
    background: color-mix(in srgb, var(--accent) 15%, transparent);
    color: var(--accent);
    font-size: 10px;
    font-weight: 700;
    font-family: 'Inter', system-ui, monospace;
    letter-spacing: 0.05em;
    line-height: 1;
    pointer-events: none;
    user-select: none;
  }
  .mv-menu-wrap {
    position: relative;
  }
  .mv-menu-backdrop {
    position: fixed;
    inset: 0;
    background: transparent;
    border: none;
    cursor: default;
    z-index: 5;
  }
  .mv-menu {
    position: absolute;
    bottom: calc(100% + 4px);
    left: 0;
    min-width: 150px;
    background: var(--bg-panel);
    border: 1px solid var(--border);
    border-radius: 6px;
    padding: 4px 0;
    box-shadow: 0 8px 24px rgba(0, 0, 0, 0.5);
    z-index: 6;
    display: flex;
    flex-direction: column;
  }
  .mv-menu-item {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    padding: 5px 10px;
    border: none;
    background: transparent;
    color: var(--text-primary);
    font-size: 12px;
    text-align: left;
    cursor: pointer;
    font-family: inherit;
  }
  .mv-menu-item:hover {
    background: var(--bg-hover);
  }
  .mv-menu-item--active {
    color: var(--accent);
  }
</style>
