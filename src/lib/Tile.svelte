<script lang="ts">
  // One live-stream tile in the multi-view grid. Each tile owns its OWN hls.js
  // instance + resolve lifecycle (a fresh `resolve_stream` call per play), a
  // local generation guard for stale-request discipline, live stall recovery,
  // and an authoritative offline-vs-transient split:
  //   - genuine offline (resolve returns offline, or a live→offline status
  //     poll) → the tile is CLOSED by the store (offline-close).
  //   - transient (resolve network error / hls fatal networkish error / manifest
  //     timeout) → status 'error' overlay + an automatic retry, the tile is NOT
  //     closed (mirrors the single-stream path, which only surfaces 'offline'
  //     from an authoritative resolve result).
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
  import { settings } from './settings.svelte.ts'
  import { buildHlsConfig } from './hls-config'
  import { GQL_REFRESH_INTERVAL_MS } from './gql'
  import { fetchLiveStatus } from './favorites.svelte'
  import { tileStore, tileAudible, planTileMuteToggle, planTileVolumeInput, applyTileAudio, type TileState } from './tile-store.svelte'
  import { tooltip } from './tooltip.ts'
  import { nextVolume } from './volume'
  import { t } from './i18n/index.svelte'

  interface Props {
    tile: TileState
    isAuthority: boolean
    isWindows: boolean
    /** True while THIS tile is the one being dragged (visual affordance). */
    isDragging: boolean
    /** True while another tile is being dragged over this one (drop highlight). */
    isDropTarget: boolean
    onAuthorityVideo: (el: HTMLVideoElement | null) => void
    /** Tile activation (video-surface click) — MultiView routes it through
     *  its merged-chats policy (a merged tile moves only audio authority). */
    onTileActivate: (tileId: string) => void
    /** Drag-handle pointer-down — MultiView owns hit-testing for the drop target. */
    onTileDragStart: (tileId: string, e: PointerEvent) => void
    /** CSS grid-area shorthand for this tile's placement (empty = auto-place). */
    gridArea?: string
  }
  const { tile, isAuthority, isWindows, isDragging, isDropTarget, onAuthorityVideo, onTileActivate, onTileDragStart, gridArea }: Props = $props()

  const QUALITY_IDS = ['best', '1080p60', '720p60', '720p', '480p', '360p', '160p', 'audio_only'] as const
  function qualityLabel(id: string): string {
    if (id === 'best') return t('pc_sourceQuality')
    if (id === 'audio_only') return t('pc_audioOnly')
    return id
  }

  let videoEl = $state<HTMLVideoElement | undefined>(undefined)
  let tileEl = $state<HTMLElement | undefined>(undefined)
  let hls: Hls | null = null
  let generation = 0
  let manifestTimeout: ReturnType<typeof setTimeout> | null = null
  let stallTimer: ReturnType<typeof setTimeout> | null = null
  let userPaused = false
  let menuOpen = $state(false)

  // Audibility (audio authority — see tileAudible): the authority tile follows
  // the global mute; a non-authority tile is audible only if the user manually
  // unmuted it. Global mute silences all.
  const audible = $derived(tileAudible(isAuthority, tile.manualUnmute, settings.muted))

  function ksvod(httpsUrl: string): string {
    const prefix = isWindows ? 'http://ksvod.localhost/' : 'ksvod://localhost/'
    return httpsUrl.replace('https://', prefix)
  }

  function isFatalNetworkish(data: { fatal: boolean; type: string; details?: string }): boolean {
    if (!data.fatal) return false
    const NETWORKISH = new Set([
      'manifestLoadError', 'manifestLoadTimeOut', 'manifestParsingError',
      'levelLoadError', 'levelLoadTimeOut', 'audioTrackLoadError',
      'audioPlaylistLoadError', 'fragmentLoadError', 'fragLoadError', 'fragLoadTimeOut',
    ])
    return NETWORKISH.has(data.type) || NETWORKISH.has(data.details ?? '')
  }

  function isCurrent(gen: number, q: string): boolean {
    return gen === generation && tile.quality === q
  }

  function clearStall(): void {
    if (stallTimer) { clearTimeout(stallTimer); stallTimer = null }
  }
  function scheduleStall(): void {
    clearStall()
    stallTimer = setTimeout(() => {
      stallTimer = null
      const el = videoEl
      if (!el) return
      const liveEdge = hls?.liveSyncPosition ?? (el.seekable.length > 0 ? el.seekable.end(el.seekable.length - 1) : NaN)
      if (Number.isFinite(liveEdge)) { try { el.currentTime = Math.max(liveEdge - 1.5, 0) } catch { /* ignore */ } }
      void el.play().catch(() => { /* ignore */ })
    }, 1_000)
  }

  function teardownHls(): void {
    generation++
    if (manifestTimeout) { clearTimeout(manifestTimeout); manifestTimeout = null }
    clearStall()
    if (hls) { try { hls.destroy() } catch { /* ignore */ } hls = null }
    const el = videoEl
    if (el) { try { el.pause(); el.removeAttribute('src'); el.load() } catch { /* ignore */ } }
  }

  async function resolveStream(channel: string, q: string): Promise<{ ok: true; url: string } | { ok: false; offline: boolean; unavailable?: boolean; error?: string }> {
    type Raw = { ok?: boolean; url?: string | null; offline?: boolean; error?: string | null; unavailable?: boolean }
    let raw: Raw
    try {
      raw = (await invoke('resolve_stream', { channel, quality: q, lowLatency: settings.lowLatency })) as Raw
    } catch (err) {
      const msg = typeof err === 'string' ? err : err instanceof Error ? err.message : JSON.stringify(err)
      return { ok: false, offline: false, error: 'invoke failed: ' + msg }
    }
    if (raw.offline) return { ok: false, offline: true }
    if (!raw.ok || !raw.url) return { ok: false, offline: false, unavailable: raw.unavailable === true, error: raw.error ?? 'unknown resolve error' }
    return { ok: true, url: raw.url }
  }

  async function attach(channel: string, q: string, url: string, gen: number): Promise<{ ok: true } | { ok: false; error: string }> {
    const el = videoEl
    if (!el) return { ok: false, error: 'no video element' }
    if (!isCurrent(gen, q)) return { ok: false, error: 'stale' }
    const sourceUrl = isWindows ? ksvod(url) : url
    if (Hls.isSupported()) {
      if (hls) { clearStall(); try { hls.destroy() } catch { /* ignore */ } }
      const instance = new Hls(buildHlsConfig(settings.lowLatency))
      hls = instance
      return await new Promise((resolve) => {
        let done = false
        const finish = (r: { ok: true } | { ok: false; error: string }): void => {
          if (done) return
          done = true
          if (manifestTimeout) { clearTimeout(manifestTimeout); manifestTimeout = null }
          resolve(r)
        }
        instance.on(Hls.Events.MANIFEST_PARSED, () => {
          if (!isCurrent(gen, q)) { finish({ ok: false, error: 'stale' }); return }
          tileStore.setStatus(tile.id, 'loading')
          el.play().then(() => { if (isCurrent(gen, q)) tileStore.setStatus(tile.id, 'playing') })
            .catch(() => { if (isCurrent(gen, q)) tileStore.setStatus(tile.id, 'playing') })
          finish({ ok: true })
        })
        instance.on(Hls.Events.ERROR, (_e, data) => {
          if (!data.fatal) return
          try { instance.destroy() } catch { /* ignore */ }
          if (!isCurrent(gen, q)) { finish({ ok: false, error: 'stale' }); return }
          const detail = isFatalNetworkish(data) ? 'network/manifest error: ' + data.type : 'hls error: ' + data.type
          finish({ ok: false, error: detail })
        })
        instance.loadSource(sourceUrl)
        instance.attachMedia(el)
        manifestTimeout = setTimeout(() => { if (!done) { try { instance.destroy() } catch { /* ignore */ } finish({ ok: false, error: 'timeout waiting for manifest' }) } }, 20_000)
      })
    }
    if (el.canPlayType('application/vnd.apple.mpegurl')) {
      el.src = sourceUrl
      try { await el.play(); if (!isCurrent(gen, q)) return { ok: false, error: 'stale' }; tileStore.setStatus(tile.id, 'playing'); return { ok: true } }
      catch (err) { return { ok: false, error: 'native HLS play failed: ' + (err as Error).message } }
    }
    return { ok: false, error: 'HLS playback is not supported' }
  }

  async function load(q: string): Promise<void> {
    const gen = ++generation
    tileStore.setStatus(tile.id, 'loading')
    clearStall()
    userPaused = false
    const resolved = await resolveStream(tile.channel, q)
    if (!isCurrent(gen, q)) return
    if (!resolved.ok) {
      if (resolved.offline) { tileStore.setStatus(tile.id, 'offline'); return }
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
    teardownHls()
    void load(q)
  }

  function togglePlay(): void {
    const el = videoEl
    if (!el) return
    if (el.paused) { userPaused = false; void el.play().catch(() => { /* ignore */ }) }
    else { userPaused = true; el.pause() }
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
    teardownHls()
    tileStore.close(tile.id)
  }

  // ---- video event handlers (live stall recovery) ----
  function onWaiting(): void { scheduleStall() }
  function onPlaying(): void { clearStall(); userPaused = false }
  function onPause(): void { if (!userPaused) scheduleStall() }

  // ---- (re)load ONLY on a genuine channel/quality/low-latency change ----
  // This effect is the fix for "opening a new channel reloads all tiles": it
  // is scoped strictly to THIS tile's own identity (videoEl + tile.channel +
  // tile.quality + settings.lowLatency) and — crucially — tears down + reloads
  // ONLY when one of those actually changed (or on first mount). It is therefore
  // idempotent: adding/reordering a SIBLING cannot re-trigger it (the {#each} is
  // keyed by the stable tile.id, and none of these deps change for an existing
  // tile on a sibling add), and even a spurious re-run is a no-op. prevChannel
  // is seeded to a sentinel so the first run loads.
  let prevChannel = ''
  let prevQuality = ''
  let prevLowLatency: boolean | null = null
  $effect(() => {
    const el = videoEl
    if (!el) return
    const ch = tile.channel
    const q = tile.quality
    const ll = settings.lowLatency
    const firstRun = prevLowLatency === null
    const channelChanged = ch !== prevChannel
    const changed = firstRun || channelChanged || q !== prevQuality || ll !== prevLowLatency
    prevChannel = ch
    prevQuality = q
    prevLowLatency = ll
    if (!changed) return // idempotent guard — never reload on an unchanged re-run
    teardownHls()
    if (channelChanged && !firstRun) tileStore.setStatus(tile.id, 'loading')
    void load(q)
  })

  // ---- audio authority: apply audible/volume imperatively (no persist) ----
  // Centralised in applyTileAudio (tile-store.svelte): the authority tile uses
  // the global settings.volume; a non-authority tile uses its OWN per-tile
  // volume (nudged by scroll-wheel). A forced mute (authority moving away) sets
  // el.muted directly and is never written to settings. Re-running this effect
  // (any dependency change) is idempotent — the element always ends up matching
  // tileAudible of the current store state.
  $effect(() => {
    const el = videoEl
    if (!el) return
    applyTileAudio(el, {
      isAuthority,
      manualUnmute: tile.manualUnmute,
      globalMuted: settings.muted,
      globalVolume: settings.volume,
      tileVolume: tile.volume,
    })
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

  // Report the authority tile's video to App (keyboard-shortcut target — the
  // shortcuts follow the AUDIO AUTHORITY, not the active chat tab).
  $effect(() => {
    if (isAuthority && videoEl) onAuthorityVideo(videoEl)
    else onAuthorityVideo(null)
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
    pollTimer = setInterval(() => { void pollOnce() }, GQL_REFRESH_INTERVAL_MS)
    return () => { if (pollTimer) { clearInterval(pollTimer); pollTimer = null } }
  })

  onDestroy(() => {
    teardownHls()
    if (pollTimer) clearInterval(pollTimer)
    onAuthorityVideo(null)
  })

  // Touch + mouse interaction for control visibility (auto-hide).
  let lastActivity = $state(Date.now())
  let controlsShown = $state(true)
  const IDLE_HIDE_MS = 3_500
  function bump(): void { lastActivity = Date.now(); controlsShown = true }
  $effect(() => {
    void lastActivity
    const id = setInterval(() => { if (Date.now() - lastActivity >= IDLE_HIDE_MS) controlsShown = false }, 400)
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
       Auto-hides with the rest of the tile overlay (controlsShown). -->
  {#if controlsShown}
    <button
      type="button"
      class="mv-drag-handle"
      aria-label={t('mv_dragTile')}
      use:tooltip={t('mv_dragTile')}
      onpointerdown={(e) => onTileDragStart(tile.id, e)}
    >
      <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true" fill="currentColor"><circle cx="5" cy="4" r="1.3"/><circle cx="11" cy="4" r="1.3"/><circle cx="5" cy="8" r="1.3"/><circle cx="11" cy="8" r="1.3"/><circle cx="5" cy="12" r="1.3"/><circle cx="11" cy="12" r="1.3"/></svg>
    </button>
  {/if}

  {#if controlsShown}
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

  {#if controlsShown}
    <div class="mv-tile-controls">
      <button type="button" class="mv-ctrl" onclick={togglePlay} aria-label={t('pc_play')} use:tooltip={t('pc_play')}>
        <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><path d="M8 5v14l11-7z" fill="currentColor"/></svg>
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
          <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><path d="M3 9v6h4l5 5V4L7 9H3zm13.5 3l2.7-2.7-1.4-1.4L15 10.6l-2.8-2.8-1.4 1.4L13.6 12l-2.8 2.8 1.4 1.4L15 13.4l2.7 2.7 1.4-1.4L16.4 12z" fill="currentColor"/></svg>
        {:else}
          <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><path d="M3 9v6h4l5 5V4L7 9H3zm11 .2v5.6c1.5-.5 2.5-1.9 2.5-3.5s-1-3-2.5-3.5z" fill="currentColor"/></svg>
        {/if}
      </button>

      <input
        class="mv-volume"
        type="range" min="0" max="1" step="0.05"
        value={isAuthority ? (settings.muted ? 0 : settings.volume) : (audible ? tile.volume : 0)}
        oninput={(e) => onVolumeInput(parseFloat((e.currentTarget as HTMLInputElement).value))}
        aria-label={t('volume')}
      />

      <div class="mv-menu-wrap">
        <button type="button" class="mv-ctrl" onclick={() => (menuOpen = !menuOpen)} aria-label={t('quality')} aria-haspopup="menu" aria-expanded={menuOpen} use:tooltip={t('quality')}>
          <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><path d="M19.14 12.94c.04-.31.06-.62.06-.94s-.02-.63-.07-.94l2.03-1.58c.18-.14.23-.41.12-.61l-1.92-3.32c-.12-.22-.37-.29-.59-.22l-2.39.96c-.5-.38-1.03-.7-1.62-.94l-.36-2.54c-.04-.24-.24-.41-.48-.41h-3.84c-.24 0-.43.17-.47.41l-.36 2.54c-.59.24-1.13.57-1.62.94l-2.39-.96c-.22-.08-.47 0-.59.22L2.74 8.87c-.12.21-.08.47.12.61l2.03 1.58c-.05.31-.09.63-.09.94s.02.63.07.94l-2.03 1.58c-.18.14-.23.41-.12.61l1.92 3.32c.12.22.37.29.59.22l2.39-.96c.5.38 1.03.7 1.62.94l.36 2.54c.05.24.24.41.48.41h3.84c.24 0 .44-.17.47-.41l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.22.08.47 0 .59-.22l1.92-3.32c.12-.22.07-.47-.12-.61l-2.01-1.58zM12 15.6c-1.98 0-3.6-1.62-3.6-3.6s1.62-3.6 3.6-3.6 3.6 1.62 3.6 3.6-1.62 3.6-3.6 3.6z" fill="currentColor"/></svg>
        </button>
        {#if menuOpen}
          <button type="button" class="mv-menu-backdrop" onclick={() => (menuOpen = false)} aria-label={t('pc_closeMenu')}></button>
          <div class="mv-menu" role="menu">
            {#each QUALITY_IDS as qid (qid)}
              <button type="button" class="mv-menu-item" class:mv-menu-item--active={tile.quality === qid} role="menuitemradio" aria-checked={tile.quality === qid} onclick={() => changeQuality(qid)}>
                <span>{qualityLabel(qid)}</span>
                {#if tile.quality === qid}<svg viewBox="0 0 24 24" width="12" height="12" aria-hidden="true"><path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41L9 16.17z" fill="currentColor"/></svg>{/if}
              </button>
            {/each}
          </div>
        {/if}
      </div>

      <span class="mv-spacer"></span>

      <!-- Keyboard-accessible reorder (the drag handle is mouse/pointer only).
           ◀/▶ swap this tile with its neighbour; focus stays on the button. -->
      <button type="button" class="mv-ctrl mv-reorder" onclick={() => tileStore.move(tile.id, -1)} aria-label={t('mv_moveLeft')} use:tooltip={t('mv_moveLeft')}>
        <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><path d="M14 6l-6 6 6 6V6z" fill="currentColor"/></svg>
      </button>
      <button type="button" class="mv-ctrl mv-reorder" onclick={() => tileStore.move(tile.id, 1)} aria-label={t('mv_moveRight')} use:tooltip={t('mv_moveRight')}>
        <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><path d="M10 6l6 6-6 6V6z" fill="currentColor"/></svg>
      </button>

      <button type="button" class="mv-ctrl mv-close" onclick={closeTile} aria-label={t('mv_closeTile')} use:tooltip={t('mv_closeTile')}>
        <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>
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
  /* Authority tile gets an accent ring so the audio source is obvious. */
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
  .mv-tile-channel--dim { opacity: 0.55; }

  /* Drag affordances. Dragging tiles are dimmed + scaled slightly; a valid drop
     target gets an accent ring. Playback is NOT interrupted (keyed each moves the
     DOM node; the <video>/hls.js survive the reparent). */
  .mv-tile--dragging { opacity: 0.4; }
  .mv-tile--drop-target { box-shadow: inset 0 0 0 2px var(--accent); }

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
    transition: opacity 120ms, background 120ms;
  }
  .mv-drag-handle:hover { opacity: 1; background: rgba(0, 0, 0, 0.8); }
  .mv-drag-handle:active { cursor: grabbing; }
  .mv-reorder { color: var(--text-secondary); }
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
  .mv-overlay-title { font-size: 13px; font-weight: 600; text-align: center; padding: 0 10px; }
  .mv-spinner {
    width: 26px;
    height: 26px;
    border: 3px solid rgba(255, 255, 255, 0.25);
    border-top-color: #fff;
    border-radius: 50%;
    animation: mv-spin 0.8s linear infinite;
  }
  @keyframes mv-spin { to { transform: rotate(360deg); } }

  .mv-tile-controls {
    position: absolute;
    left: 0; right: 0; bottom: 0;
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
  .mv-ctrl:hover { background: var(--bg-hover-faint); }
  .mv-ctrl--on { color: var(--accent); }
  .mv-close:hover { background: rgba(229, 72, 77, 0.25); }
  .mv-volume {
    flex: 0 0 64px;
    height: 3px;
    appearance: none;
    -webkit-appearance: none;
    background: var(--track);
    border-radius: 2px;
    cursor: pointer;
  }
  .mv-volume::-webkit-slider-thumb { appearance: none; -webkit-appearance: none; width: 10px; height: 10px; border-radius: 50%; background: var(--text-primary); }
  .mv-volume::-moz-range-thumb { width: 10px; height: 10px; border-radius: 50%; background: var(--text-primary); border: none; }
  .mv-spacer { flex: 1 1 auto; }
  .mv-menu-wrap { position: relative; }
  .mv-menu-backdrop { position: fixed; inset: 0; background: transparent; border: none; cursor: default; z-index: 5; }
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
  .mv-menu-item:hover { background: var(--bg-hover); }
  .mv-menu-item--active { color: var(--accent); }
</style>
