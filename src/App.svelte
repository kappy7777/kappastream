<script lang="ts">
  import { onMount, tick } from 'svelte'
  import Hls from 'hls.js'
  import { invoke, isTauri } from '@tauri-apps/api/core'
  import { getCurrentWindow } from '@tauri-apps/api/window'
  import { loadChannelEmotes, loadGlobalEmotes, buildEmoteMap, renderMessage, parseTwitchEmoteTag, type Emote, type RenderedMessagePart } from './lib/emotes'
  import './lib/emote.css'
  import { parseIrcEvent, mergeRoomState, composeUsernoticeFallback, DELETED_MESSAGE_CLASS, isMessageStricken, type ParsedMessage, type BadgeInfo, type IrcEvent, type RoomState } from './lib/irc'
  import Sidebar from './lib/Sidebar.svelte'
  import PlayerControls from './lib/PlayerControls.svelte'
  import Settings from './lib/Settings.svelte'
  import NotifyMenu from './lib/NotifyMenu.svelte'
  import SearchBox from './lib/SearchBox.svelte'
  import BrowseView from './lib/BrowseView.svelte'
  import ChannelContent from './lib/ChannelContent.svelte'
  import { settings } from './lib/settings.svelte.ts'
  import { buildHlsConfig } from './lib/hls-config'
  import { pipController } from './lib/pip-controller.svelte.ts'
  import { fetchLiveStatus, type LiveStatus, favoritesStore, isValidChannelName, normalizeChannelName } from './lib/favorites.svelte'
  import type { ChannelVideo, ChannelClip } from './lib/gql'
  import { notifications } from './lib/notifications.svelte.ts'
  import { tooltip } from './lib/tooltip.ts'
  import { tooltipState } from './lib/tooltip.svelte.ts'
  import kappaUrl from './assets/kappa.png'

  type ConnectionStatus = 'idle' | 'connecting' | 'connected' | 'disconnected' | 'error'
  type PlayerStatus = 'idle' | 'resolving' | 'loading' | 'playing' | 'paused' | 'offline' | 'error'

  interface ChatMessage {
    // 'message' = normal PRIVMSG; 'notice' = a USERNOTICE line (subs, raids,
    // announcements). Notices render only when the chat-subnotices toggle is
    // on; with all toggles off a notice entry produces no DOM, so the baseline
    // chat is byte-identical.
    kind: 'message' | 'notice'
    id: string
    username: string
    color: string
    raw: string
    parts: RenderedMessagePart[]
    badges: BadgeInfo[]
    isAction: boolean
    emoteOnly: boolean
    timestamp: number
    // bits amount for cheers (Toggle D), null otherwise. Always stored; the
    // bits indicator is rendered only under settings.chatBits.
    bits: number | null
    // `user-id` of the sender — the stable key CLEARCHAT matches on. Always
    // stored on a PRIVMSG.
    userId: string | null
    // Moderation (Toggle C). ALWAYS recorded from CLEARMSG / CLEARCHAT
    // regardless of settings, so flipping the toggle on retroactively strikes
    // already-deleted messages still in the buffer. Presentation is gated by
    // isMessageStricken(settings.chatModeration, deleted).
    deleted: boolean
    deletedReason: string | null
    // USERNOTICE-only (kind === 'notice'): Twitch's rendered system line and
    // the msg-id (sub/raid/…). Null for normal messages.
    systemText: string | null
    noticeMsgId: string | null
  }

  let channelInput = $state('')
  let browseOpen = $state(false)
  let channelJoined: string | null = $state(null)
  let status = $state<ConnectionStatus>('idle')
  let messages: ChatMessage[] = $state([])
  // Current chat modes for the joined channel (Toggle B). Merged from
  // ROOMSTATE events via mergeRoomState — never replaced, so a single-tag
  // change message does not reset the other modes. Reset on disconnect.
  let roomState = $state<RoomState>({})
  let emoteStatus = $state<'idle' | 'loading' | 'ready' | 'error'>('idle')

  let playerStatus = $state<PlayerStatus>('idle')
  let playerError = $state('')
  let videoEl = $state<HTMLVideoElement | undefined>(undefined)
  let quality = $state<string>('best')
  let pendingQuality: string | null = $state(null)
  let activeStatus: LiveStatus = $state({ state: 'unknown' })

  // VOD / clip playback mode. 'live' is the default (coupled chat + live
  // stream). 'vod' / 'clip' swap the player source to a past broadcast (HLS via
  // resolve_vod) or a clip (direct MP4 via GQL videoQualities) and STOP live
  // chat — a VOD/clip has no live chat. `playerActive` reuses the player
  // subtree (which otherwise renders only when chat is connected) so the
  // <video> + controls exist in VOD/clip mode too. Restored to 'live' on any
  // channel (re)connect (see connect()).
  type Playback = { kind: 'live' } | { kind: 'vod'; id: string; title: string } | { kind: 'clip'; slug: string; title: string }
  let playback = $state<Playback>({ kind: 'live' })
  // The scroll container that reveals the channel-content sections below the
  // fold. Reset to the top on every channel change.
  let videoScrollEl = $state<HTMLElement | null>(null)
  let contentRef = $state<HTMLElement | null>(null)

  const SIDEBAR_VIS_KEY = 'twitch-sidebar-visible-v3'
  function loadSidebarMode(): 'full' | 'icons' | 'hidden' {
    try {
      const v = localStorage.getItem(SIDEBAR_VIS_KEY)
      if (v === 'false') return 'hidden'
      if (v === 'icons') return 'icons'
      if (v === 'true') return 'full'
      if (v === 'full') return 'full'
      if (v === 'hidden') return 'hidden'
      return 'full'
    } catch {
      return 'full'
    }
  }
  let sidebarMode = $state(loadSidebarMode())
  let aboutOpen = $state(false)
  let tooltipEl: HTMLElement | undefined = $state()
  let tooltipPos = $state({ left: 0, top: 0 })
  let probeEl: HTMLElement | undefined = $state()
  // k = visual pixels per CSS pixel for a position:fixed element under the
  // current UI-scale zoom. Chromium and webkit2gtk disagree on how
  // documentElement zoom re-scales fixed elements, so instead of assuming a
  // formula we measure it with a hidden probe (see .zoom-probe below). All
  // tooltip math runs in VISUAL space (target/tip rects are visual) and only
  // divides by k at the very end to produce the CSS left/top to set.
  let zoomK = $state(1)

  $effect(() => {
    // Recompute k when the UI scale changes (and once the probe mounts).
    void settings.uiScale
    if (!probeEl) return
    const r = probeEl.getBoundingClientRect()
    zoomK = r.left / 100 || 1
  })

  $effect(() => {
    if (!tooltipState.visible || !tooltipState.rect || !tooltipEl) return
    void zoomK // reposition if the zoom factor changed while a tooltip is up
    const target = tooltipState.rect
    const tip = tooltipEl.getBoundingClientRect()
    // Visual viewport bounds — same visual space as target/tip. Using the
    // documentElement rect (not window.innerWidth, whose zoom space is also
    // engine-dependent) keeps the edge clamp consistent with the rects.
    const root = document.documentElement.getBoundingClientRect()
    const vw = root.width
    const vh = root.height
    const m = 8
    const k = zoomK || 1
    const halfW = tip.width / 2
    let left = target.left + target.width / 2
    let top = target.bottom + m
    if (left - halfW < m) left = halfW + m
    else if (left + halfW > vw - m) left = vw - halfW - m
    if (top + tip.height > vh - m) {
      const flipped = target.top - tip.height - m
      top = flipped >= m ? flipped : Math.max(m, vh - tip.height - m)
    }
    tooltipPos = { left: left / k, top: top / k }
  })

  function openAbout(): void {
    aboutOpen = true
  }

  // ---- Custom title bar (the main window is decorations:false) ----
  // The top header doubles as the window's title bar: draggable via
  // data-tauri-drag-region, hosts the window controls (minimize/maximize/
  // close), and the window gets edge resize handles below — a borderless
  // window gets no server-side resize edges on Wayland. Mirrors PipWindow.
  function currentWin() {
    // Returns the Tauri Window handle, or null when not running under Tauri
    // (so callers' `?.` chains no-op cleanly outside the app shell).
    return isTauri() ? getCurrentWindow() : null
  }

  let isMaximized = $state(false)
  const winResizeUnlisteners: Array<() => void> = []

  // Tauri's startResizeDragging takes a ResizeDirection union it doesn't
  // export, so derive the type from the typed method signature.
  type ResizeDirection = Parameters<ReturnType<typeof getCurrentWindow>['startResizeDragging']>[0]
  function winMinimize(): void { void currentWin()?.minimize().catch(() => { /* ignore */ }) }
  function winToggleMaximize(): void { void currentWin()?.toggleMaximize().catch(() => { /* ignore */ }) }
  function winClose(): void { void currentWin()?.close().catch(() => { /* ignore */ }) }
  function startWinResize(direction: ResizeDirection): void { void currentWin()?.startResizeDragging(direction).catch(() => { /* ignore */ }) }

  // Double-click on empty title-bar space toggles maximize. Tauri's drag.js
  // would also fire its own internal_toggle_maximize on double-click of a
  // drag region — but we deliberately do NOT grant allow-internal-toggle-
  // maximize (see capabilities), so this explicit handler is the sole path
  // (granting it would double-toggle: maximize then restore). Double-clicks
  // that land on an interactive control (buttons/inputs) are ignored.
  function onTitleDblClick(e: MouseEvent): void {
    const t = e.target as HTMLElement | null
    if (t && t.closest('button, input, a, [contenteditable="true"]')) return
    winToggleMaximize()
  }
  function closeAbout(): void {
    aboutOpen = false
  }
  function onAboutKeydown(e: KeyboardEvent): void {
    if (aboutOpen && e.key === 'Escape') {
      e.preventDefault()
      closeAbout()
    }
  }

  // Keep the PiP controller aware of the main video element so it can mute it
  // while the floating PiP window is open and restore it on close.
  $effect(() => {
    pipController.setVideoElement(videoEl)
  })

  // PiP runs in a SEPARATE Tauri webview with its own <video>/hls.js, so taking
  // over the stream does not require the main player to keep fetching segments.
  // When PiP opens we disconnect the main player (freeing its network/CPU); when
  // PiP closes we resume the main stream automatically. `mainStoppedForPip`
  // distinguishes a PiP-driven stop (auto-resumed) from a deliberate Stop-button
  // press (stays stopped until the user hits Resume).
  let mainStoppedForPip = false
  $effect(() => {
    const pipOpen = pipController.isOpen
    // PiP takeover is live-only: never stop a VOD/clip to hand off to PiP.
    if (playback.kind !== 'live') return
    if (pipOpen) {
      if (channelJoined && (playerStatus === 'playing' || playerStatus === 'paused')) {
        disconnectStream(true)
        mainStoppedForPip = true
      }
    } else if (mainStoppedForPip) {
      mainStoppedForPip = false
      if (channelJoined && status === 'connected') void loadStream(channelJoined, quality)
    }
  })

  function resumeStream(): void {
    if (channelJoined && status === 'connected') void loadStream(channelJoined, quality)
  }

  // Reset the channel-content scroll position to the top whenever the joined
  // channel changes (so a new channel always starts at the player, not partway
  // down the previous channel's content).
  $effect(() => {
    void channelJoined
    if (videoScrollEl) videoScrollEl.scrollTop = 0
  })

  let socket: WebSocket | null = null
  let hls: Hls | null = null
  let streamGeneration = 0
  let manifestTimeout: ReturnType<typeof setTimeout> | null = null
  // Stall self-recovery for live playback (esp. low-latency, whose tiny
  // buffer underruns on any hiccup). Because the live edge keeps advancing
  // while stalled, currentTime falls behind the live window and the element
  // hangs — in webkit2gtk it actually goes to `paused`, so we watch BOTH
  // `waiting` (underrun) and a non-user `pause`. After a short grace we jump
  // to the live edge and resume. Cleared on `playing` and on teardown.
  let stallRecoverTimer: ReturnType<typeof setTimeout> | null = null
  let userPaused = false
  const STALL_RECOVER_GRACE_MS = 1_000

  function clearStallRecover(): void {
    if (stallRecoverTimer) {
      clearTimeout(stallRecoverTimer)
      stallRecoverTimer = null
    }
  }

  function scheduleStallRecover(): void {
    clearStallRecover()
    stallRecoverTimer = setTimeout(() => {
      stallRecoverTimer = null
      const el = videoEl
      if (!el) return
      // Snap to the live edge where buffer exists (the app only plays live
      // Twitch). Prefer hls.js's computed liveSyncPosition; fall back to the
      // end of the seekable window.
      const liveEdge = hls?.liveSyncPosition
        ?? (el.seekable.length > 0 ? el.seekable.end(el.seekable.length - 1) : NaN)
      if (Number.isFinite(liveEdge)) {
        try { el.currentTime = Math.max(liveEdge - 1.5, 0) } catch { /* ignore */ }
      }
      void el.play().catch(() => { /* ignore — user can still press play */ })
    }, STALL_RECOVER_GRACE_MS)
  }

  function onVideoWaiting(): void {
    // Stall recovery is live-only — VOD/clip buffering resumes natively.
    if (playback.kind !== 'live') return
    // Buffer underrun — schedule recovery (a momentary blip refills and
    // fires `playing`, cancelling this).
    scheduleStallRecover()
  }

  function onVideoPause(): void {
    // Stall recovery is live-only — never force-seek a paused VOD/clip.
    if (playback.kind !== 'live') return
    // Ignore user-initiated pauses (togglePlay sets userPaused first). A
    // stall-induced pause in webkit2gtk lands here with userPaused still
    // false — recover it.
    if (userPaused) return
    scheduleStallRecover()
  }

  function onVideoPlaying(): void {
    clearStallRecover()
    userPaused = false
  }
  let cancelPendingAttach: (() => void) | null = null
  let emoteAbort: AbortController | null = null
  let thirdPartyMap = new Map<string, Emote>()
  let chatEl = $state<HTMLElement | undefined>(undefined)

  let mainEl = $state<HTMLElement | undefined>(undefined)
  let stacked = $state(false)

  function toggleStacked(): void {
    stacked = !stacked
  }

  // Chat box size — user-resizable in both layout modes. Persists across
  // sessions/streams via localStorage. The current value is used as the
  // default when opening a new stream.
  const CHAT_SIZE_KEY = 'app-chat-size-v1'
  const CHAT_SIZE_MIN = 200
  const CHAT_SIZE_MAX = 1500

  function loadChatSize(): number {
    try {
      const v = localStorage.getItem(CHAT_SIZE_KEY)
      if (v) {
        const n = parseInt(v, 10)
        if (Number.isFinite(n) && n >= CHAT_SIZE_MIN && n <= CHAT_SIZE_MAX) return n
      }
    } catch {
      /* ignore */
    }
    return 220
  }
  function saveChatSize(v: number): void {
    try {
      localStorage.setItem(CHAT_SIZE_KEY, String(v))
    } catch {
      /* ignore */
    }
  }

  let chatSize = $state(loadChatSize())
  let isChatResizing = $state(false)
  let chatResizeStart = { x: 0, y: 0, size: 0 }

  function onChatResizerPointerDown(e: PointerEvent): void {
    e.preventDefault()
    isChatResizing = true
    chatResizeStart = { x: e.clientX, y: e.clientY, size: chatSize }
    ;(e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId)
    document.addEventListener('pointermove', onChatResizerPointerMove)
    document.addEventListener('pointerup', onChatResizerPointerUp)
    document.addEventListener('pointercancel', onChatResizerPointerUp)
  }

  function onChatResizerPointerMove(e: PointerEvent): void {
    if (!isChatResizing) return
    const dx = e.clientX - chatResizeStart.x
    const dy = e.clientY - chatResizeStart.y
    // In stacked mode the resizer is horizontal → drag Y changes height.
    // In side-by-side the resizer is vertical → drag X changes width.
    const delta = stacked ? dy : dx
    const next = chatResizeStart.size - delta
    chatSize = Math.max(CHAT_SIZE_MIN, Math.min(CHAT_SIZE_MAX, next))
  }

  function onChatResizerPointerUp(): void {
    if (!isChatResizing) return
    isChatResizing = false
    document.removeEventListener('pointermove', onChatResizerPointerMove)
    document.removeEventListener('pointerup', onChatResizerPointerUp)
    document.removeEventListener('pointercancel', onChatResizerPointerUp)
  }

  $effect(() => {
    saveChatSize(chatSize)
  })

  function toggleSidebar(): void {
    if (settings.theaterMode) settings.setTheaterMode(false)
    sidebarMode = sidebarMode === 'full' ? 'icons' : sidebarMode === 'icons' ? 'hidden' : 'full'
  }

  $effect(() => {
    try {
      localStorage.setItem(SIDEBAR_VIS_KEY, sidebarMode)
    } catch {
      /* ignore */
    }
  })

  function randomUsername(): string {
    const n = Math.floor(Math.random() * 1_000_000)
    return 'justinfan' + n.toString().padStart(6, '0')
  }

  function teardownPlayer(keepPip = false): void {
    streamGeneration++
    // No stream anymore; close the floating PiP window if it is open (unless
    // we are stopping the main player *because* PiP just took over — then the
    // PiP stream must keep playing).
    if (!keepPip) pipController.clearStream()
    if (manifestTimeout) {
      clearTimeout(manifestTimeout)
      manifestTimeout = null
    }
    cancelPendingAttach?.()
    cancelPendingAttach = null
    clearStallRecover()
    if (hls) {
      try { hls.destroy() } catch (_e) { /* ignore */ }
      hls = null
    }
    if (videoEl) {
      try {
        videoEl.pause()
        videoEl.removeAttribute('src')
        videoEl.load()
      } catch (_e) { /* ignore */ }
    }
  }

  // Centralized video-only disconnect: tears down HLS + the <video> element and
  // returns the player to its idle state, but leaves the IRC chat connection
  // intact. This is the single entry point shared by the Stop button, the mpv
  // handoff, close-to-tray (via disconnect()), and the PiP takeover.
  // `keepPip` keeps the floating PiP window alive (used when stopping the main
  // player because PiP just became the active player).
  function disconnectStream(keepPip = false): void {
    teardownPlayer(keepPip)
    playerStatus = 'idle'
    playerError = ''
  }

  async function resolveStream(channel: string, q: string): Promise<{ ok: true; url: string } | { ok: false; offline: boolean; unavailable?: boolean; error?: string }> {
    type ResolveRaw = { ok?: boolean; url?: string | null; offline?: boolean; error?: string | null; unavailable?: boolean; quality?: string | null }
    let raw: ResolveRaw
    try {
      raw = (await invoke('resolve_stream', { channel, quality: q, lowLatency: settings.lowLatency })) as ResolveRaw
    } catch (err) {
      const msg = typeof err === 'string'
        ? err
        : err instanceof Error ? err.message : JSON.stringify(err)
      return { ok: false, offline: false, error: 'invoke failed: ' + msg }
    }
    if (raw.offline) return { ok: false, offline: true }
    if (!raw.ok || !raw.url) {
      return { ok: false, offline: false, unavailable: raw.unavailable === true, error: raw.error ?? 'unknown resolve error' }
    }
    return { ok: true, url: raw.url }
  }

  async function handoffToPlayer(): Promise<void> {
    try {
      let r: { ok: boolean; error?: string | null }
      if (playback.kind === 'vod') {
        r = (await invoke('launch_player', {
          vodId: playback.id,
          quality,
          lowLatency: settings.lowLatency,
        })) as { ok: boolean; error?: string | null }
      } else if (playback.kind === 'clip') {
        r = (await invoke('launch_player', {
          clipSlug: playback.slug,
          quality: 'best',
          lowLatency: settings.lowLatency,
        })) as { ok: boolean; error?: string | null }
      } else {
        const channel = channelJoined
        if (!channel) return
        r = (await invoke('launch_player', {
          channel,
          quality,
          lowLatency: settings.lowLatency,
        })) as { ok: boolean; error?: string | null }
      }
      if (r.ok) {
        // mpv is now the sole player; stop the in-app stream (HLS + video) to
        // free network/system resources. The IRC chat connection is left intact.
        disconnectStream()
        showNotifToast('Launching in mpv…')
      } else {
        showNotifToast(r.error || 'Could not launch mpv')
      }
    } catch (err) {
      const msg = typeof err === 'string' ? err : (err as Error)?.message ?? 'Could not launch mpv'
      showNotifToast(msg)
    }
  }

  function isFatalNetworkishError(data: { fatal: boolean; type: string; details?: string }): boolean {
    if (!data.fatal) return false
    const NETWORKISH = new Set([
      'manifestLoadError',
      'manifestLoadTimeOut',
      'manifestParsingError',
      'levelLoadError',
      'levelLoadTimeOut',
      'audioTrackLoadError',
      'audioPlaylistLoadError',
      'fragmentLoadError',
      'fragLoadError',
      'fragLoadTimeOut',
    ])
    return NETWORKISH.has(data.type) || NETWORKISH.has(data.details ?? '')
  }

  function isCurrentStream(generation: number, channel: string, q: string): boolean {
    return generation === streamGeneration && channelJoined === channel && quality === q
  }

  async function attachStream(channel: string, q: string, url: string, generation: number): Promise<{ ok: true } | { ok: false; error: string }> {
    if (!videoEl) return { ok: false, error: 'no video element' }
    if (!isCurrentStream(generation, channel, q)) return { ok: false, error: 'stale stream request' }

    const sourceUrl = url

    if (Hls.isSupported()) {
      if (hls) {
        clearStallRecover()
        try { hls.destroy() } catch (_e) { /* ignore */ }
      }
      const instance = new Hls(buildHlsConfig(settings.lowLatency))
      hls = instance

      return await new Promise((resolve) => {
        let resolvedFlag = false
        const finish = (r: { ok: true } | { ok: false; error: string }) => {
          if (resolvedFlag) return
          resolvedFlag = true
          if (manifestTimeout) {
            clearTimeout(manifestTimeout)
            manifestTimeout = null
          }
          if (cancelPendingAttach === cancel) cancelPendingAttach = null
          resolve(r)
        }
        const cancel = () => finish({ ok: false, error: 'stale stream request' })
        cancelPendingAttach = cancel

        instance.on(Hls.Events.MANIFEST_PARSED, () => {
          if (!isCurrentStream(generation, channel, q)) {
            finish({ ok: false, error: 'stale stream request' })
            return
          }
          playerStatus = 'loading'
          videoEl?.play().then(() => {
            if (isCurrentStream(generation, channel, q)) playerStatus = 'playing'
          }).catch(() => {
            if (isCurrentStream(generation, channel, q)) playerStatus = 'paused'
          })
          finish({ ok: true })
        })

        instance.on(Hls.Events.ERROR, (_event, data) => {
          if (!data.fatal) return
          try { instance.destroy() } catch (_e) { /* ignore */ }
          if (!isCurrentStream(generation, channel, q)) {
            finish({ ok: false, error: 'stale stream request' })
            return
          }
          if (isFatalNetworkishError(data)) {
            finish({ ok: false, error: 'network/manifest error: ' + data.type + ' (' + (data.details ?? '') + ')' })
          } else {
            finish({ ok: false, error: 'hls error: ' + data.type + ' (' + (data.details ?? '') + ')' })
          }
        })

        instance.loadSource(sourceUrl)
        instance.attachMedia(videoEl!)

        manifestTimeout = setTimeout(() => {
          manifestTimeout = null
          if (!resolvedFlag) {
            try { instance.destroy() } catch (_e) { /* ignore */ }
            finish({ ok: false, error: 'timeout waiting for manifest' })
          }
        }, 20_000)
      })
    }

    if (videoEl.canPlayType('application/vnd.apple.mpegurl')) {
      videoEl.src = sourceUrl
      try {
        await videoEl.play()
        if (!isCurrentStream(generation, channel, q)) return { ok: false, error: 'stale stream request' }
        playerStatus = 'playing'
        return { ok: true }
      } catch (err) {
        return { ok: false, error: 'native HLS play failed: ' + (err as Error).message }
      }
    }

    return { ok: false, error: 'HLS playback is not supported' }
  }

  async function startStream(channel: string): Promise<void> {
    const savedQ = settings.getQualityFor(channel)
    quality = savedQ ?? pendingQuality ?? quality
    pendingQuality = null
    await loadStream(channel, quality)
  }

  async function loadStream(channel: string, q: string): Promise<void> {
    const generation = ++streamGeneration
    playerError = ''
    playerStatus = 'resolving'
    clearStallRecover()
    // A new stream load implies the user wants playback; clear any stale
    // pause-intent from the previous channel so stalls on the new one recover.
    userPaused = false

    const resolved = await resolveStream(channel, q)
    if (!isCurrentStream(generation, channel, q)) return
    if (!resolved.ok) {
      if (resolved.offline) {
        playerStatus = 'offline'
        playerError = ''
        return
      }
      if (resolved.unavailable) {
        // streamlink rejected the requested quality (e.g. channel doesn't have
        // 720p60 today, only audio_only + 480p). Falling back to "best" gets
        // the user back to a watchable stream without forcing them to switch
        // channels. We only fall back once per loadStream call so a pathological
        // failure on "best" itself still surfaces as an error.
        if (q !== 'best') {
          quality = 'best'
          if (channelJoined) settings.setQualityFor(channelJoined, 'best')
          showNotifToast('Quality "' + q + '" is not available — using Source')
          await loadStream(channel, 'best')
          return
        }
        playerStatus = 'error'
        playerError = 'Quality "' + q + '" is not available for this stream'
        return
      }
      playerStatus = 'error'
      playerError = resolved.error ?? 'failed to resolve stream'
      return
    }

    playerStatus = 'loading'
    const attach = await attachStream(channel, q, resolved.url, generation)
    if (!isCurrentStream(generation, channel, q)) return
    if (attach.ok) {
      // Hand the resolved playlist URL to the PiP controller. If the floating
      // window is open it reloads; otherwise it is ready for the next open.
      pipController.setStream({ url: resolved.url, channel, quality: q })
      return
    }
    playerStatus = 'error'
    playerError = attach.error
  }

  async function changeQuality(newQuality: string): Promise<void> {
    if (newQuality === quality) return
    quality = newQuality
    // VOD: re-resolve at the new quality (not persisted as a channel pref).
    if (playback.kind === 'vod') {
      teardownPlayer()
      await loadVod(playback.id, newQuality)
      return
    }
    // Clip quality is fixed (best available from videoQualities).
    if (playback.kind === 'clip') return
    if (channelJoined) settings.setQualityFor(channelJoined, newQuality)
    if (!channelJoined) {
      pendingQuality = newQuality
      return
    }
    teardownPlayer()
    await loadStream(channelJoined, quality)
  }

  let reconnectAttempts = 0
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null
  let connectionGeneration = 0
  let activeConnection: { channel: string; nick: string; generation: number } | null = null

  const MAX_RECONNECT_ATTEMPTS = 10
  const RECONNECT_BASE_MS = 1_000
  const RECONNECT_MAX_MS = 30_000

  function scheduleReconnect(generation: number): void {
    const connection = activeConnection
    if (!connection || connection.generation !== generation) return
    if (reconnectTimer) return
    if (reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
      status = 'disconnected'
      return
    }
    const delay = Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * 2 ** reconnectAttempts)
    reconnectAttempts++
    status = 'connecting'
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null
      if (activeConnection?.generation !== generation) return
      openSocket(activeConnection, true)
    }, delay)
  }

  function openSocket(connection: { channel: string; nick: string; generation: number }, isReconnect: boolean): void {
    if (activeConnection?.generation !== connection.generation) return
    let ws: WebSocket
    try {
      ws = new WebSocket('wss://irc-ws.chat.twitch.tv:443')
    } catch (_e) {
      scheduleReconnect(connection.generation)
      return
    }
    socket = ws

    ws.onopen = () => {
      if (activeConnection?.generation !== connection.generation || socket !== ws) {
        ws.close()
        return
      }
      ws.send('CAP REQ :twitch.tv/tags twitch.tv/commands')
      ws.send('NICK ' + connection.nick)
      ws.send('JOIN #' + connection.channel)
      reconnectAttempts = 0
      const needsInitialStream = !isReconnect || channelJoined !== connection.channel
      status = 'connected'
      channelJoined = connection.channel
      if (needsInitialStream) void startStream(connection.channel)
    }

    ws.onmessage = (ev) => {
      if (activeConnection?.generation === connection.generation && socket === ws) {
        handleMessage(ev.data as string, ws)
      }
    }

    ws.onerror = () => {
      /* let onclose handle reconnect */
    }

    ws.onclose = () => {
      if (activeConnection?.generation !== connection.generation || socket !== ws) return
      socket = null
      scheduleReconnect(connection.generation)
    }
  }

  async function loadEmotes(channel: string, generation: number, signal: AbortSignal): Promise<void> {
    try {
      const [channelEmotes, globalEmotes] = await Promise.all([
        loadChannelEmotes(channel, signal),
        loadGlobalEmotes(signal),
      ])
      if (signal.aborted || activeConnection?.generation !== generation) return
      thirdPartyMap = buildEmoteMap([...channelEmotes, ...globalEmotes])
      emoteStatus = 'ready'
    } catch (_e) {
      if (!signal.aborted && activeConnection?.generation === generation) emoteStatus = 'error'
    }
  }

  function connect(): void {
    const channel = normalizeChannelName(channelInput)
    if (!isValidChannelName(channel)) {
      showNotifToast('Invalid channel name.')
      return
    }
    // Any (re)connect returns to live mode — clears a prior VOD/clip playback.
    playback = { kind: 'live' }
    disconnect()

    reconnectAttempts = 0
    status = 'connecting'
    channelInput = ''
    const connection = { channel, nick: randomUsername(), generation: connectionGeneration }
    activeConnection = connection
    emoteAbort = new AbortController()
    emoteStatus = 'loading'
    void loadEmotes(channel, connection.generation, emoteAbort.signal)
    openSocket(connection, false)
  }

  function handleMessage(raw: string, ws: WebSocket): void {
    for (const rawLine of raw.split(/\r?\n/)) {
      const line = rawLine.trim()
      if (!line) continue
      if (line.startsWith('PING ')) {
        ws.send('PONG ' + line.slice(5))
        continue
      }
      const ev: IrcEvent | null = parseIrcEvent(line)
      if (!ev) continue
      if (!channelJoined || ev.channel !== channelJoined) continue

      switch (ev.type) {
        case 'PRIVMSG':
          handlePrivmsg(ev)
          break
        case 'USERNOTICE':
          handleUsernotice(ev)
          break
        case 'ROOMSTATE':
          // PARSING IS UNGATED: state is always merged; only the indicator's
          // visibility keys off settings.chatRoomstate in the template.
          roomState = mergeRoomState(roomState, ev)
          break
        case 'CLEARMSG':
          // Record the deletion always; presentation is gated.
          markMessageDeleted(ev.targetMsgId, 'Message deleted')
          break
        case 'CLEARCHAT':
          handleClearchat(ev)
          break
      }
    }
  }

  function handlePrivmsg(ev: Extract<IrcEvent, { type: 'PRIVMSG' }>): void {
    const parts = renderMessage({
      message: ev.message,
      thirdParty: thirdPartyMap,
      twitchRanges: ev.twitchEmotes,
    })

    // Derive emoteOnly once from the rendered parts: at least one emote
    // and every non-emote part whitespace-only. The old expression
    // (`/^\s*$/.test(msg.raw.replace(/\s/g, ''))`) could only ever be true
    // for a whitespace-only message and the .emote-only CSS rule did not
    // exist, so the class was inert.
    const emoteOnly =
      parts.some((p) => p.type === 'emote') &&
      parts.every((p) => p.type === 'emote' || p.text.trim() === '')

    messages.push({
      kind: 'message',
      id: ev.id || crypto.randomUUID(),
      username: ev.displayName,
      color: ev.color,
      raw: ev.message,
      parts,
      badges: ev.badges,
      isAction: ev.isAction,
      emoteOnly,
      timestamp: ev.timestamp,
      bits: ev.bits,
      userId: ev.userId,
      deleted: false,
      deletedReason: null,
      systemText: null,
      noticeMsgId: null,
    })

    fireMentionNotification(ev.message, ev.displayName, ev.color)

    if (stickyBottom && messages.length > 500) messages.splice(0, messages.length - 500)
  }

  function handleUsernotice(ev: Extract<IrcEvent, { type: 'USERNOTICE' }>): void {
    // PREFER Twitch's own system-msg; fall back to msg-param composition only
    // when it is absent (composeUsernoticeFallback never returns empty).
    const systemText = ev.systemMsg || composeUsernoticeFallback(ev.msgId, ev.tags)

    // A USERNOTICE may carry a user message in the trailing parameter (resub
    // comments, announcements). Render it through the same emote pipeline so
    // emotes in the message body work.
    let parts: RenderedMessagePart[] = []
    if (ev.message) {
      const ranges = parseTwitchEmoteTag(ev.emotes, ev.message)
      parts = renderMessage({
        message: ev.message,
        thirdParty: thirdPartyMap,
        twitchRanges: ranges,
      })
    }

    messages.push({
      kind: 'notice',
      id: crypto.randomUUID(),
      username: ev.login ?? '',
      color: '#ffffff',
      raw: ev.message ?? '',
      parts,
      badges: [],
      isAction: false,
      emoteOnly: false,
      timestamp: Date.now(),
      bits: null,
      userId: null,
      deleted: false,
      deletedReason: null,
      systemText,
      noticeMsgId: ev.msgId,
    })

    if (stickyBottom && messages.length > 500) messages.splice(0, messages.length - 500)
  }

  function handleClearchat(ev: Extract<IrcEvent, { type: 'CLEARCHAT' }>): void {
    // No target user => whole room cleared. Otherwise match by user-id (the
    // stable key), never by display name.
    if (ev.targetUserId === null) {
      for (const m of messages) {
        if (m.kind === 'message') markEntryDeleted(m, 'Chat cleared')
      }
      return
    }
    const reason =
      ev.banDuration !== null ? `Timed out (${ev.banDuration}s)` : 'Banned'
    for (const m of messages) {
      if (m.kind === 'message' && m.userId === ev.targetUserId) {
        markEntryDeleted(m, reason)
      }
    }
  }

  // Strike a single message by id (CLEARMSG). A target-msg-id for a message no
  // longer in the buffer (scrolled out / dropped past the 500 cap) is a no-op —
  // never an error.
  function markMessageDeleted(targetMsgId: string, reason: string): void {
    if (!targetMsgId) return
    for (const m of messages) {
      if (m.kind === 'message' && m.id === targetMsgId) markEntryDeleted(m, reason)
    }
  }

  function markEntryDeleted(m: ChatMessage, reason: string): void {
    if (m.deleted) return
    m.deleted = true
    m.deletedReason = reason
  }

  function disconnect(): void {
    connectionGeneration++
    activeConnection = null
    emoteAbort?.abort()
    emoteAbort = null
    if (reconnectTimer) {
      clearTimeout(reconnectTimer)
      reconnectTimer = null
    }
    if (socket) {
      socket.onclose = null
      socket.close()
      socket = null
    }
    disconnectStream()
    mainStoppedForPip = false
    channelJoined = null
    status = 'idle'
    messages = []
    roomState = {}
    emoteStatus = 'idle'
    thirdPartyMap = new Map()
  }

  function selectChannel(name: string): void {
    channelInput = name
    void connect()
  }

  // Connect from Browse — connects via the same path, then closes the overlay.
  function browseSelectChannel(name: string): void {
    selectChannel(name)
    browseOpen = false
  }

  // ---- VOD / clip playback -------------------------------------------------
  // A VOD/clip has no live chat, so entering playback STOPS the IRC socket but
  // deliberately keeps `channelJoined` so "Back to live" can restore the same
  // channel. The live stream + chat are re-attached via the normal connect()
  // path (backToLive → selectChannel). Stall recovery is live-only.

  // Stop the IRC chat connection without clearing `channelJoined` or the video
  // element (the caller swaps the player source). Mirrors disconnect()'s socket
  // teardown but preserves channel identity for back-to-live.
  function stopChatOnly(): void {
    connectionGeneration++
    activeConnection = null
    emoteAbort?.abort()
    emoteAbort = null
    if (reconnectTimer) {
      clearTimeout(reconnectTimer)
      reconnectTimer = null
    }
    if (socket) {
      socket.onclose = null
      socket.close()
      socket = null
    }
    status = 'idle'
  }

  // Attach an HLS source (VOD playlist) with a non-low-latency config and no
  // live generation coupling. Reuses the live hls.js path's error discipline.
  async function attachMediaHls(url: string): Promise<{ ok: true } | { ok: false; error: string }> {
    if (!videoEl) return { ok: false, error: 'no video element' }
    teardownPlayer()
    clearStallRecover()
    if (Hls.isSupported()) {
      const instance = new Hls(buildHlsConfig(false))
      hls = instance
      return await new Promise((resolve) => {
        let done = false
        let to: ReturnType<typeof setTimeout> | null = null
        const finish = (r: { ok: true } | { ok: false; error: string }) => {
          if (done) return
          done = true
          if (to) clearTimeout(to)
          resolve(r)
        }
        instance.on(Hls.Events.MANIFEST_PARSED, () => {
          videoEl?.play().catch(() => { /* autoplay can be blocked; user presses play */ })
          finish({ ok: true })
        })
        instance.on(Hls.Events.ERROR, (_e, data) => {
          if (!data.fatal) return
          try { instance.destroy() } catch (_e) { /* ignore */ }
          finish({ ok: false, error: 'media error: ' + data.type })
        })
        instance.loadSource(url)
        instance.attachMedia(videoEl!)
        to = setTimeout(() => finish({ ok: false, error: 'timeout waiting for manifest' }), 20_000)
      })
    }
    if (videoEl.canPlayType('application/vnd.apple.mpegurl')) {
      videoEl.src = url
      try {
        await videoEl.play()
        return { ok: true }
      } catch (err) {
        return { ok: false, error: 'playback failed: ' + (err as Error).message }
      }
    }
    return { ok: false, error: 'HLS playback is not supported' }
  }

  // Attach a direct MP4 (clip) — native <video>, no hls.js.
  async function attachClipMp4(url: string): Promise<{ ok: true } | { ok: false; error: string }> {
    if (!videoEl) return { ok: false, error: 'no video element' }
    teardownPlayer()
    clearStallRecover()
    try {
      videoEl.src = url
      await videoEl.play()
      return { ok: true }
    } catch (err) {
      return { ok: false, error: 'clip playback failed: ' + (err as Error).message }
    }
  }

  async function loadVod(videoId: string, q: string): Promise<void> {
    playerError = ''
    playerStatus = 'resolving'
    type ResolveRaw = { ok?: boolean; url?: string | null; error?: string | null }
    let raw: ResolveRaw
    try {
      raw = (await invoke('resolve_vod', { videoId, quality: q })) as ResolveRaw
    } catch (err) {
      const msg = typeof err === 'string' ? err : err instanceof Error ? err.message : JSON.stringify(err)
      playerStatus = 'error'
      playerError = 'invoke failed: ' + msg
      return
    }
    if (!raw.ok || !raw.url) {
      playerStatus = 'error'
      playerError = raw.error ?? 'failed to load video'
      return
    }
    playerStatus = 'loading'
    // Rewrite the cloudfront/ttvnw URL through the ksvod proxy: the VOD CDN
    // doesn't send CORS headers so hls.js's XHR is blocked. The ksvod scheme is
    // handled by a Rust URI-scheme protocol (vod_proxy.rs) that fetches via
    // reqwest and adds Access-Control-Allow-Origin. Relative segment URLs in
    // the manifest resolve against the ksvod base URL automatically.
    const proxyUrl = raw.url.replace('https://', 'ksvod://localhost/')
    const attach = await attachMediaHls(proxyUrl)
    if (attach.ok) {
      playerStatus = 'playing'
      if (channelJoined) pipController.setStream({ url: proxyUrl, channel: channelJoined, quality: q })
      return
    }
    playerStatus = 'error'
    playerError = attach.error
  }

  async function playVod(video: ChannelVideo): Promise<void> {
    if (!channelJoined) return
    playback = { kind: 'vod', id: video.id, title: video.title || 'Past broadcast' }
    messages = []
    roomState = {}
    stopChatOnly()
    userPaused = false
    if (videoScrollEl) videoScrollEl.scrollTop = 0
    await loadVod(video.id, quality)
  }

  async function playClip(clip: ChannelClip): Promise<void> {
    if (!channelJoined) return
    playback = { kind: 'clip', slug: clip.slug, title: clip.title || 'Clip' }
    messages = []
    roomState = {}
    stopChatOnly()
    userPaused = false
    if (videoScrollEl) videoScrollEl.scrollTop = 0
    playerError = ''
    playerStatus = 'resolving'
    type ResolveRaw = { ok?: boolean; url?: string | null; error?: string | null }
    let raw: ResolveRaw
    try {
      raw = (await invoke('resolve_clip', { slug: clip.slug, quality: 'best' })) as ResolveRaw
    } catch (err) {
      const msg = typeof err === 'string' ? err : err instanceof Error ? err.message : JSON.stringify(err)
      playerStatus = 'error'
      playerError = 'invoke failed: ' + msg
      return
    }
    if (!raw.ok || !raw.url) {
      playerStatus = 'error'
      playerError = raw.error ?? 'failed to load clip'
      return
    }
    playerStatus = 'loading'
    const attach = await attachClipMp4(raw.url)
    if (attach.ok) {
      playerStatus = 'playing'
      if (channelJoined) pipController.setStream({ url: raw.url, channel: channelJoined, quality: 'best', mediaKind: 'mp4' })
      return
    }
    playerStatus = 'error'
    playerError = attach.error
  }

  function scrollToContent(): void {
    if (contentRef && videoScrollEl) {
      const refTop = contentRef.getBoundingClientRect().top
      const scrollTop = videoScrollEl.getBoundingClientRect().top
      const offset = refTop - scrollTop + videoScrollEl.scrollTop
      videoScrollEl.scrollTo({ top: offset, behavior: 'smooth' })
    }
  }

  // Restore the live stream + chat for the current channel.
  function backToLive(): void {
    const ch = channelJoined
    playback = { kind: 'live' }
    if (ch) selectChannel(ch)
  }

  function onStopClick(): void {
    // In VOD/clip mode, Stop returns to the live channel.
    if (playback.kind !== 'live') {
      backToLive()
      return
    }
    disconnect()
  }

  function onMpvClick(): void {
    void handoffToPlayer()
  }

  // --------------------------------------------------------------------------

  function formatViewers(n: number): string {
    if (n < 1000) return n.toString()
    if (n < 1_000_000) {
      const k = n / 1000
      return (k < 100 ? k.toFixed(1).replace(/\.0$/, '') : Math.round(k).toString()) + 'K'
    }
    return (n / 1_000_000).toFixed(1).replace(/\.0$/, '') + 'M'
  }

  function formatChatTime(ts: number): string {
    const d = new Date(ts)
    const h = d.getHours().toString().padStart(2, '0')
    const m = d.getMinutes().toString().padStart(2, '0')
    return h + ':' + m
  }

  function formatBits(n: number): string {
    if (n < 1000) return String(n)
    if (n < 1_000_000) {
      const k = n / 1000
      return (k < 100 ? k.toFixed(1).replace(/\.0$/, '') : Math.round(k).toString()) + 'K'
    }
    return (n / 1_000_000).toFixed(1).replace(/\.0$/, '') + 'M'
  }

  // followers-only is in minutes (-1 off, 0 any follower, N minutes); slow is
  // in seconds. Compact labels for the chat-mode indicator (Toggle B).
  function formatFollowersMin(n: number): string {
    if (n <= 0) return ''
    if (n < 60) return n + 'm'
    const h = Math.floor(n / 60)
    const m = n % 60
    return m ? `${h}h ${m}m` : `${h}h`
  }

  function formatSlow(s: number): string {
    if (s <= 0) return ''
    if (s >= 60) {
      const m = Math.round(s / 60)
      return m + 'm'
    }
    return s + 's'
  }

  function roomStateActive(rs: RoomState): boolean {
    return (
      rs.emoteOnly === true ||
      rs.subsOnly === true ||
      rs.r9k === true ||
      (rs.followersOnly !== undefined && rs.followersOnly >= 0) ||
      (rs.slow !== undefined && rs.slow > 0)
    )
  }

  let stickyBottom = $state(true)
  let erroredBadges = $state<Set<string>>(new Set())
  function markBadgeErrored(url: string): void {
    if (erroredBadges.has(url)) return
    const next = new Set(erroredBadges)
    next.add(url)
    erroredBadges = next
  }
  let erroredEmotes = $state<Set<string>>(new Set())
  function markEmoteErrored(url: string): void {
    if (erroredEmotes.has(url)) return
    const next = new Set(erroredEmotes)
    next.add(url)
    erroredEmotes = next
  }
  let newMessageCount = $state(0)
  let scrollBaseline = 0
  const SCROLL_BOTTOM_THRESHOLD = 32

  function onChatScroll(): void {
    const el = chatEl
    if (!el) return
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight
    const wasSticky = stickyBottom
    stickyBottom = distanceFromBottom <= SCROLL_BOTTOM_THRESHOLD
    if (stickyBottom) {
      newMessageCount = 0
      scrollBaseline = messages.length
    } else if (wasSticky && !stickyBottom) {
      scrollBaseline = messages.length
      newMessageCount = 0
    }
  }

  function jumpToPresent(): void {
    if (chatEl) {
      chatEl.scrollTop = chatEl.scrollHeight
      stickyBottom = true
      newMessageCount = 0
      scrollBaseline = messages.length
    }
  }

  $effect(() => {
    const len = messages.length
    void tick().then(() => {
      if (!chatEl) return
      if (stickyBottom) {
        chatEl.scrollTop = chatEl.scrollHeight
        scrollBaseline = len
      } else {
        const added = len - scrollBaseline
        if (added > 0) newMessageCount += added
        scrollBaseline = len
      }
    })
  })

  $effect(() => {
    if (status === 'idle') {
      stickyBottom = true
      newMessageCount = 0
      scrollBaseline = 0
    }
  })

  $effect(() => {
    void settings.sortMode
    favoritesStore.refresh()
  })

  // Low-latency toggle: re-resolve the current stream so streamlink re-fetches
  // with/without --twitch-low-latency and hls.js re-attaches with the matching
  // live-sync config. The prev-value guard ensures this only fires on an actual
  // toggle, not on unrelated channel/quality changes (which load the stream
  // themselves).
  let prevLowLatency = settings.lowLatency
  $effect(() => {
    const ll = settings.lowLatency
    if (ll === prevLowLatency) return
    prevLowLatency = ll
    if (channelJoined) void loadStream(channelJoined, quality)
  })

  let activeStatusToken = 0
  $effect(() => {
    const channel = channelJoined
    if (!channel) {
      activeStatus = { state: 'unknown' }
      return
    }
    const cached = favoritesStore.getStatus(channel)
    if (cached && cached.status.state !== 'unknown') {
      activeStatus = cached.status
    } else {
      activeStatus = { state: 'unknown' }
    }
    const myToken = ++activeStatusToken
    void (async () => {
      try {
        const s = await fetchLiveStatus(channel)
        if (myToken !== activeStatusToken) return
        activeStatus = s
      } catch {
        /* ignore */
      }
    })()
  })

  onMount(() => () => disconnect())

  // Track maximize state so the title-bar control shows restore vs. maximize.
  onMount(() => {
    const win = currentWin()
    if (win) {
      void win.isMaximized().then((m) => { isMaximized = m }).catch(() => { /* ignore */ })
      void win.onResized(() => {
        void win.isMaximized().then((m) => { isMaximized = m }).catch(() => { /* ignore */ })
      }).then((un) => { if (un) winResizeUnlisteners.push(un) }).catch(() => { /* ignore */ })
    }
    return () => {
      for (const u of winResizeUnlisteners) { try { u() } catch { /* ignore */ } }
      winResizeUnlisteners.length = 0
    }
  })

  // Close-to-tray: when enabled (default), intercept the window close so it
  // hides to the tray instead of quitting — keeping the app running in the
  // background so favorite live-notifications still fire. The process is
  // fully quit via the tray's Quit menu item. Reading settings.closeToTray
  // at event time keeps this reactive to the Settings toggle. Before hiding we
  // tear down the stream (video AND chat) so nothing keeps downloading
  // segments or playing audio while the window is hidden.
  onMount(() => {
    if (!isTauri()) return
    let unlistenClose: (() => void) | null = null
    void getCurrentWindow()
      .onCloseRequested((event) => {
        if (settings.closeToTray) {
          event.preventDefault()
          disconnect()
          void getCurrentWindow().hide().catch(() => { /* ignore */ })
        }
      })
      .then((un) => { unlistenClose = un })
      .catch(() => { /* ignore */ })
    return () => { try { unlistenClose?.() } catch { /* ignore */ } }
  })

  const playerLabel: Record<PlayerStatus, string> = {
    idle: '',
    resolving: 'Resolving stream…',
    loading: 'Loading stream…',
    playing: '',
    paused: 'Paused',
    offline: 'Channel is offline',
    error: 'Stream error',
  }

  let notifToast = $state<string | null>(null)
  let notifToastTimer: ReturnType<typeof setTimeout> | null = null
  let notifVersion = $state(0)

  let channelNotifOn = $derived.by(() => {
    void notifVersion
    return channelJoined ? favoritesStore.hasNotifEnabled(channelJoined) : false
  })

  let notifBlocked = $derived(false)

  async function openChatPopout(): Promise<void> {
    if (!channelJoined) return
    const url = `https://twitch.tv/${channelJoined}`
    const invoke = (window as unknown as {
      __TAURI_INTERNALS__?: { invoke(cmd: string, args?: unknown): Promise<unknown> }
    }).__TAURI_INTERNALS__!.invoke
    try {
      const result = await invoke('open_url_robust', { url })
      if (import.meta.env.DEV) console.log('chat-link: opener result', result)
      const r = result as {
        ok: boolean
        method: string
        path: string | null
        exit_code: number | null
        stderr: string
        url: string
        inherited_path: string | null
      }
      if (!r.ok) {
        const detail = import.meta.env.DEV
          ? r.path
            ? ` (${r.path}, exit ${r.exit_code})`
            : r.inherited_path
              ? ` (PATH was: ${r.inherited_path})`
              : ''
          : ''
        const error = import.meta.env.DEV ? r.stderr || 'unknown error' : 'all opener methods failed'
        showNotifToast(`Couldn't open channel via ${r.method}${detail}: ${error}`)
      }
    } catch (err) {
      if (import.meta.env.DEV) console.error('chat-link: open_url_robust threw', err)
      const detail = import.meta.env.DEV ? ` — error: ${err}` : ''
      showNotifToast(`Couldn't open channel${detail}`)
    }
  }

  async function ensureNotifPermission(): Promise<boolean> {
    try {
      const mod = await import('@tauri-apps/plugin-notification')
      let granted = await mod.isPermissionGranted()
      if (!granted) {
        const permission = await mod.requestPermission()
        granted = permission === 'granted'
      }
      return granted
    } catch {
      return false
    }
  }

  function notifId(key: string): number {
    let h = 0
    for (let i = 0; i < key.length; i++) {
      h = ((h << 5) - h + key.charCodeAt(i)) | 0
    }
    return h
  }

  function sendNotif(title: string, opts: { body?: string; tag?: string; icon?: string }): void {
    void import('@tauri-apps/plugin-notification')
      .then(({ sendNotification }) => {
        try {
          const id = opts.tag ? notifId(opts.tag) : undefined
          sendNotification({ title, body: opts.body, id })
        } catch {
          /* ignore */
        }
      })
      .catch(() => { /* ignore */ })
  }

  function escapeRegex(s: string): string {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  }

  function fireMentionNotification(raw: string, username: string, color: string): void {
    const target = settings.mentionUsername
    if (!target) return
    if (username.toLowerCase() === target) return
    const re = new RegExp('(?:^|\\s)@' + escapeRegex(target) + '(?![a-z0-9_])', 'i')
    if (!re.test(raw)) return
    const channel = channelJoined ? '#' + channelJoined : 'chat'
    const preview = raw.replace(/\s+/g, ' ').trim().slice(0, 120)
    notifications.record('mention', 'Mentioned in ' + channel, username + ': ' + preview, channelJoined)
    sendNotif('Mentioned in ' + channel, {
      body: username + ': ' + preview,
      tag: 'mention:' + channelJoined,
      icon: '/favicon.svg',
    })
  }

  function showNotifToast(msg: string): void {
    notifToast = msg
    if (notifToastTimer) clearTimeout(notifToastTimer)
    notifToastTimer = setTimeout(() => {
      notifToast = null
      notifToastTimer = null
    }, 3500)
  }

  async function toggleChannelNotif(): Promise<void> {
    if (!channelJoined) return
    const channel = channelJoined
    if (favoritesStore.hasNotifEnabled(channel)) {
      favoritesStore.setNotifEnabled(channel, false)
      notifVersion++
      return
    }
    const granted = await ensureNotifPermission()
    if (!granted) {
      showNotifToast('Notifications were not granted.')
      notifVersion++
      return
    }
    favoritesStore.setNotifEnabled(channel, true)
    notifVersion++
    showNotifToast(`Will notify when ${channel} goes live.`)
  }

  let favVersion = $state(0)
  let channelIsFavorite = $derived.by(() => {
    void favVersion
    return channelJoined ? favoritesStore.has(channelJoined) : false
  })

  function toggleChannelFavorite(): void {
    if (!channelJoined) return
    const channel = channelJoined
    if (favoritesStore.has(channel)) {
      favoritesStore.remove(channel)
      showNotifToast(`Removed ${channel} from favorites.`)
    } else {
      const ok = favoritesStore.add(channel)
      showNotifToast(ok ? `Added ${channel} to favorites.` : 'Favorites limit reached.')
    }
    favVersion++
  }

  $effect(() => {
    return () => {
      if (notifToastTimer) {
        clearTimeout(notifToastTimer)
        notifToastTimer = null
      }
    }
  })

  const isPlayerBusy = $derived(
    playerStatus === 'resolving' || playerStatus === 'loading',
  )
  // The player subtree (video + controls) renders when chat is connected OR a
  // VOD/clip is playing. Declared alongside the other player deriveds (after
  // status has been reassigned in connect()/disconnect(), so it is not
  // control-flow-narrowed to its initial literal).
  const playerActive = $derived(status === 'connected' || playback.kind !== 'live')
  const showPlayerOverlay = $derived(
    playerStatus === 'resolving' ||
      playerStatus === 'loading' ||
      playerStatus === 'offline' ||
      playerStatus === 'error',
  )
