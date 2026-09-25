<script lang="ts">
  // One live-stream tile in the multi-view grid. Each tile owns its OWN
  // playback engine + resolve lifecycle (a fresh `resolve_stream` call per
  // play), a local generation guard for stale-request discipline, live stall
  // recovery, and an authoritative offline-vs-transient split:
  //   - genuine offline (resolve returns offline, or a live→offline status
  //     poll) → the tile is CLOSED by the store (offline-close).
  //   - transient (resolve network error / hls fatal networkish error / manifest
  //     timeout) → status 'error' overlay + an automatic retry, the tile is NOT
  //     closed (mirrors the single-stream path, which only surfaces 'offline'
  //     from an authoritative resolve result).
  //
  // The engine is hls.js OR the embedded native mpv engine (mpvEnabled):
  // both render the SAME overlay layout (video area inset-0, auto-hiding
  // control bar over it). A native tile plays the RAW resolved URL through
  // its own engine id (multi-view = one mpv core per tile; see MultiView's
  // id allocation) and its page UI over the video (bar, label, drag handle,
  // quality menu) composites via the page-snapshot overlay path.
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

  import { onDestroy } from 'svelte'
  import Hls from 'hls.js'
  import { invoke } from '@tauri-apps/api/core'
  import { listen } from '@tauri-apps/api/event'
  import { getCurrentWindow } from '@tauri-apps/api/window'
  import { settings } from './settings.svelte.ts'
  import { toKsvodProxyUrl, shouldRecoverStallAfterPause } from './playback'
  import { PlaybackSession, resolveLiveStream } from './playback-session.svelte'
  import { GQL_REFRESH_INTERVAL_MS } from './gql'
  import { fetchLiveStatus } from './favorites.svelte'
  import { MpvBackend, type MpvActionEvent, type VideoBackend } from './video-backend'
  import {
    tileStore,
    tileAudible,
    tileControlsIdle,
    planTileMuteToggle,
    planTileVolumeInput,
    applyTileAudio,
    type TileState,
  } from './tile-store.svelte'
  import { tooltip } from './tooltip.ts'
  import { nextVolume } from './volume'
  import { effectiveQualities, mpvQualities, qualityLabel } from './qualities'
  import { osdHexColor } from './custom-themes.svelte'
  import { t } from './i18n/index.svelte'

  interface Props {
    tile: TileState
    isAuthority: boolean
    isWindows: boolean
    /** True while THIS tile is being dragged (visual affordance). */
    isDragging: boolean
    /** True while another tile is being dragged over this one (drop highlight). */
    isDropTarget: boolean
    onAuthorityVideo: (el: HTMLVideoElement | null) => void
    /** The authority tile's playback BACKEND (native engine tiles): App's
     *  keyboard shortcuts target it instead of the inert <video> element. */
    onAuthorityBackend: (b: VideoBackend | null) => void
    /** Reports this tile's native-video-area element (the rect the mpv
     *  surface must cover + the box MultiView's overlay manager checks
     *  page UI against). Null on unmount. */
    onNativeArea: (tileId: string, el: HTMLElement | null) => void
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
    onAuthorityVideo,
    onAuthorityBackend,
    onNativeArea,
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
   *  menu + OSC list offer only real variants (a channel transcoding 720p60
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
  $effect(() => {
    if (mpvEnabled && !mpvBackend) {
      mpvBackend = new MpvBackend(mpvId)
    } else if (!mpvEnabled && mpvBackend) {
      const stale = mpvBackend
      mpvBackend = null
      nativeActive = false
      void stale.dispose()
    }
  })
  /** The list every quality surface offers (HTML strip gear + the OSC feed
   *  and its reverse map): on the native engine audio_only is absent — mpv
   *  plays it, but with no video track there is no OSD canvas, and a tile
   *  that picked it could not switch back from the in-video bar (the HTML
   *  strip below would remain, but the menu must match the engine anyway). */
  const menuQualities = $derived(mpvBackend ? mpvQualities(availableQualities) : effectiveQualities(availableQualities))

  // Native playback state → tile status. An error/ended mid-playback hides
  // the surface (teardown stops the engine) so the status overlay shows.
  $effect(() => {
    const b = mpvBackend
    if (!b) return
    const un = [
      b.on('playing', () => tileStore.setStatus(tile.id, 'playing')),
      b.on('waiting', () => tileStore.setStatus(tile.id, 'loading')),
      b.on('error', () => {
        playback.teardown(videoEl)
        nativeActive = false
        tileStore.setStatus(tile.id, 'error', b.lastError ?? 'native engine error')
      }),
      b.on('ended', () => {
        // A live stream that ends went offline; the status poll closes the
        // tile (offline-close) — meanwhile show it uncovered.
        playback.teardown(videoEl)
        nativeActive = false
        tileStore.setStatus(tile.id, 'offline')
      }),
    ]
    return () => {
      for (const u of un) u()
    }
  })

  // ---- the tile's in-video OSC (mpv-rendered control bar) -------------------
  // Native tiles use the SAME OSC as the single player (ks-osc.lua), in tile
  // mode: the app-global buttons (pip / mpv handoff / theater) are hidden,
  // stop = close the tile, fullscreen = the window. Everything is fed and
  // received per engine id — no page-snapshot compositing involved (the
  // snapshot path stays for tooltips/banner/toasts only).
  const sendOsd = (args: string[]): void => {
    void invoke('mpv_script_msg', { id: mpvId, args }).catch(() => {})
  }
  // Theme colors (the OSC can't read CSS vars), UI scale, tile mode, and
  // the quality list (labels re-resolve on language switches). Mirrors
  // App.svelte's single-player feeding — gated on nativeActive (not just
  // mpvEnabled) because a tile ENGINE only exists once its first load ran;
  // feeds sent before that would hit "mpv engine unavailable" and die in
  // the invoke catch.
  $effect(() => {
    if (!nativeActive) return
    void mpvId // re-feed when the tile is re-homed onto another engine
    void settings.theme
    const cs = getComputedStyle(document.documentElement)
    // Same 6-hex requirement as App's theme feed: the OSD lua's bgr() turns
    // any non-6-hex token white, and custom themes store rgba()/short-hex.
    const v = (name: string): string => osdHexColor(cs.getPropertyValue(name).trim())
    sendOsd([
      'ks-theme',
      v('--bg-app'),
      v('--accent'),
      v('--text-primary'),
      v('--text-secondary'),
      v('--border'),
      v('--live'),
    ])
    sendOsd(['ks-scale', String(settings.uiScale)])
    sendOsd(['ks-mode', 'tile'])
    void tile.channel // the label re-feeds when the tile's channel changes
    sendOsd(['ks-label', tile.channel])
    // Reading the list through menuQualities tracks it, so the list
    // re-feeds when the async probe lands.
    sendOsd([
      'ks-qualities',
      t('quality'),
      qualityLabel(tile.quality),
      ...menuQualities.map((qid) => qualityLabel(qid)),
    ])
  })
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
  // The OSC's buttons come back as mpv://action events tagged with the
  // engine id.
  $effect(() => {
    if (!mpvEnabled) return
    const id = mpvId
    let un: (() => void) | undefined
    let disposed = false
    void listen<MpvActionEvent>('mpv://action', (e) => {
      if (e.payload.id !== id) return
      const a = e.payload.action
      if (a === 'stop' || a === 'close') {
        // The bar's stop button and the far-right X (hls.js parity) both
        // close the tile.
        closeTile()
      } else if (a === 'fullscreen') {
        // The native surfaces are window-relative — fullscreen means the
        // WINDOW (same semantic as the F shortcut in native multi-view).
        const win = getCurrentWindow()
        void win
          .isFullscreen()
          .then((fs) => win.setFullscreen(!fs))
          .catch(() => {
            /* ignore */
          })
      } else if (a === 'moveleft' || a === 'moveright') {
        // The bar's ◀/▶ arrows swap the tile with the neighbouring slot
        // (clamped at the ends — hls.js parity). Clamped is intended: at
        // the end the arrow just does nothing.
        tileStore.move(tile.id, a === 'moveleft' ? -1 : 1)
      } else if (a.startsWith('quality:')) {
        const label = a.slice('quality:'.length)
        // Reverse-map against the SAME list the OSC was fed (it can contain
        // real rungs outside the static vocabulary, e.g. 936p60).
        const qid = menuQualities.find((q) => qualityLabel(q) === label)
        if (qid) changeQuality(qid)
      }
    })
      .then((u) => {
        if (disposed) u()
        else un = u
      })
      .catch(() => {
        /* not under Tauri */
      })
    return () => {
      disposed = true
      un?.()
    }
  })
  // OSC-driven volume/mute (the bar's slider, speaker button, wheel) syncs
  // back into the tile audio model: the authority tile's bar drives the
  // GLOBAL settings (persisted), a non-authority bar drives that tile's OWN
  // volume (never persisted). The unmute direction applies the SAME
  // explicit-unmute rule as the HTML controls (planTileMuteToggle): an
  // un-mute click also clears a GLOBAL mute that was blocking the tile —
  // without it the audio effect re-mutes the tile immediately and the click
  // "sometimes does nothing" depending on the mute state. Echoes absorb:
  // the audio effect writes the same values back, mpv reports them, and the
  // equality checks turn the second write into a no-op.
  $effect(() => {
    const b = mpvBackend
    if (!b || !nativeActive) return
    return b.on('volumechange', () => {
      if (isAuthority) {
        if (settings.volume !== b.volume) settings.setVolume(b.volume)
        if (settings.muted !== b.muted) settings.setMuted(b.muted)
        return
      }
      if (tile.volume !== b.volume) tileStore.setTileVolume(tile.id, b.volume)
      const unmuted = !b.muted
      if (unmuted) {
        if (!tile.manualUnmute) tileStore.setManualUnmute(tile.id, true)
        if (settings.muted) settings.setMuted(false)
      } else if (tile.manualUnmute) {
        tileStore.setManualUnmute(tile.id, false)
      }
    })
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
    // the backend's local default is unmuted, and a load-time unmute both
    // plays audio before the effect corrects it and echoes into the OSC
    // sync as a "user unmute" (the watch-together all-audible bug).
    const mpv = mpvBackend
    if (mpv) {
      const res = await playback.attachMpv(mpv, {
        url,
        kind: 'live',
        hwdec: settings.mpvHwdec,
        volume: isAuthority ? settings.volume : tile.volume,
        muted: !tileAudible(isAuthority, tile.manualUnmute, settings.muted),
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
      tileStore.setStatus(tile.id, 'error', resolved.error ?? 'failed to resolve stream')
      return
    }
    const res = await attach(tile.channel, q, resolved.url, gen)
    if (!isCurrent(gen, q)) return
    if (!res.ok) tileStore.setStatus(tile.id, 'error', res.error)
  }

  function changeQuality(q: string): void {
    menuOpen = false
    if (q === tile.quality) return
    tileStore.setQuality(tile.id, q)
    playback.teardown(videoEl)
    void load(q)
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
    playback.teardown(el)
    nativeActive = false
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

  // ---- native surface pointer forwarding (mpv OSC input) --------------------
  // Mirrors App.svelte's single-player forwarder (same normalization, the
  // same click-only mpv constraint, the same drag synthesis from held
  // moves) but scoped to THIS tile's video area and tagged with its engine
  // id. The page keeps receiving every event (the surface is input-shaped)
  // — tile activation clicks still work; the OSC just also sees them.
  $effect(() => {
    if (!nativeActive) return
    const stage = areaEl
    if (!stage) return
    const id = mpvId
    let lastClickAt = 0
    const forward = (e: { clientX: number; clientY: number }, kind: string): void => {
      const r = stage.getBoundingClientRect()
      if (r.width < 1 || r.height < 1) return
      const x = (e.clientX - r.left) / r.width
      const y = (e.clientY - r.top) / r.height
      void invoke('mpv_pointer', { id, x, y, kind }).catch(() => {})
    }
    const click = (e: PointerEvent): void => {
      const now = performance.now()
      if (now - lastClickAt < 50) return
      lastClickAt = now
      forward(e, 'click')
    }
    const onMove = (e: PointerEvent): void => {
      forward(e, 'move')
      if (e.buttons === 1) click(e)
    }
    const onDown = (e: PointerEvent): void => {
      if (e.button !== 0) return
      // Pointer capture keeps held-drag streams flowing even when the
      // pointer leaves the tile mid-drag.
      try {
        stage.setPointerCapture(e.pointerId)
      } catch {
        /* stage gone mid-gesture */
      }
      click(e)
    }
    const onWheelNative = (e: WheelEvent): void => {
      // mpv owns the wheel in native mode (OSC volume steps) — the page's
      // scroll-volume handler below skips while native.
      e.preventDefault()
      forward(e, e.deltaY < 0 ? 'wheel-up' : 'wheel-down')
    }
    // Any click on the native video moves the audio authority here. The
    // pointer capture above RETARGETS the composed click to the stage (the
    // .mv-tile-surface button underneath never sees it — that was the
    // "clicking a native tile does nothing" bug), so the stage listener is
    // the one that fires. The OSC's own buttons live inside mpv, so their
    // clicks also land here — focusing the tile you're interacting with is
    // the intended behaviour.
    const onClick = (): void => {
      onTileActivate(tile.id)
    }
    stage.addEventListener('pointermove', onMove, { passive: true })
    stage.addEventListener('pointerdown', onDown)
    stage.addEventListener('click', onClick)
    stage.addEventListener('wheel', onWheelNative, { passive: false })
    return () => {
      stage.removeEventListener('pointermove', onMove)
      stage.removeEventListener('pointerdown', onDown)
      stage.removeEventListener('click', onClick)
      stage.removeEventListener('wheel', onWheelNative)
    }
  })

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
    // The native engine owns the wheel over the video (its OSC volume-steps
    // via the forwarded wheel events above) — the page path stays for hls
    // tiles only.
    if (nativeActive) return
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

  // Report the authority tile's shortcut TARGET to App (keyboard shortcuts
  // follow the AUDIO AUTHORITY, not the active chat tab): the backend while
  // the native engine plays this tile (the <video> is inert then), else the
  // element.
  $effect(() => {
    if (isAuthority && nativeActive && mpvBackend) {
      onAuthorityVideo(null)
      onAuthorityBackend(mpvBackend)
    } else if (isAuthority && videoEl) {
      onAuthorityVideo(videoEl)
      onAuthorityBackend(null)
    } else {
      onAuthorityVideo(null)
      onAuthorityBackend(null)
    }
  })

  // Report the native video-area element to MultiView (its overlay manager
  // tests page UI against every native tile's rect).
  $effect(() => {
    if (!mpvEnabled) {
      onNativeArea(tile.id, null)
      return
    }
    const stage = areaEl
    if (stage) onNativeArea(tile.id, stage)
    else onNativeArea(tile.id, null)
    return () => onNativeArea(tile.id, null)
  })

  // ---- offline-close polling ----
  // Periodically check the channel's live status. A genuine live→offline
  // transition closes the tile (handled by the store); a transient GQL error
  // (state 'error') is ignored — the tile keeps its last-known status. This is
  // the authoritative offline signal that distinguishes a real outage from a
  // transient network/hls hiccup (which only sets status 'error' + retries).
  let pollTimer: ReturnType<typeof setInterval> | null = null
  let pollToken = 0
  async function pollOnce(): Promise<void> {
    const my = ++pollToken
    try {
      const s = await fetchLiveStatus(tile.channel)
      if (my !== pollToken) return
      tileStore.setLiveStatus(tile.id, s)
    } catch {
      /* transient — keep last-known status, do not close */
    }
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

  onDestroy(() => {
    playback.dispose(videoEl)
    const b = mpvBackend
    mpvBackend = null
    if (b) void b.dispose() // unsubscribes + mpv_stop (hides the surface)
    if (pollTimer) clearInterval(pollTimer)
    onAuthorityVideo(null)
    onAuthorityBackend(null)
    onNativeArea(tile.id, null)
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

  const showOverlay = $derived(tile.status === 'loading' || tile.status === 'offline' || tile.status === 'error')
</script>

<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
<!-- svelte-ignore a11y_click_events_have_key_events -->
<section
  bind:this={tileEl}
  data-tile-id={tile.id}
  class="mv-tile"
  class:mv-tile--authority={isAuthority}
  class:mv-tile--audible={audible}
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
       page UI OVER the surface in native mode, composited via MultiView's
       page-snapshot overlay path (same as the quality menu). -->
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
         Auto-hides with the rest of the tile overlay (controlsShown); native
         tiles use the mpv OSC instead of the HTML overlay UI. -->
    {#if controlsShown && !mpvEnabled}
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

    {#if controlsShown && !mpvEnabled}
      <div class="mv-tile-channel" class:mv-tile-channel--dim={!isAuthority}>{tile.channel}</div>
    {/if}

    {#if showOverlay}
      <div class="mv-tile-overlay">
        {#if tile.status === 'loading'}
          <div class="mv-spinner" aria-hidden="true"></div>
        {:else if tile.status === 'offline'}
          <span class="mv-overlay-title">{t('player_offline')}</span>
        {:else if tile.status === 'error'}
          <span class="mv-overlay-title">{t('player_streamError')}</span>
        {/if}
      </div>
    {/if}
  </div>

  {#if controlsShown && !mpvEnabled}
    <!-- The auto-hiding gradient bar OVER the video — hls.js tiles only.
         Native tiles use the mpv OSC (in-video, mpv-rendered; see the
         OSC feeding/effects above). -->
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
  /* The video REGION: absolute inset-0 in both engines — the rect the
     native surface tracks in mpv mode (see the rect pusher). */
  .mv-video-area {
    position: absolute;
    inset: 0;
    min-width: 0;
    min-height: 0;
  }
  /* Authority tile gets an accent ring so the audio source is obvious.
     The ring edges under the video surface are covered in native mode —
     the visible ring marks are the same as hls.js (parity by design). */
  .mv-tile--authority {
    box-shadow: inset 0 0 0 2px var(--accent);
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