</script>

<svelte:window onkeydown={onAboutKeydown} />

<div class="app" class:app--sidebar-icons={sidebarMode === 'icons'} class:app--sidebar-hidden={sidebarMode === 'hidden'}>
  <!-- svelte-ignore a11y_no_static_element_interactions
       Double-click on empty title-bar space toggles maximize (mouse-only
       convenience; the dedicated maximize button is the accessible path). -->
  <header class="bar" data-tauri-drag-region ondblclick={onTitleDblClick}>
    <div class="bar-left" data-tauri-drag-region>
      <button
        type="button"
        class="logo logo-btn"
        onclick={openAbout}
        aria-label="About"
      >
        <img src={kappaUrl} alt="" />
      </button>
      <button
        type="button"
        class="sidebar-toggle"
        onclick={toggleSidebar}
        aria-label={sidebarMode === 'full' ? 'Minimize favorites' : sidebarMode === 'icons' ? 'Hide favorites' : 'Show favorites'}
        use:tooltip={sidebarMode === 'full' ? 'Minimize favorites' : sidebarMode === 'icons' ? 'Hide favorites' : 'Show favorites'}
      >
        {sidebarMode === 'full' ? '◀' : sidebarMode === 'icons' ? '⏵' : '▶'}
      </button>
      <button
        type="button"
        class="browse-btn"
        onclick={() => (browseOpen = true)}
        aria-label="Browse channels and categories"
      >
        Browse
      </button>
    </div>
    <div class="bar-center" data-tauri-drag-region>
      <SearchBox onselect={selectChannel} />
    </div>
    <div class="bar-right" data-tauri-drag-region>
      <NotifyMenu />
      <button
        type="button"
        class="layout-toggle"
        onclick={toggleStacked}
        aria-label={stacked ? 'Switch to side-by-side layout' : 'Stack chat below video'}
        use:tooltip={stacked ? 'Switch to side-by-side layout' : 'Stack chat below video'}
      >
        <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
          {#if stacked}
            <rect x="2" y="2" width="6" height="12" rx="1" fill="currentColor"/>
            <rect x="9" y="2" width="5" height="12" rx="1" fill="currentColor" opacity="0.4"/>
          {:else}
            <rect x="2" y="2" width="12" height="6" rx="1" fill="currentColor"/>
            <rect x="2" y="9" width="12" height="5" rx="1" fill="currentColor" opacity="0.4"/>
          {/if}
        </svg>
      </button>
      <Settings />
      <div class="win-controls">
        <button
          type="button"
          class="win-btn"
          onclick={winMinimize}
          aria-label="Minimize"
        >
          <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">
            <rect x="3" y="7.4" width="10" height="1.6" rx="0.8" fill="currentColor"/>
          </svg>
        </button>
        <button
          type="button"
          class="win-btn"
          onclick={winToggleMaximize}
          aria-label={isMaximized ? 'Restore' : 'Maximize'}
        >
          {#if isMaximized}
            <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.4">
              <rect x="5.5" y="2.5" width="8" height="8" rx="1.2"/>
              <rect x="2.5" y="5.5" width="8" height="8" rx="1.2" fill="var(--bg-panel)"/>
              <rect x="2.5" y="5.5" width="8" height="8" rx="1.2"/>
            </svg>
          {:else}
            <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.5">
              <rect x="3" y="3" width="10" height="10" rx="1.5"/>
            </svg>
          {/if}
        </button>
        <button
          type="button"
          class="win-btn win-btn--close"
          onclick={winClose}
          aria-label="Close"
        >
          <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round">
            <path d="M4 4 L12 12 M12 4 L4 12"/>
          </svg>
        </button>
      </div>
    </div>
  </header>

  {#if emoteStatus === 'loading'}
    <div class="banner">Loading emotes…</div>
  {:else if emoteStatus === 'error'}
    <div class="banner banner--error">Failed to load third-party emotes. Twitch native emotes still work.</div>
  {/if}

  <div class="body">
    {#if !settings.theaterMode && sidebarMode !== 'hidden'}
      <Sidebar currentChannel={channelJoined} onselect={selectChannel} iconsOnly={sidebarMode === 'icons'} {zoomK} />
    {/if}
    <div class="main" class:main--stacked={stacked} bind:this={mainEl}>
    <div class="video-pane">
    <div class="video-scroll" bind:this={videoScrollEl}>
    <div class="player-stage">
    {#if playback.kind !== 'live'}
      <div class="playback-banner">
        <button type="button" class="playback-back" onclick={backToLive}>◀ Back to live</button>
        <span class="playback-title">{playback.title}</span>
      </div>
    {/if}
    <section class="player" class:player--active={playerActive}>
      {#if playerActive}
<video
        bind:this={videoEl}
        class="video"
        autoplay
        muted
        playsinline
        onwaiting={onVideoWaiting}
        onplaying={onVideoPlaying}
        onpause={onVideoPause}
      ></video>
        <PlayerControls video={videoEl} visible={playerActive && (playerStatus === 'playing' || playerStatus === 'paused')} {quality} onqualitychange={(q) => void changeQuality(q)} onmpv={onMpvClick} onstop={onStopClick} onplayintent={(p) => { userPaused = !p }} {activeStatus} />
        {#if showPlayerOverlay}
          <div class="player-overlay" class:player-overlay--error={playerStatus === 'error'}>
            {#if isPlayerBusy}
              <div class="spinner" aria-hidden="true"></div>
              <p class="overlay-text">{playerLabel[playerStatus]}</p>
            {:else if playerStatus === 'offline'}
              <p class="overlay-title">{playerLabel.offline}</p>
              <p class="overlay-sub">Waiting for them to go live…</p>
            {:else if playerStatus === 'error'}
              <p class="overlay-title">{playerLabel.error}</p>
              <p class="overlay-sub">{playerError}</p>
            {/if}
          </div>
        {:else if playerStatus === 'idle' && pipController.isOpen}
          <div class="player-overlay">
            <p class="overlay-title">Playing in Picture-in-Picture</p>
            <p class="overlay-sub">Close the PiP window to resume here</p>
          </div>
        {:else if playerStatus === 'idle'}
          <div class="player-overlay">
            <p class="overlay-title">Stream stopped</p>
            <button type="button" class="overlay-action" onclick={resumeStream}>Resume stream</button>
          </div>
        {/if}
      {:else}
        <div class="player-placeholder">Stream will appear here when you connect</div>
      {/if}
    </section>

    {#if !settings.theaterMode}
    <div class="stream-info">
      {#if activeStatus.state === 'live'}
        <div class="stream-info-row stream-info-row--main">
          {#if activeStatus.avatarUrl}
            <img class="stream-info-avatar" src={activeStatus.avatarUrl} alt="" />
          {/if}
          <span class="stream-info-live" use:tooltip={'Live'}><span class="stream-info-live-dot"></span>LIVE</span>
          <span class="stream-info-title" use:tooltip={activeStatus.title || 'Live'}>{activeStatus.title || 'Live'}</span>
        </div>
        <div class="stream-info-row stream-info-row--meta">
          {#if activeStatus.game}<span class="stream-info-game">{activeStatus.game}</span>{/if}
          <span class="stream-info-dot">·</span>
          <span class="stream-info-viewers">{formatViewers(activeStatus.viewers)} viewers</span>
          {#if activeStatus.uptime}
            <span class="stream-info-dot">·</span>
            <span class="stream-info-uptime">Up {activeStatus.uptime}</span>
          {/if}
        </div>
      {:else if activeStatus.state === 'offline' && channelJoined}
        <div class="stream-info-row stream-info-row--offline">
          {#if activeStatus.avatarUrl}
            <img class="stream-info-avatar stream-info-avatar--offline" src={activeStatus.avatarUrl} alt="" />
          {/if}
          <span class="stream-info-offline">Offline</span>
          <span class="stream-info-channel">{channelJoined}</span>
        </div>
      {:else if channelJoined}
        <div class="stream-info-row stream-info-row--loading">
           <span class="stream-info-channel">{channelJoined}</span>
         </div>
        {/if}
        {#if channelJoined}
          <div class="stream-info-actions">
            <button
              type="button"
              class="notif-toggle favorite-toggle"
              class:favorite-toggle--on={channelIsFavorite}
              aria-pressed={channelIsFavorite}
              onclick={toggleChannelFavorite}
              use:tooltip={channelIsFavorite ? `Remove ${channelJoined} from favorites` : `Add ${channelJoined} to favorites`}
            >
              <svg class="notif-toggle-icon" viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
                {#if channelIsFavorite}
                  <path d="M8 13.5l-1.2-.95C3.4 9.55 1 7.4 1 4.7 1 2.55 2.74 1 5 1c1.34 0 2.62.6 3.5 1.62A4.62 4.62 0 0 1 11 1c2.26 0 4 1.55 4 3.7 0 2.7-2.4 4.85-5.8 7.85L8 13.5z" fill="currentColor"/>
                {:else}
                  <path d="M8 13.5l-1.2-.95C3.4 9.55 1 7.4 1 4.7 1 2.55 2.74 1 5 1c1.34 0 2.62.6 3.5 1.62A4.62 4.62 0 0 1 11 1c2.26 0 4 1.55 4 3.7 0 2.7-2.4 4.85-5.8 7.85L8 13.5zM8 12.3l.45-.36C11.4 9.36 13.5 7.5 13.5 4.7 13.5 3.2 12.4 2.2 11 2.2c-1.06 0-2.06.55-2.65 1.45L8 4.3l-.35-.65C7.06 2.75 6.06 2.2 5 2.2 3.6 2.2 2.5 3.2 2.5 4.7c0 2.8 2.1 4.66 5.05 7.24l.45.36z" fill="currentColor"/>
                {/if}
              </svg>
              <span class="notif-toggle-label">{channelIsFavorite ? 'Favorite' : 'Add favorite'}</span>
            </button>
            <button
              type="button"
              class="notif-toggle"
              class:notif-toggle--on={channelNotifOn}
              aria-pressed={channelNotifOn}
              onclick={toggleChannelNotif}
              use:tooltip={notifBlocked ? 'Notifications blocked in browser settings' : channelNotifOn ? 'Disable live notifications for this channel' : 'Notify me when this channel goes live'}
            >
              <svg class="notif-toggle-icon" viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
                {#if channelNotifOn}
                  <path d="M8 2a4 4 0 0 0-4 4v3.5L2.5 11h11L12 9.5V6a4 4 0 0 0-4-4zm0 12a1.5 1.5 0 0 0 1.5-1.5h-3A1.5 1.5 0 0 0 8 14z" fill="currentColor"/>
                {:else}
                  <path d="M8 2a4 4 0 0 0-4 4v3.5L2.5 11h11L12 9.5V6a4 4 0 0 0-4-4zm0 12a1.5 1.5 0 0 0 1.5-1.5h-3A1.5 1.5 0 0 0 8 14zM3 3l10 10" stroke="currentColor" stroke-width="1.5" fill="none" stroke-linecap="round"/>
                {/if}
              </svg>
              <span class="notif-toggle-label">{channelNotifOn ? 'Notify on' : 'Notify off'}</span>
            </button>
            {#if !stacked}
              <button
                type="button"
                class="notif-toggle"
                onclick={scrollToContent}
                use:tooltip={'Videos & Clips'}
              >
                <svg class="notif-toggle-icon" viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
                  <path d="M2 2a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V3a1 1 0 0 0-1-1H2zm1 2h10v8H3V4zm3 1v6l4-3-4-3z" fill="currentColor"/>
                </svg>
                <span class="notif-toggle-label">Videos</span>
              </button>
            {/if}
          </div>
        {/if}
      </div>
      {/if}
    </div>
    {#if !settings.theaterMode && !stacked && channelJoined}
      <div bind:this={contentRef}>
        <ChannelContent channel={channelJoined} onplayVod={playVod} onplayClip={playClip} />
      </div>
    {/if}
    </div>
    </div>

    {#if settings.chatVisible}
    <div
      class="chat-resizer"
      class:chat-resizer--stacked={stacked}
      class:chat-resizer--dragging={isChatResizing}
      onpointerdown={onChatResizerPointerDown}
      role="slider"
      aria-orientation={stacked ? 'horizontal' : 'vertical'}
      aria-label="Resize chat"
      aria-valuenow={chatSize}
      aria-valuemin={CHAT_SIZE_MIN}
      aria-valuemax={CHAT_SIZE_MAX}
      tabindex="0"
    ></div>
    <main class="chat" class:chat--hidden={!settings.chatVisible} style:--chat-size={`${chatSize}px`}>
      {#if settings.chatRoomstate && channelJoined && roomStateActive(roomState)}
        <div class="chat-modes" role="status" aria-label="Chat modes">
          {#if roomState.subsOnly}
            <span class="mode-pill">Subscribers-only</span>
          {/if}
          {#if roomState.followersOnly !== undefined && roomState.followersOnly >= 0}
            <span class="mode-pill">Followers-only{roomState.followersOnly > 0 ? ` (${formatFollowersMin(roomState.followersOnly)})` : ''}</span>
          {/if}
          {#if roomState.slow !== undefined && roomState.slow > 0}
            <span class="mode-pill">Slow ({formatSlow(roomState.slow)})</span>
          {/if}
          {#if roomState.emoteOnly}
            <span class="mode-pill">Emote-only</span>
          {/if}
          {#if roomState.r9k}
            <span class="mode-pill">R9K</span>
          {/if}
        </div>
      {/if}
      <div class="chat-scroll" bind:this={chatEl} onscroll={onChatScroll}>
        {#if messages.length === 0}
          <p class="placeholder">
            {status === 'connected' ? 'Waiting for messages…' : 'Join a channel to see chat'}
          </p>
        {:else}
          {#each messages as msg (msg.id)}
          {#if msg.kind === 'notice'}
            {#if settings.chatSubnotices}
              <div class="message message--notice">
                {#if settings.chatTimestamps}
                  <span class="message-time" use:tooltip={new Date(msg.timestamp).toLocaleString()}>{formatChatTime(msg.timestamp)}</span>
                {/if}
                <span class="notice-system">{msg.systemText}</span>
                {#if msg.parts.length > 0}
                  <span class="notice-msg">{#each msg.parts as part}{#if part.type === 'text'}{part.text}{:else if erroredEmotes.has(part.url)}<span class="emote-fallback">{part.name}</span>{:else}<img
                    class="emote"
                    class:emote--twitch={part.provider === 'twitch'}
                    src={part.url}
                    alt={part.name}
                    title={part.name}
                    loading="lazy"
                    onerror={() => markEmoteErrored(part.url)}
                  />{/if}{/each}</span>
                {/if}
              </div>
            {/if}
          {:else}
          <div
            class="message{isMessageStricken(settings.chatModeration, msg.deleted) ? ' ' + DELETED_MESSAGE_CLASS : ''}"
            class:action={msg.isAction}
            class:emote-only={msg.emoteOnly && !msg.isAction}
            title={isMessageStricken(settings.chatModeration, msg.deleted) ? (msg.deletedReason ?? '') : ''}
          >
            {#if settings.chatTimestamps}
              <span class="message-time" use:tooltip={new Date(msg.timestamp).toLocaleString()}>{formatChatTime(msg.timestamp)}</span>
            {/if}
            {#each msg.badges as b (b.id + b.version)}
              {#if b.imageUrl && !erroredBadges.has(b.imageUrl)}
                <img
                  class="badge badge--{b.id}"
                  src={b.imageUrl}
                  alt={b.label}
                  use:tooltip={b.label}
                  loading="lazy"
                  onerror={() => markBadgeErrored(b.imageUrl!)}
                />
              {/if}
            {/each}
            <span class="username" style="color: {msg.color}">{msg.username}</span>{#if !msg.isAction}<span class="username-sep">:</span>{/if}
            {#if msg.isAction}<span class="action-mark"> </span>{/if}
            <span class="text">{#each msg.parts as part}{#if part.type === 'text'}{part.text}{:else if erroredEmotes.has(part.url)}<span class="emote-fallback">{part.name}</span>{:else}<img
              class="emote"
              class:emote--twitch={part.provider === 'twitch'}
              src={part.url}
              alt={part.name}
              title={part.name}
              loading="lazy"
              onerror={() => markEmoteErrored(part.url)}
            />{/if}{/each}</span>
            {#if settings.chatBits && msg.bits}
              <span class="bits-badge" use:tooltip={`${msg.bits} bits`}>
                <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">
                  <path d="M8 1l5 5-5 9-5-9z" fill="currentColor"/>
                  <path d="M3 6h10M8 1l3 5-3 9-3-9z" fill="none" stroke="currentColor" stroke-width="0.8" stroke-linejoin="round"/>
                </svg>
                {formatBits(msg.bits)}
              </span>
            {/if}
          </div>
          {/if}
          {/each}
        {/if}
      </div>
      {#if !stickyBottom && messages.length > 0}
        <button type="button" class="float-pill jump-end" onclick={jumpToPresent} title="Jump to the latest message">
          <svg class="float-icon" viewBox="0 0 16 16" width="12" height="12" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
            <path d="M8 3v9M4 8l4 4 4-4"/>
          </svg>
          Back to bottom
          {#if newMessageCount > 0}
            <span class="float-count">{newMessageCount}</span>
          {/if}
        </button>
      {/if}
      {#if channelJoined}
        <button
          type="button"
          class="float-pill chat-link"
          onclick={openChatPopout}
          title={`Open #${channelJoined} on Twitch`}
          aria-label={`Open #${channelJoined} on Twitch`}
        >
          <svg class="chat-link-icon" viewBox="0 0 24 24" width="13" height="13" aria-hidden="true">
            <path d="M14 3v2h3.59l-9.83 9.83 1.41 1.41L19 6.41V10h2V3h-7zM19 19H5V5h7V3H5c-1.11 0-2 .9-2 2v14c0 1.1.89 2 2 2h14c1.1 0 2-.9 2-2v-7h-2v7z" fill="currentColor"/>
          </svg>
        </button>
      {/if}
    </main>
    {/if}
    </div>
  </div>
  {#if notifToast}
    <div class="notif-toast" role="status" aria-live="polite">{notifToast}</div>
  {/if}

  <!-- Global tooltip — driven by the `use:tooltip` action. Positioned with
       position: fixed so it escapes any overflow clipping. Because it lives
       in the zoomed tree, it scales with the app's UI zoom — unlike the
       browser-native `title` tooltips. Tooltip appears BELOW the hovered
       element (centered horizontally, 8px gap). The fav profile tooltips
       in Sidebar.svelte use a different (right-side) layout. -->
  {#if tooltipState.visible && tooltipState.rect}
    <div
      bind:this={tooltipEl}
      class="global-tooltip"
      role="tooltip"
      style:left="{tooltipPos.left}px"
      style:top="{tooltipPos.top}px"
    >{tooltipState.text}</div>
  {/if}

  <!-- Hidden probe used to measure the zoom factor (see zoomK). Never visible. -->
  <div class="zoom-probe" bind:this={probeEl} aria-hidden="true"></div>

  {#if aboutOpen}
    <div class="about-backdrop" onclick={closeAbout} role="presentation"></div>
    <div
      class="about-modal"
      role="dialog"
      aria-modal="true"
      aria-labelledby="about-title"
    >
      <button
        type="button"
        class="about-close"
        onclick={closeAbout}
        aria-label="Close"
      >
        <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
          <path d="M3 3l10 10M13 3L3 13" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
        </svg>
      </button>
      <div id="about-title" class="about-modal-name">Kappastream</div>
      <div class="about-modal-version">v{__APP_VERSION__}</div>
      <p class="about-modal-tagline">Twitch, stripped down to what matters: the stream and the chat.</p>
      <p class="about-modal-body">
        No login, project telemetry, analytics, or project-operated backend. Chat connects anonymously —
        nothing tied to who you are. Network calls go only to the services needed to watch:
        Twitch infrastructure and the open community APIs (7TV, BTTV, FFZ, DecAPI) that power
        emotes and stream info.
      </p>
      <p class="about-modal-body">Stream resolution powered by streamlink.</p>
      <p class="about-modal-tagline about-modal-tagline--last">Built to watch, not to be watched.</p>
      <div class="about-modal-donate">
        <span class="about-modal-donate-label">Donate</span>
        <div class="about-modal-donate-addr-group">
          <span
            class="about-modal-btc-symbol"
            aria-label="Bitcoin"
            title="Bitcoin">₿</span
          >
          <code class="about-modal-donate-addr"
            >bc1qj9ge9ug4pp5mr3g0lepuyyjh4j6sazhg2hgcrv</code
          >
        </div>
      </div>
    </div>
  {/if}

  {#if browseOpen}
    <BrowseView onselect={browseSelectChannel} onclose={() => (browseOpen = false)} />
  {/if}

  <!-- Borderless resize handles. The main window is decorations:false, so on
       Wayland it gets no server-side resize edges; these drive tao's
       interactive resize (mirrors PipWindow.svelte, with all 8 directions
       since the main window has no aspect lock). position:fixed + edge
       anchors are zoom-safe (0 and viewport edges are invariant). -->
  <div class="rz rz-n" aria-hidden="true" onmousedown={() => startWinResize('North')}></div>
  <div class="rz rz-s" aria-hidden="true" onmousedown={() => startWinResize('South')}></div>
  <div class="rz rz-w" aria-hidden="true" onmousedown={() => startWinResize('West')}></div>
  <div class="rz rz-e" aria-hidden="true" onmousedown={() => startWinResize('East')}></div>
  <div class="rz rz-nw" aria-hidden="true" onmousedown={() => startWinResize('NorthWest')}></div>
  <div class="rz rz-ne" aria-hidden="true" onmousedown={() => startWinResize('NorthEast')}></div>
  <div class="rz rz-sw" aria-hidden="true" onmousedown={() => startWinResize('SouthWest')}></div>
  <div class="rz rz-se" aria-hidden="true" onmousedown={() => startWinResize('SouthEast')}></div>
</div>

<style>
  :global(html), :global(body) {
    margin: 0;
    padding: 0;
    background: var(--bg-app);
    color: var(--text-primary);
    font-family: 'Inter', system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif;
    font-size: 13px;
    line-height: 1.4;
    height: 100%;
    width: 100%;
    overflow: hidden;
    -webkit-font-smoothing: antialiased;
    -moz-osx-font-smoothing: grayscale;
  }

  :global(#app) {
    height: 100%;
    width: 100%;
    display: flex;
  }

  :global(::-webkit-scrollbar) {
    width: 8px;
    height: 8px;
  }

  :global(::-webkit-scrollbar-track) {
    background: transparent;
  }

  :global(::-webkit-scrollbar-thumb) {
    background: var(--bg-hover);
    border-radius: 4px;
  }

  :global(::-webkit-scrollbar-thumb:hover) {
    background: var(--track);
  }

  .app {
    display: flex;
    flex-direction: column;
    width: 100%;
    height: 100vh;
    height: 100dvh;
    background: var(--bg-app);
    overflow: hidden;
  }

  .bar {
    display: grid;
    /* Symmetric 1fr tracks flank the center: the middle track sits at the
       bar's true horizontal center regardless of how wide the left/right
       button groups are. The middle track is shrinkable (min 0) and caps at
       23.333% / 336px, so on a narrow window the input shrinks to make room
       for the buttons instead of sliding under them. */
    grid-template-columns: 1fr minmax(0, 23.333%) 1fr;
    gap: 16px;
    /* Now doubles as the title bar (borderless window): tighter vertical
       padding keeps it narrow, like a native headerbar. */
    padding: 4px 12px;
    border-bottom: 1px solid var(--border);
    background: var(--bg-panel);
    align-items: center;
    flex: 0 0 auto;
    user-select: none;
  }

  .bar-left,
  .bar-right {
    display: flex;
    align-items: center;
    gap: 8px;
  }
  /* Pin each side to its track and hug the outer edge so the symmetric
     1fr flanking tracks keep the center track optically centered. */
  .bar-left { grid-column: 1; justify-self: start; }
  .bar-right { grid-column: 3; justify-self: end; }

  /* Window controls (minimize / maximize-restore / close) for the borderless
     title bar. Themed via the app's CSS tokens; close uses the conventional
     red on hover. */
  .win-controls {
    display: flex;
    align-items: center;
    gap: 2px;
    margin-left: 4px;
  }
  .win-btn {
    flex: 0 0 auto;
    width: 30px;
    height: 26px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    padding: 0;
    border: none;
    border-radius: 4px;
    background: transparent;
    color: var(--text-secondary);
    cursor: pointer;
    transition: background 120ms ease, color 120ms ease;
  }
  .win-btn:hover {
    background: var(--bg-hover);
    color: var(--text-primary);
  }
  .win-btn--close:hover {
    background: #e81123;
    color: #fff;
  }

  /* Borderless resize handles. z-index sits above normal content but below
     the about modal (1000/1001) so the modal properly blocks edge-resizing;
     the edges reserve only the outermost ~5px (11px corners), matching how
     native windows behave. Edge-anchored fixed positioning is zoom-safe
     (0 and viewport edges are invariant under CSS zoom). */
  .rz {
    position: fixed;
    z-index: 900;
  }
  .rz-n { top: 0; left: 10px; right: 10px; height: 5px; cursor: ns-resize; }
  .rz-s { bottom: 0; left: 10px; right: 10px; height: 5px; cursor: ns-resize; }
  .rz-w { top: 10px; bottom: 10px; left: 0; width: 5px; cursor: ew-resize; }
  .rz-e { top: 10px; bottom: 10px; right: 0; width: 5px; cursor: ew-resize; }
  .rz-nw { top: 0; left: 0; width: 11px; height: 11px; cursor: nwse-resize; }
  .rz-ne { top: 0; right: 0; width: 11px; height: 11px; cursor: nesw-resize; }
  .rz-sw { bottom: 0; left: 0; width: 11px; height: 11px; cursor: nesw-resize; }
  .rz-se { bottom: 0; right: 0; width: 11px; height: 11px; cursor: nwse-resize; }

  .tauri-diag {
    display: inline-block;
    padding: 2px 6px;
    border-radius: 3px;
    font-size: 10px;
    font-weight: 600;
    letter-spacing: 0.04em;
    background: var(--bg-input);
    color: var(--text-secondary);
    border: 1px solid var(--border);
    font-variant-numeric: tabular-nums;
  }

  .bar-center {
    display: flex;
    justify-content: center;
    min-width: 0;
  }

  .sidebar-toggle {
    flex: 0 0 auto;
    width: 30px;
    height: 30px;
    padding: 0;
    border: none;
    border-radius: 4px;
    background: transparent;
    color: var(--text-secondary);
    font-size: 12px;
    cursor: pointer;
    line-height: 1;
    transition: background 150ms, color 150ms;
  }

  .sidebar-toggle:hover {
    background: var(--bg-hover);
    color: var(--text-primary);
  }

  /* Plain-text "Browse" button — sits right of the sidebar toggle. Matches the
     surrounding title-bar buttons (transparent, themed, hover lifts) but shows
     a word instead of an icon. */
  .browse-btn {
    flex: 0 0 auto;
    height: 30px;
    padding: 0 10px;
    border: none;
    border-radius: 4px;
    background: transparent;
    color: var(--text-secondary);
    font-size: 13px;
    font-weight: 600;
    cursor: pointer;
    line-height: 1;
    transition: background 150ms, color 150ms;
  }

  .browse-btn:hover {
    background: var(--bg-hover);
    color: var(--text-primary);
  }

  .layout-toggle {
    flex: 0 0 auto;
    width: 30px;
    height: 30px;
    padding: 0;
    margin-right: 4px;
    border: none;
    border-radius: 4px;
    background: transparent;
    color: var(--text-secondary);
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: center;
    transition: background 150ms, color 150ms;
  }

  .layout-toggle:hover {
    background: var(--bg-hover);
    color: var(--text-primary);
  }

  .logo-btn {
    flex: 0 0 auto;
    padding: 0;
    border: none;
    cursor: pointer;
    transition: filter 150ms;
  }
  .logo-btn:hover {
    filter: brightness(1.15);
  }
  .logo-btn:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 2px;
  }

  .about-backdrop {
    position: fixed;
    inset: 0;
    background: var(--bg-overlay-strong);
    z-index: 1000;
  }
  .about-modal {
    position: fixed;
    top: 50%;
    left: 50%;
    transform: translate(-50%, -50%);
    z-index: 1001;
    width: min(480px, calc(100vw - 32px));
    max-height: calc(100vh - 64px);
    overflow: auto;
    background: var(--bg-panel);
    border: 1px solid var(--border);
    border-radius: 8px;
    box-shadow: var(--shadow-menu);
    padding: 28px 24px 24px;
    color: var(--text-primary);
    display: flex;
    flex-direction: column;
    gap: 14px;
  }
  .about-close {
    position: absolute;
    top: 8px;
    right: 8px;
    width: 26px;
    height: 26px;
    border-radius: 4px;
    background: transparent;
    border: 1px solid transparent;
    color: var(--text-secondary);
    cursor: pointer;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    padding: 0;
  }
  .about-close:hover {
    background: var(--bg-hover);
    color: var(--text-primary);
  }
  .about-modal-name {
    font-size: 20px;
    font-weight: 700;
    letter-spacing: -0.01em;
  }
  .about-modal-version {
    font-size: 12px;
    color: var(--text-dim);
    margin-top: -10px;
  }
  .about-modal-tagline {
    font-size: 14px;
    font-weight: 600;
    color: var(--text-primary);
    line-height: 1.4;
    margin: 0;
  }
  .about-modal-tagline--last {
    font-style: italic;
    color: var(--accent);
  }
  .about-modal-body {
    font-size: 13px;
    color: var(--text-secondary);
    line-height: 1.55;
    margin: 0;
  }
  .about-modal-donate {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 8px;
    padding-top: 12px;
    margin-top: 2px;
    border-top: 1px solid var(--border);
    font-size: 12px;
  }
  .about-modal-donate-label {
    flex: 0 0 auto;
    color: var(--text-dim);
    font-size: 11px;
    font-weight: 600;
    letter-spacing: 0.06em;
    text-transform: uppercase;
  }
  .about-modal-donate-addr {
    font-family: ui-monospace, 'SF Mono', 'Cascadia Mono', 'Segoe UI Mono', Consolas, monospace;
    font-size: 11px;
    color: var(--text-secondary);
    word-break: break-all;
    user-select: all;
  }
  .about-modal-donate-addr-group {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 3px;
    min-width: 0;
  }
  .about-modal-btc-symbol {
    flex: 0 0 auto;
    color: #f7931a;
    font-size: 14px;
    font-weight: 700;
    line-height: 1;
    user-select: none;
  }

  .logo {
    flex: 0 0 auto;
    width: 34px;
    height: 34px;
    border-radius: 6px;
    background: linear-gradient(135deg, var(--accent), var(--accent-hover));
    display: flex;
    align-items: center;
    justify-content: center;
    overflow: hidden;
  }

  .logo img {
    display: block;
    width: 100%;
    height: 100%;
    object-fit: contain;
    padding: 4px;
    box-sizing: border-box;
  }

  .banner {
    padding: 6px 10px;
    background: var(--bg-input);
    color: var(--text-secondary);
    font-size: 13px;
    border-bottom: 1px solid var(--border);
  }

  .banner--error {
    color: var(--live);
  }

  .body {
    flex: 1;
    display: flex;
    flex-direction: row;
    min-height: 0;
    overflow: hidden;
  }

  .main {
    flex: 1;
    display: flex;
    flex-direction: row;
    min-height: 0;
    overflow: hidden;
  }

  .video-pane {
    flex: 1 1 auto;
    min-width: 0;
    min-height: 0;
    display: flex;
    flex-direction: column;
    /* justify-content: center moved to .player-stage (the scroll container
       must not vertically center — it scrolls). */
    background: var(--bg-app);
    overflow: hidden;
  }

  /* Scroll container that reveals the channel-content sections below the
     player+status bar. The scrollbar is HIDDEN (zero width) so reserving a
     gutter can never reflow the player horizontally — the default view at
     scroll 0 stays pixel-identical whether or not sections exist. Sections are
     reached by wheel/touch scroll. In stacked/theater mode no sections render,
     so there is nothing to scroll. */
  .video-scroll {
    flex: 1 1 auto;
    min-height: 0;
    overflow-y: auto;
    scrollbar-width: none;
  }
  .video-scroll::-webkit-scrollbar {
    width: 0;
    height: 0;
    display: none;
  }

  /* Holds the player + status bar, vertically centered, and fills exactly one
     viewport height (height: 100%, definite — NOT min-height) so two things
     hold: (a) the channel-content sections begin precisely below the fold, and
     (b) the player's max-height:100% resolves against a definite containing
     block so flex-shrink can keep the player from growing past the status bar.
     With min-height the percentage was indefinite and the player overflowed,
     pushing the status bar below the fold. */
  .player-stage {
    position: relative;
    height: 100%;
    display: flex;
    flex-direction: column;
    justify-content: center;
  }

  /* "Back to live" banner shown over the player while a VOD/clip is playing. */
  .playback-banner {
    position: absolute;
    top: 8px;
    left: 8px;
    z-index: 5;
    display: flex;
    align-items: center;
    gap: 8px;
    max-width: calc(100% - 16px);
    padding: 4px 8px 4px 4px;
    background: rgba(0, 0, 0, 0.7);
    border-radius: 5px;
    color: #fff;
    font-size: 12px;
  }
  .playback-back {
    flex: 0 0 auto;
    border: none;
    border-radius: 4px;
    background: var(--accent);
    color: #fff;
    font-size: 12px;
    font-weight: 600;
    padding: 4px 8px;
    cursor: pointer;
  }
  .playback-back:hover {
    filter: brightness(1.1);
  }
  .playback-title {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

.player {
    position: relative;
    flex: 0 1 auto;
    min-height: 0;
    width: 100%;
    max-height: 100%;
    background: var(--bg-app);
    display: flex;
    align-items: center;
    justify-content: center;
    overflow: hidden;
    aspect-ratio: 16 / 9;
  }

.video {
    width: 100%;
    height: 100%;
    object-fit: contain;
    background: var(--bg-app);
    display: block;
  }

  .stream-info {
    flex: 0 0 auto;
    padding: 10px 16px;
    background: var(--bg-app);
    border-top: 1px solid var(--border);
    display: flex;
    flex-direction: column;
    gap: 2px;
    min-height: 0;
    overflow: hidden;
  }

  .stream-info-row {
    display: flex;
    align-items: center;
    gap: 8px;
    min-width: 0;
  }

  .stream-info-row--main {
    gap: 10px;
  }

  .stream-info-avatar {
    flex: 0 0 auto;
    width: 32px;
    height: 32px;
    border-radius: 50%;
    object-fit: cover;
  }

  .stream-info-avatar--offline {
    opacity: 0.5;
    filter: grayscale(0.6);
  }

  .stream-info-row--meta {
    font-size: 12px;
    color: var(--text-secondary);
    gap: 6px;
    flex-wrap: wrap;
  }

  .stream-info-live {
    flex: 0 0 auto;
    display: inline-flex;
    align-items: center;
    gap: 4px;
    padding: 1px 6px;
    background: var(--live);
    color: #fff;
    font-size: 10px;
    font-weight: 700;
    letter-spacing: 0.05em;
    border-radius: 3px;
  }

  .stream-info-live-dot {
    width: 6px;
    height: 6px;
    background: #fff;
    border-radius: 50%;
  }

  .stream-info-title {
    flex: 1 1 auto;
    min-width: 0;
    font-size: 15px;
    font-weight: 600;
    color: var(--text-primary);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .stream-info-game {
    color: var(--text-secondary);
  }

  .stream-info-viewers {
    color: var(--text-secondary);
  }

  .stream-info-uptime {
    color: var(--text-secondary);
  }

  .stream-info-dot {
    color: var(--text-dim);
  }

  .stream-info-offline {
    flex: 0 0 auto;
    padding: 1px 6px;
    background: var(--track);
    color: var(--text-secondary);
    font-size: 10px;
    font-weight: 700;
    letter-spacing: 0.05em;
    border-radius: 3px;
  }

  .stream-info-channel {
    color: var(--text-primary);
    font-size: 13px;
    font-weight: 600;
  }

  .stream-info-row--loading .stream-info-channel {
    color: var(--text-secondary);
  }

  .stream-info-actions {
    display: flex;
    justify-content: flex-start;
    align-items: center;
    gap: 6px;
    padding-top: 2px;
    flex-wrap: wrap;
  }

  .notif-toggle {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    padding: 4px 8px;
    border: 1px solid var(--border);
    border-radius: 4px;
    background: transparent;
    color: var(--text-secondary);
    font-size: 11px;
    font-weight: 600;
    cursor: pointer;
    transition: background 150ms, color 150ms, border-color 150ms;
  }

  .notif-toggle:hover {
    background: var(--bg-hover);
    color: var(--text-primary);
    border-color: var(--track-hover);
  }

  .notif-toggle--on {
    background: var(--accent);
    border-color: var(--accent);
    color: var(--text-primary);
  }

  .notif-toggle--on:hover {
    background: var(--accent-hover);
    border-color: var(--accent-hover);
    color: var(--text-primary);
  }

  .favorite-toggle--on {
    background: var(--accent);
    border-color: var(--accent);
    color: var(--text-primary);
  }

  .favorite-toggle--on:hover {
    background: var(--accent-hover);
    border-color: var(--accent-hover);
    color: var(--text-primary);
  }

  .notif-toggle-icon {
    flex: 0 0 auto;
  }

  .notif-toggle-label {
    font-variant-numeric: tabular-nums;
  }

  .notif-toast {
    position: fixed;
    left: 50%;
    bottom: 20px;
    transform: translateX(-50%);
    padding: 8px 14px;
    background: var(--bg-overlay-strong);
    color: var(--text-primary);
    border: 1px solid var(--border);
    border-radius: 6px;
    font-size: 12px;
    z-index: 60;
    box-shadow: var(--shadow-menu);
    pointer-events: none;
    animation: notif-toast-in 150ms ease-out;
  }

  @keyframes notif-toast-in {
    from { opacity: 0; transform: translate(-50%, 8px); }
    to { opacity: 1; transform: translate(-50%, 0); }
  }

  /* Global tooltip — driven by `use:tooltip` action (src/lib/tooltip.ts).
     Uses position: fixed so it escapes any overflow clipping. Lives in
     the zoomed tree, so it scales with the app's UI zoom — unlike the
     browser-native `title` tooltips. Appears BELOW the hovered element
     (centered horizontally with translateX(-50%)). */
  .global-tooltip {
    position: fixed;
    z-index: 100;
    max-width: 320px;
    padding: 6px 10px;
    background: var(--bg-overlay-strong);
    color: var(--text-primary);
    border: 1px solid var(--border);
    border-radius: 4px;
    box-shadow: 0 4px 12px rgba(0, 0, 0, 0.45);
    font-size: 12px;
    font-weight: 500;
    line-height: 1.3;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    pointer-events: none;
    transform: translateX(-50%);
    animation: global-tooltip-in 120ms ease-out;
  }
  @keyframes global-tooltip-in {
    from { opacity: 0; }
    to   { opacity: 1; }
  }

  /* Hidden probe that measures how position:fixed left/top map to visual
     pixels under the current UI-scale zoom (see zoomK). Never painted. */
  .zoom-probe {
    position: fixed;
    left: 100px;
    top: 0;
    width: 0;
    height: 0;
    pointer-events: none;
    visibility: hidden;
  }

  .player-placeholder {
    width: 100%;
    height: 100%;
    display: flex;
    align-items: center;
    justify-content: center;
    color: var(--text-dim);
    font-size: 13px;
  }

  .player-overlay {
    position: absolute;
    inset: 0;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 10px;
    background: var(--bg-overlay);
    color: var(--text-primary);
    text-align: center;
    padding: 20px;
  }

  .player-overlay--error {
    background: var(--bg-overlay-strong);
  }

  .overlay-title {
    margin: 0;
    font-size: 16px;
    font-weight: 700;
  }

  .overlay-sub {
    margin: 0;
    font-size: 13px;
    color: var(--text-secondary);
    max-width: 90%;
    word-break: break-word;
  }

  .overlay-text {
    margin: 0;
    font-size: 13px;
    color: var(--text-secondary);
  }

  .overlay-action {
    margin-top: 4px;
    padding: 7px 16px;
    border: 1px solid var(--accent);
    border-radius: 6px;
    background: transparent;
    color: var(--accent);
    font-size: 13px;
    font-weight: 600;
    font-family: inherit;
    cursor: pointer;
    transition: background 150ms, color 150ms;
  }

  .overlay-action:hover {
    background: var(--accent);
    color: var(--bg-panel);
  }

  .spinner {
    width: 32px;
    height: 32px;
    border: 3px solid var(--track);
    border-top-color: var(--accent);
    border-radius: 50%;
    animation: spin 0.8s linear infinite;
  }

  @keyframes spin {
    to { transform: rotate(360deg); }
  }

.chat {
    flex: 0 1 var(--chat-size, 300px);
    width: var(--chat-size, 300px);
    min-width: 200px;
    max-width: 1500px;
    height: 100%;
    background: var(--bg-panel);
    border-left: 1px solid var(--border);
    box-sizing: border-box;
    opacity: 1;
    transition: none;
    display: flex;
    flex-direction: column;
    overflow: hidden;
    position: relative;
  }

  .chat-resizer {
    flex: 0 0 auto;
    width: 1px;
    align-self: stretch;
    background: var(--border);
    cursor: col-resize;
    position: relative;
    transition: background 120ms ease;
    user-select: none;
    touch-action: none;
    outline: none;
  }
  .chat-resizer:hover,
  .chat-resizer:focus-visible,
  .chat-resizer--dragging {
    background: var(--accent);
  }
  .chat-resizer--stacked {
    width: 100%;
    height: 1px;
    cursor: row-resize;
  }
  /* Invisible hit-zone: extends the draggable area beyond the 1px line
     so the resize handle is easy to grab without needing pixel-perfect
     aim. Sized to match the other grab areas in the app. */
  .chat-resizer::before {
    content: "";
    position: absolute;
    inset: 0;
    margin: 0 -4px;
  }
  .main--stacked .chat-resizer::before {
    margin: -4px 0;
  }

  .chat-scroll {
    flex: 1 1 auto;
    overflow-y: auto;
    overflow-x: hidden;
    padding: 8px 10px;
    min-height: 0;
  }

  .float-pill {
    position: absolute;
    bottom: 10px;
    z-index: 5;
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 5px 11px;
    border-radius: 999px;
    border: 1px solid var(--border);
    background: var(--bg-overlay-strong);
    -webkit-backdrop-filter: blur(6px);
    backdrop-filter: blur(6px);
    color: var(--text-primary);
    font-size: 11px;
    font-weight: 600;
    cursor: pointer;
    box-shadow: 0 4px 12px rgba(0, 0, 0, 0.45);
    transition: color 150ms, background 150ms, border-color 150ms, transform 150ms;
    white-space: nowrap;
  }

  .jump-end {
    left: 50%;
    transform: translateX(-50%);
    color: var(--text-secondary);
  }

  .jump-end:hover {
    color: var(--accent);
    background: var(--bg-hover);
    border-color: var(--accent);
    transform: translateX(-50%) translateY(-1px);
  }

  .float-count {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-width: 16px;
    height: 16px;
    padding: 0 4px;
    border-radius: 8px;
    background: var(--accent);
    color: #fff;
    font-size: 10px;
    font-weight: 700;
    font-variant-numeric: tabular-nums;
  }

  .chat-link {
    right: 10px;
    padding: 6px;
  }

  .chat-link-icon {
    flex: 0 0 auto;
  }

  .chat-link:hover {
    color: var(--accent);
    background: var(--bg-hover);
    border-color: var(--accent);
    transform: translateY(-1px);
  }

  .message-time {
    color: var(--text-dim);
    font-size: 11px;
    font-weight: 500;
    font-variant-numeric: tabular-nums;
    margin-right: 4px;
    flex: 0 0 auto;
  }

  .chat--hidden {
    flex: 0 0 0;
    width: 0;
    min-width: 0;
    border-left-color: transparent;
    opacity: 0;
  }

  .main--stacked {
    flex-direction: column;
  }
  .main--stacked .video-pane {
    /* Sized to its content (the player) so the chat's top edge lands
       exactly on the video's bottom edge in stacked mode. With flex: 1 1
       auto the video-pane grew past the player, leaving a gap that
       pushed the chat below the actual video. */
    flex: 0 0 auto;
    width: 100%;
    min-height: 0;
  }
  .main--stacked .player {
    flex: 0 0 auto;
    width: 100%;
    max-height: min(70vh, calc(100vw * 9 / 16));
    aspect-ratio: 16 / 9;
  }
  .main--stacked .chat {
    /* Fills remaining space below the video-pane (whose flex is 0 0 auto,
       sized to the player). flex: 1 1 0 lets the chat grow to absorb all
       leftover vertical space; the player's bottom now lands exactly on
       the chat's top. min-height keeps the chat usable on short windows. */
    flex: 1 1 0;
    width: 100%;
    min-width: 0;
    max-width: none;
    border-left: none;
    border-top: 1px solid var(--border);
    min-height: 200px;
    max-height: 70vh;
  }
  .main--stacked .chat--hidden {
    flex: 0 0 0;
    height: 0;
    min-height: 0;
    border-top-color: transparent;
  }
  .main--stacked .stream-info {
    display: none;
  }
  @media (max-width: 380px) {
    .notif-toggle-label { display: none; }
    .notif-toggle { padding: 4px 6px; }
  }

  .placeholder {
    text-align: center;
    color: var(--text-dim);
    margin-top: 40px;
    font-size: 13px;
  }

  .message {
    margin: 1px 0;
    padding: 2px 0;
    line-height: 1.4;
    word-wrap: break-word;
    font-size: 13px;
  }

  .username {
    font-weight: 700;
    margin-right: 4px;
  }

  .username-sep {
    color: var(--text-primary);
    margin-right: 4px;
  }

  .badge {
    display: inline-block;
    width: 16px;
    height: 16px;
    margin-right: 3px;
    vertical-align: -3px;
    object-fit: contain;
  }

  .action {
    color: var(--accent);
  }

  .action-mark {
    color: var(--accent);
    margin-right: 4px;
  }

  .text {
    color: var(--text-primary);
  }

  /* Fallback span rendered in place of an emote <img> whose URL failed to
     load — mirrors the erroredBadges pattern so a broken image is
     distinguishable from a lookup miss (the alt text would otherwise look
     identical to plain chat text). */
  .emote-fallback {
    color: var(--text-primary);
  }

  /* ---- Tier 2 chat features (Toggle B/C/D + USERNOTICE) ----
     All use existing theme tokens only — no hardcoded colours, so they adapt
     to all 29 themes. These rules are inert when the toggles are off (the
     elements are not rendered at all). */

  /* Chat-mode indicator (Toggle B). Compact bar pinned above the chat scroll. */
  .chat-modes {
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
    padding: 4px 8px;
    border-bottom: 1px solid var(--border);
    background: var(--bg-panel);
  }

  .mode-pill {
    font-size: 10px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    padding: 2px 6px;
    border-radius: 3px;
    color: var(--accent);
    background: var(--bg-hover);
    border: 1px solid var(--border);
    font-variant-numeric: tabular-nums;
  }

  /* Deleted / timed-out message presentation (Toggle C). This single rule is
     the source of truth for how a stricken message looks — the class is added
     via isMessageStricken() + DELETED_MESSAGE_CLASS. Tradeoff: strikethrough
     keeps the moderator-removed text VISIBLE. A future collapsed-placeholder
     presentation can change only this rule + the predicate. */
  .message--deleted .text,
  .message--deleted .username {
    text-decoration: line-through;
    opacity: 0.6;
  }

  /* Bits / cheer indicator (Toggle D). Amount only — animated cheermote
     images are out of scope. */
  .bits-badge {
    display: inline-flex;
    align-items: center;
    gap: 2px;
    margin-left: 6px;
    padding: 0 4px;
    border-radius: 3px;
    background: var(--bg-hover);
    color: var(--accent);
    font-size: 11px;
    font-weight: 700;
    font-variant-numeric: tabular-nums;
    vertical-align: 1px;
  }

  .bits-badge svg {
    flex: 0 0 auto;
  }

  /* USERNOTICE line (Toggle A) — subs, raids, announcements, gifts. Visually
     distinct from normal chat: a tinted, italic, bordered line. */
  .message--notice {
    margin: 3px 0;
    padding: 3px 6px;
    border-left: 3px solid var(--accent);
    background: var(--bg-hover);
    border-radius: 3px;
    font-size: 12px;
  }

  .notice-system {
    display: block;
    color: var(--accent);
    font-weight: 600;
    font-style: italic;
  }

  .notice-msg {
    display: block;
    margin-top: 2px;
    color: var(--text-secondary);
  }

  .chat::-webkit-scrollbar {
    width: 6px;
  }

  .chat::-webkit-scrollbar-track {
    background: transparent;
  }

  .chat::-webkit-scrollbar-thumb {
    background: var(--bg-hover);
    border-radius: 3px;
  }

  .chat::-webkit-scrollbar-thumb:hover {
    background: var(--track);
  }
</style>
