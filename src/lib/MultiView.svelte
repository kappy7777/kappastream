<script lang="ts">
  // The multi-stream split view: a tile grid (1/2/3/4 layouts), a tabbed chat
  // pane with ONE persistent IRC connection per tile (scrollback survives tab
  // switches), and a status bar showing every open stream with the focused tile
  // most prominent. Rendered INSTEAD of App.svelte's single-stream `.main` when
  // multi-view is on; when off, App.svelte's original markup renders untouched
  // (byte-identical baseline).
  //
  // Chat sessions are owned here (not in Tile.svelte) so a session outlives
  // focus changes — only tile CLOSE (or a channel replace) disposes it. The
  // client-side mute list + Tier 2 toggles are applied at RENDER time reading
  // `settings`, exactly as App.svelte does, so the session always stores every
  // event and toggles apply retroactively.

  import { tick, onDestroy } from 'svelte'
  import { tileStore } from './tile-store.svelte'
  import { ChatSession } from './chat-session.svelte'
  import { settings } from './settings.svelte.ts'
  import Tile from './Tile.svelte'
  import { resolveBadgeImageUrl, isMessageStricken, DELETED_MESSAGE_CLASS, type BadgeInfo } from './irc'
  import { formatCompact, formatChatTime } from './format'
  import { tooltip } from './tooltip.ts'
  import { t } from './i18n/index.svelte'

  interface Props {
    isWindows: boolean
    chatSize: number
    onFocusedVideo: (el: HTMLVideoElement | null) => void
  }
  const { isWindows, chatSize, onFocusedVideo }: Props = $props()

  // Per-tile chat sessions. A Svelte reactive Map so `.get()` reads track.
  let sessions = $state(new Map<string, ChatSession>())

  // Reconcile sessions to the current tiles: create on add, dispose on remove,
  // restart on channel replace (same tile id, different channel).
  // Reconcile sessions to the current tiles: create on add, dispose on remove,
  // restart on channel replace (same tile id, different channel).
  //
  // IMPORTANT: this runs in $effect.pre (not $effect) so sessions are created
  // BEFORE the template reads the `activeSession` derived. With a regular
  // $effect the reconcile runs AFTER the DOM update — the derived sees a null
  // session for the just-added tile and renders "No streams open" until the user
  // manually switches chat tabs. $effect.pre runs before the update phase, so
  // the session is in the Map by the time `sessions.get(focusedId)` is read.
  $effect.pre(() => {
    const tiles = tileStore.tiles
    const ids = new Set(tiles.map((tile) => tile.id))
    for (const [id, s] of sessions) {
      if (!ids.has(id)) { s.dispose(); sessions.delete(id) }
    }
    for (const tile of tiles) {
      const existing = sessions.get(tile.id)
      if (!existing) {
        const s = new ChatSession(tile.channel)
        sessions.set(tile.id, s)
        s.start()
      } else if (existing.channel !== tile.channel) {
        existing.dispose()
        const s = new ChatSession(tile.channel)
        sessions.set(tile.id, s)
        s.start()
      }
    }
  })

  // Defence-in-depth: dispose every chat session + close its socket when
  // MultiView unmounts (mode toggle off / last-tile exit). The reconcile effect
  // also disposes sessions for removed tiles, but this guarantees teardown even
  // if the whole component is destroyed without a final reconcile pass.
  onDestroy(() => {
    for (const [, s] of sessions) s.dispose()
    sessions.clear()
    onFocusedVideo(null)
    document.removeEventListener('pointermove', onSplitMove)
    document.removeEventListener('pointerup', endSplitDrag)
    document.removeEventListener('pointercancel', endSplitDrag)
  })

  const focusedId = $derived(tileStore.focused?.id ?? null)
  const activeSession = $derived(focusedId ? sessions.get(focusedId) ?? null : null)
  const messages = $derived(activeSession?.messages ?? [])
  const count = $derived(tileStore.count)

  // ---- chat scroll / sticky-bottom (mirrors App.svelte) ----
  let chatEl = $state<HTMLElement | undefined>(undefined)
  let stickyBottom = $state(true)
  let newMessageCount = $state(0)
  let scrollBaseline = 0
  const SCROLL_BOTTOM_THRESHOLD = 32

  function onChatScroll(): void {
    const el = chatEl
    if (!el) return
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight
    const wasSticky = stickyBottom
    stickyBottom = distanceFromBottom <= SCROLL_BOTTOM_THRESHOLD
    if (stickyBottom) { newMessageCount = 0; scrollBaseline = messages.length }
    else if (wasSticky && !stickyBottom) { scrollBaseline = messages.length; newMessageCount = 0 }
  }
  function jumpToPresent(): void {
    const el = chatEl
    if (el) { el.scrollTop = el.scrollHeight; stickyBottom = true; newMessageCount = 0; scrollBaseline = messages.length }
  }
  $effect(() => {
    const len = messages.length
    void tick().then(() => {
      const el = chatEl
      if (!el) return
      if (stickyBottom) { el.scrollTop = el.scrollHeight; scrollBaseline = len }
      else { const added = len - scrollBaseline; if (added > 0) newMessageCount += added; scrollBaseline = len }
    })
  })
  // Reset scroll state when the active tab (focused tile) changes.
  $effect(() => {
    void focusedId
    stickyBottom = true
    newMessageCount = 0
    scrollBaseline = 0
  })

  // ---- render helpers ----
  let erroredBadges = $state<Set<string>>(new Set())
  function markBadgeErrored(url: string): void { const n = new Set(erroredBadges); n.add(url); erroredBadges = n }
  let erroredEmotes = $state<Set<string>>(new Set())
  function markEmoteErrored(url: string): void { const n = new Set(erroredEmotes); n.add(url); erroredEmotes = n }

  function effectiveBadgeUrl(b: BadgeInfo): string | null {
    const u = resolveBadgeImageUrl(b, activeSession?.badgeOverride ?? null)
    return u
  }

  function roomStateActive(): boolean {
    const rs = activeSession?.roomState ?? {}
    return rs.emoteOnly === true || rs.subsOnly === true || rs.r9k === true ||
      (rs.followersOnly !== undefined && rs.followersOnly >= 0) ||
      (rs.slow !== undefined && rs.slow > 0)
  }

  const placeholderText = $derived(
    activeSession
      ? activeSession.status === 'connected'
        ? t('chat_waitingMessages')
        : t('chat_joinToSee')
      : t('mv_noTiles'),
  )

  // ---- drag-to-reorder (pointer events on a tile's drag handle) ----
  // MultiView owns the drag because it can hit-test against every tile in the
  // grid. Dragging does NOT touch playback: the {#each} is keyed by the stable
  // tile.id, so on drop we only swap two array entries and Svelte MOVES the
  // existing DOM nodes (preserving each <video> + its hls.js instance). A small
  // movement threshold separates a click from a drag.
  let draggingId = $state<string | null>(null)
  let dropTargetId = $state<string | null>(null)
  const DRAG_THRESHOLD_PX = 4
  let dragStart: { x: number; y: number; id: string } | null = null
  let dragListeners = false

  function tileIdAtPoint(x: number, y: number): string | null {
    // elementsFromPoint operates in CSS layout pixels (already zoom-aware), so
    // hit-testing is correct at every uiScale. Walk the stack so an overlay
    // (focus surface / controls) over a tile still resolves to that tile.
    for (const el of document.elementsFromPoint(x, y)) {
      const tile = (el as HTMLElement).closest?.('[data-tile-id]') as HTMLElement | null
      if (tile) return tile.dataset.tileId ?? null
    }
    return null
  }

  function onDragMove(e: PointerEvent): void {
    if (!dragStart) return
    if (draggingId === null) {
      // Threshold gate: only become an active drag after a small movement, so a
      // handle click (e.g. to focus the tile) doesn't spuriously reorder.
      if (Math.abs(e.clientX - dragStart.x) < DRAG_THRESHOLD_PX && Math.abs(e.clientY - dragStart.y) < DRAG_THRESHOLD_PX) return
      draggingId = dragStart.id
    }
    const over = tileIdAtPoint(e.clientX, e.clientY)
    dropTargetId = over && over !== dragStart.id ? over : null
    e.preventDefault()
  }

  function onDragUp(): void {
    if (draggingId && dropTargetId && draggingId !== dropTargetId) {
      tileStore.swap(draggingId, dropTargetId)
    }
    draggingId = null
    dropTargetId = null
    dragStart = null
    if (dragListeners) {
      document.removeEventListener('pointermove', onDragMove)
      document.removeEventListener('pointerup', onDragUp)
      document.removeEventListener('pointercancel', onDragUp)
      dragListeners = false
    }
  }

  function startDrag(tileId: string, e: PointerEvent): void {
    // Only react to primary button presses; focus the tile too, so a handle
    // interaction also makes it active for chat/shortcuts.
    tileStore.focus(tileId)
    if (e.button !== 0) return
    dragStart = { x: e.clientX, y: e.clientY, id: tileId }
    if (!dragListeners) {
      document.addEventListener('pointermove', onDragMove)
      document.addEventListener('pointerup', onDragUp)
      document.addEventListener('pointercancel', onDragUp)
      dragListeners = true
    }
  }

  // ---- hideable status bar (#3) ----
  // Persisted via settings.mvStatusBarHidden. When hidden the bar collapses and
  // a thin hover zone at the bottom edge reveals a focusable "show" button
  // (mouse: hover; keyboard: Tab surfaces the button). The hover zone sits BELOW
  // the grid (its own flex strip) so it never steals clicks from tiles/controls.
  let barHovered = $state(false)

  // ---- resizable tile splits (#3) -------------------------------------------
  // splitX / splitY are the column / row split ratios (0.15–0.85, default 0.5).
  // They are NOT persisted (multi-view itself is never persisted) — they reset
  // on every multi-view session. Dragging a splitter handle updates the ratio;
  // the grid template is recomputed reactively via inline style on .mv-grid.
  // For the 3-tile layout the 4-column grid naturally centers tile3 at 50/50;
  // dragging the column splitter shifts it towards the larger tile (expected).
  let splitX = $state(0.5)
  let splitY = $state(0.5)
  let gridEl = $state<HTMLElement | undefined>(undefined)
  let splitDrag = $state<{ axis: 'x' | 'y' } | null>(null)

  const gridStyle = $derived.by(() => {
    if (count <= 1) return ''
    if (count === 2) return `grid-template-columns: ${splitX}fr ${1 - splitX}fr;`
    if (count === 3) {
      const l = splitX * 0.5
      const r = (1 - splitX) * 0.5
      return `grid-template-columns: ${l}fr ${l}fr ${r}fr ${r}fr; grid-template-rows: ${splitY}fr ${1 - splitY}fr;`
    }
    return `grid-template-columns: ${splitX}fr ${1 - splitX}fr; grid-template-rows: ${splitY}fr ${1 - splitY}fr;`
  })

  // Explicit grid-area placement per tile for the 3-tile layout (tile3 centered
  // below the two top tiles). Uses inline style on each Tile's root element
  // instead of CSS nth-child selectors for deterministic placement. Returns ''
  // for other layouts so the grid auto-placement handles them.
  function tileGridArea(i: number): string {
    if (count === 3) {
      if (i === 0) return '1 / 1 / 2 / 3'
      if (i === 1) return '1 / 3 / 2 / 5'
      if (i === 2) return '2 / 2 / 3 / 4'
    }
    return ''
  }

  function startSplitDrag(axis: 'x' | 'y', e: PointerEvent): void {
    e.preventDefault()
    e.stopPropagation()
    splitDrag = { axis }
    document.addEventListener('pointermove', onSplitMove)
    document.addEventListener('pointerup', endSplitDrag)
    document.addEventListener('pointercancel', endSplitDrag)
  }

  function onSplitMove(e: PointerEvent): void {
    if (!splitDrag || !gridEl) return
    const rect = gridEl.getBoundingClientRect()
    if (rect.width === 0 || rect.height === 0) return
    if (splitDrag.axis === 'x') {
      splitX = Math.max(0.15, Math.min(0.85, (e.clientX - rect.left) / rect.width))
    } else {
      splitY = Math.max(0.15, Math.min(0.85, (e.clientY - rect.top) / rect.height))
    }
  }

  function endSplitDrag(): void {
    splitDrag = null
    document.removeEventListener('pointermove', onSplitMove)
    document.removeEventListener('pointerup', endSplitDrag)
    document.removeEventListener('pointercancel', endSplitDrag)
  }
</script>

<div class="mv-main" style="--chat-size:{chatSize}px">
  <div class="mv-stage">
    {#if count === 0}
      <div class="mv-empty">{t('mv_addStreamHint')}</div>
    {:else}
      <div class="mv-grid" class:mv-grid--1={count === 1} class:mv-grid--2={count === 2} class:mv-grid--3={count === 3} class:mv-grid--4={count === 4} bind:this={gridEl} style={gridStyle}>
        {#each tileStore.tiles as tile, i (tile.id)}
          <Tile
            {tile}
            isFocused={tileStore.isFocused(tile.id)}
            isDragging={draggingId === tile.id}
            isDropTarget={dropTargetId === tile.id}
            {isWindows}
            {onFocusedVideo}
            onTileDragStart={startDrag}
            gridArea={tileGridArea(i)}
          />
        {/each}
        {#if count >= 2}
          <!-- Column splitter (between left/right tiles). For 3 tiles it spans
               only the top-row height (between the two upper tiles). -->
          <div
            class="mv-splitter mv-splitter--col"
            class:mv-splitter--active={splitDrag?.axis === 'x'}
            style={count === 3 ? `left:${(splitX * 100).toFixed(2)}%;top:0;height:${(splitY * 100).toFixed(2)}%;` : `left:${(splitX * 100).toFixed(2)}%;top:0;bottom:0;`}
            role="separator"
            aria-orientation="vertical"
            onpointerdown={(e) => startSplitDrag('x', e)}
            ondblclick={() => { splitX = 0.5 }}
          ></div>
        {/if}
        {#if count >= 3}
          <!-- Row splitter (between the top row and the bottom tile/tiles). -->
          <div
            class="mv-splitter mv-splitter--row"
            class:mv-splitter--active={splitDrag?.axis === 'y'}
            style={`top:${(splitY * 100).toFixed(2)}%;left:0;right:0;`}
            role="separator"
            aria-orientation="horizontal"
            onpointerdown={(e) => startSplitDrag('y', e)}
            ondblclick={() => { splitY = 0.5 }}
          ></div>
        {/if}
      </div>
    {/if}

    <!-- Multi-view status bar: every open stream, focused tile most prominent.
         Same structure family as the single-stream bar (avatar / live badge /
         title / game / viewers); reads each tile's polled liveStatus so it
         refreshes with the favorites poll cadence and updates on focus change.
         Hideable (#3): a hide button collapses it; when hidden, a thin hover
         strip below the grid reveals a focusable "show" button (mouse hover OR
         Tab). Scope: MULTI-VIEW ONLY — the single-stream `.stream-info` bar
         integrates favorite/notification actions that must stay accessible, and
         keeping it untouched preserves the byte-identical multi-view-OFF
         baseline. -->
    {#if !settings.mvStatusBarHidden}
      <div class="mv-statusbar" role="status" aria-label={t('mv_statusBar')}>
        <button
          type="button"
          class="mv-statusbar-hide"
          onclick={() => settings.setMvStatusBarHidden(true)}
          aria-label={t('mv_hideStatusBar')}
          use:tooltip={t('mv_hideStatusBar')}
        >
          <svg viewBox="0 0 16 16" width="11" height="11" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><path d="M3 6l5 5 5-5"/></svg>
        </button>
        {#each tileStore.tiles as tile (tile.id)}
          {@const s = tile.liveStatus}
          {@const focused = tileStore.isFocused(tile.id)}
          <button type="button" class="mv-status-row" class:mv-status-row--active={focused} onclick={() => tileStore.focus(tile.id)} aria-label={t('mv_focusTile') + ' — ' + tile.channel} aria-current={focused ? 'true' : 'false'}>
            {#if (s.state === 'live' || s.state === 'offline') && s.avatarUrl}
              <img class="mv-status-avatar" class:mv-status-avatar--off={s.state === 'offline'} src={s.avatarUrl} alt="" />
          {/if}
          <span class="mv-status-channel">{tile.channel}</span>
          {#if s.state === 'live'}
            <span class="mv-status-live"><span class="mv-status-dot"></span>{t('liveBadge')}</span>
            <span class="mv-status-title" title={s.title}>{s.title}</span>
            <span class="mv-status-meta">
              {#if s.game}<span class="mv-status-game">{s.game}</span><span class="mv-status-sep">·</span>{/if}
              <span>{formatCompact(s.viewers)} {t('viewers')}</span>
              {#if s.uptime}<span class="mv-status-sep">·</span><span>{t('si_uptime', { uptime: s.uptime })}</span>{/if}
            </span>
          {:else if s.state === 'offline'}
            <span class="mv-status-offline">{t('offline')}</span>
          {:else}
            <span class="mv-status-loading">{tile.status === 'loading' ? t('player_loadingStream') : t('live')}</span>
          {/if}
        </button>
        {/each}
      </div>
    {:else}
      <!-- Hidden: a thin strip below the grid. The reveal button is a real
           <button> (Tab-focusable for keyboard users); it is visually hidden
           until the strip is hovered OR focused, so it never clutters the video.
           The strip is its own flex row beneath the grid → it cannot steal
           clicks from tiles or their controls. -->
      <div
        class="mv-statusbar-hoverzone"
        role="region"
        aria-label={t('mv_statusBar')}
        onpointerenter={() => (barHovered = true)}
        onpointerleave={() => (barHovered = false)}
      >
        <button
          type="button"
          class="mv-statusbar-reveal"
          class:mv-statusbar-reveal--shown={barHovered}
          onclick={() => settings.setMvStatusBarHidden(false)}
          aria-label={t('mv_showStatusBar')}
          aria-expanded={false}
        >
          <svg viewBox="0 0 16 16" width="11" height="11" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><path d="M3 10l5-5 5 5"/></svg>
          <span class="mv-statusbar-reveal-label">{t('mv_showStatusBar')}</span>
        </button>
      </div>
    {/if}
  </div>

  {#if settings.chatVisible}
    <main class="mv-chat">
      <!-- Tabs: one per tile, active = focused. Clicking a tab focuses that
           tile (chat tab and focus are one concept). -->
      <div class="mv-chat-tabs" role="tablist">
        {#each tileStore.tiles as tile (tile.id)}
          <button
            type="button"
            class="mv-chat-tab"
            class:mv-chat-tab--active={tileStore.isFocused(tile.id)}
            class:mv-chat-tab--live={tile.liveStatus.state === 'live'}
            role="tab"
            aria-selected={tileStore.isFocused(tile.id)}
            onclick={() => tileStore.focus(tile.id)}
            title={tile.channel}
          >{tile.channel}</button>
        {/each}
      </div>

      {#if activeSession && settings.chatRoomstate && roomStateActive()}
        {@const rs = activeSession.roomState}
        <div class="chat-modes" role="status">
          {#if rs.subsOnly}<span class="mode-pill">{t('chat_subsOnly')}</span>{/if}
          {#if rs.followersOnly !== undefined && rs.followersOnly >= 0}<span class="mode-pill">{rs.followersOnly > 0 ? t('chat_followersOnlyMin', { min: String(rs.followersOnly) }) : t('chat_followersOnly')}</span>{/if}
          {#if rs.slow !== undefined && rs.slow > 0}<span class="mode-pill">{t('chat_slowSecs', { n: rs.slow })}</span>{/if}
          {#if rs.emoteOnly}<span class="mode-pill">{t('chat_emoteOnly')}</span>{/if}
          {#if rs.r9k}<span class="mode-pill">{t('chat_r9k')}</span>{/if}
        </div>
      {/if}

      <div class="mv-chat-scroll" bind:this={chatEl} onscroll={onChatScroll}>
        {#if messages.length === 0}
          <p class="mv-placeholder">{placeholderText}</p>
        {:else}
          {#each messages as msg (msg.id)}
            {#if msg.kind === 'notice'}
              {#if settings.chatSubnotices && !settings.isMuted(msg.login)}
                <div class="message message--notice">
                  {#if settings.chatTimestamps}<span class="message-time">{formatChatTime(msg.timestamp)}</span>{/if}
                  <span class="notice-system">{msg.systemText}</span>
                  {#if msg.parts.length > 0}
                    <span class="notice-msg">{#each msg.parts as part}{#if part.type === 'text'}{part.text}{:else if erroredEmotes.has(part.url)}<span class="emote-fallback">{part.name}</span>{:else}<img class="emote" class:emote--twitch={part.provider === 'twitch'} src={part.url} alt={part.name} title={part.name} loading="lazy" onerror={() => markEmoteErrored(part.url)} />{/if}{/each}</span>
                  {/if}
                </div>
              {/if}
            {:else if !settings.isMuted(msg.login)}
              <div class="message{isMessageStricken(settings.chatModeration, msg.deleted) ? ' ' + DELETED_MESSAGE_CLASS : ''}" class:action={msg.isAction} title={isMessageStricken(settings.chatModeration, msg.deleted) ? (msg.deletedReason ?? '') : ''}>
                {#if settings.chatTimestamps}<span class="message-time">{formatChatTime(msg.timestamp)}</span>{/if}
                {#each msg.badges as b (b.id + b.version)}
                  {@const effUrl = effectiveBadgeUrl(b)}
                  {#if effUrl && !erroredBadges.has(effUrl)}
                    <img class="badge badge--{b.id}" src={effUrl} alt={b.label} loading="lazy" onerror={() => markBadgeErrored(effUrl!)} />
                  {/if}
                {/each}
                <span class="username" style="color: {msg.color}">{msg.username}</span>{#if !msg.isAction}<span class="username-sep">:</span>{/if}
                {#if msg.isAction}<span class="action-mark"> </span>{/if}
                <span class="text">{#each msg.parts as part}{#if part.type === 'text'}{part.text}{:else if erroredEmotes.has(part.url)}<span class="emote-fallback">{part.name}</span>{:else}<img class="emote" class:emote--twitch={part.provider === 'twitch'} src={part.url} alt={part.name} title={part.name} loading="lazy" onerror={() => markEmoteErrored(part.url)} />{/if}{/each}</span>
                {#if settings.chatBits && msg.bits}
                  <span class="bits-badge">{formatCompact(msg.bits)}</span>
                {/if}
              </div>
            {/if}
          {/each}
        {/if}
      </div>
      {#if !stickyBottom && messages.length > 0}
        <button type="button" class="mv-jump" onclick={jumpToPresent}>{t('chat_backToBottom')}{#if newMessageCount > 0}<span class="mv-jump-count">{newMessageCount}</span>{/if}</button>
      {/if}
    </main>
  {/if}
</div>

<style>
  .mv-main { display: flex; flex-direction: row; flex: 1; min-height: 0; min-width: 0; overflow: hidden; }
  .mv-stage { flex: 1 1 auto; min-width: 0; min-height: 0; display: flex; flex-direction: column; background: #000; overflow: hidden; }
  .mv-empty {
    flex: 1;
    display: flex;
    align-items: center;
    justify-content: center;
    color: var(--text-secondary);
    padding: 20px;
    text-align: center;
    background: var(--bg-app);
  }
  .mv-grid {
    flex: 1 1 auto;
    min-height: 0;
    min-width: 0;
    display: grid;
    gap: 0;
    background: #000;
    position: relative;
  }
  .mv-grid--1 { grid-template-columns: 1fr; grid-template-rows: 1fr; }
  .mv-grid--2 { grid-template-columns: 1fr 1fr; grid-template-rows: 1fr; }
  /* 3: TWO equal tiles on top, ONE tile CENTERED below them (same width as each
     top tile). Uses a 4-column grid; tile placement is set via inline grid-area
     on each Tile (see tileGridArea), NOT nth-child — deterministic at every
     split ratio. At the default 50/50 split tile3 is perfectly centered. */
  .mv-grid--3 { grid-template-columns: 1fr 1fr 1fr 1fr; grid-template-rows: 1fr 1fr; }
  .mv-grid--4 { grid-template-columns: 1fr 1fr; grid-template-rows: 1fr 1fr; }

  /* Resizable splitter handles. They are absolutely-positioned children of the
     grid (position:absolute removes them from grid flow so they don't affect
     tile placement or nth-child selectors — they're rendered after the tiles).
     A 2px visible line with a larger invisible hit area (via ::before). On
     hover or active-drag the line turns accent-colored. Double-click resets. */
  .mv-splitter {
    position: absolute;
    z-index: 3;
    background: var(--border);
    transition: background 100ms;
  }
  .mv-splitter::before {
    content: '';
    position: absolute;
    inset: -5px;
  }
  .mv-splitter--col {
    width: 2px;
    transform: translateX(-50%);
    cursor: col-resize;
  }
  .mv-splitter--row {
    height: 2px;
    transform: translateY(-50%);
    cursor: row-resize;
  }
  .mv-splitter:hover,
  .mv-splitter--active {
    background: var(--accent);
  }

  /* Status bar — all streams, focused row prominent. */
  .mv-statusbar {
    position: relative;
    flex: 0 0 auto;
    display: flex;
    flex-direction: column;
    gap: 1px;
    background: var(--bg-app);
    border-top: 1px solid var(--border);
    max-height: calc(40vh / var(--ui-zoom, 1));
    overflow-y: auto;
    scrollbar-width: thin;
  }
  .mv-statusbar-hide {
    position: absolute;
    top: 4px;
    right: 6px;
    z-index: 2;
    width: 20px;
    height: 20px;
    border: none;
    border-radius: 4px;
    background: var(--bg-hover);
    color: var(--text-secondary);
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 0;
    opacity: 0.7;
  }
  .mv-statusbar-hide:hover { opacity: 1; background: var(--bg-hover-faint); color: var(--text-primary); }
  /* Hidden-state hover zone: a thin strip beneath the grid. Never overlaps
     tiles/controls, so it cannot steal their clicks. The reveal button inside
     is a real focusable <button> (Tab surfaces it for keyboard users); it is
     invisible until the strip is hovered OR the button is focused. */
  .mv-statusbar-hoverzone {
    flex: 0 0 auto;
    height: 12px;
    position: relative;
    background: var(--bg-app);
    border-top: 1px solid var(--border);
  }
  .mv-statusbar-reveal {
    position: absolute;
    top: 0;
    left: 50%;
    transform: translateX(-50%);
    display: inline-flex;
    align-items: center;
    gap: 5px;
    height: 12px;
    padding: 0 10px;
    border: none;
    border-radius: 0 0 8px 8px;
    background: var(--bg-hover);
    color: var(--text-secondary);
    font-size: 11px;
    font-family: inherit;
    cursor: pointer;
    opacity: 0;
    transition: opacity 120ms;
    white-space: nowrap;
  }
  .mv-statusbar-reveal--shown,
  .mv-statusbar-reveal:hover,
  .mv-statusbar-reveal:focus-visible {
    opacity: 1;
    color: var(--text-primary);
  }
  .mv-statusbar-reveal:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: -2px;
  }
  .mv-statusbar-reveal-label { line-height: 1; }
  .mv-status-row {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 5px 12px;
    background: var(--bg-app);
    opacity: 0.6;
    border: none;
    border-left: 3px solid transparent;
    min-width: 0;
    width: 100%;
    font: inherit;
    text-align: left;
    color: inherit;
    cursor: pointer;
  }
  .mv-status-row:hover { background: var(--bg-hover); opacity: 0.85; }
  .mv-status-row:focus-visible { outline: 2px solid var(--accent); outline-offset: -2px; }
  .mv-status-row--active {
    opacity: 1;
    border-left-color: var(--accent);
    background: var(--bg-hover-faint);
  }
  .mv-status-avatar { width: 22px; height: 22px; border-radius: 50%; object-fit: cover; flex: 0 0 auto; }
  .mv-status-avatar--off { filter: grayscale(1); opacity: 0.6; }
  .mv-status-channel { font-weight: 700; flex: 0 0 auto; max-width: 140px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .mv-status-live { display: inline-flex; align-items: center; gap: 4px; color: var(--live); font-size: 11px; font-weight: 700; flex: 0 0 auto; }
  .mv-status-dot { width: 7px; height: 7px; border-radius: 50%; background: var(--live); }
  .mv-status-title { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; flex: 1 1 auto; color: var(--text-primary); }
  .mv-status-meta { display: flex; align-items: center; gap: 5px; flex: 0 0 auto; color: var(--text-secondary); font-size: 12px; }
  .mv-status-game { max-width: 120px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .mv-status-sep { opacity: 0.5; }
  .mv-status-offline { color: var(--text-secondary); font-size: 12px; font-style: italic; }
  .mv-status-loading { color: var(--text-secondary); font-size: 12px; }

  /* Chat pane. */
  .mv-chat {
    flex: 0 0 var(--chat-size);
    min-width: 0;
    display: flex;
    flex-direction: column;
    background: var(--bg-panel);
    border-left: 1px solid var(--border);
    overflow: hidden;
  }
  .mv-chat-tabs {
    flex: 0 0 auto;
    display: flex;
    overflow-x: auto;
    scrollbar-width: none;
    border-bottom: 1px solid var(--border);
    background: var(--bg-app);
  }
  .mv-chat-tabs::-webkit-scrollbar { display: none; }
  .mv-chat-tab {
    flex: 0 0 auto;
    border: none;
    border-bottom: 2px solid transparent;
    background: transparent;
    color: var(--text-secondary);
    padding: 7px 12px;
    font-size: 12px;
    font-family: inherit;
    cursor: pointer;
    white-space: nowrap;
    max-width: 140px;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .mv-chat-tab:hover { background: var(--bg-hover-faint); color: var(--text-primary); }
  .mv-chat-tab--active { color: var(--accent); border-bottom-color: var(--accent); }
  .mv-chat-tab--live::before { content: '● '; color: var(--live); }

  .mv-chat-scroll { flex: 1 1 auto; overflow-y: auto; padding: 6px 8px; min-height: 0; position: relative; }
  .mv-placeholder { color: var(--text-secondary); padding: 12px; font-size: 12px; }
  .mv-jump {
    position: absolute;
    bottom: 8px;
    left: 50%;
    transform: translateX(-50%);
    border: 1px solid var(--border);
    background: var(--bg-panel);
    color: var(--text-primary);
    padding: 4px 10px;
    border-radius: 14px;
    font-size: 12px;
    font-family: inherit;
    cursor: pointer;
    box-shadow: 0 2px 8px rgba(0, 0, 0, 0.4);
    z-index: 5;
  }
  .mv-jump:hover { background: var(--bg-hover); }
  .mv-jump-count { margin-left: 5px; background: var(--accent); color: #fff; border-radius: 8px; padding: 0 6px; font-size: 11px; }

  /* ---- chat message rendering (local copies of App.svelte's scoped rules;
     kept in sync so multi-view chat looks identical to single-view chat). ---- */
  .mv-chat .message { margin: 1px 0; padding: 2px 0; line-height: 1.4; word-wrap: break-word; font-size: 13px; }
  .mv-chat .username { font-weight: 700; margin-right: 4px; }
  .mv-chat .username-sep { color: var(--text-primary); margin-right: 4px; }
  .mv-chat .text { color: var(--text-primary); }
  .mv-chat .action { color: var(--accent); }
  .mv-chat .action-mark { color: var(--accent); margin-right: 4px; }
  .mv-chat .badge { display: inline-block; width: 16px; height: 16px; margin-right: 3px; vertical-align: -3px; object-fit: contain; }
  .mv-chat .message-time { color: var(--text-dim); font-size: 11px; font-weight: 500; font-variant-numeric: tabular-nums; margin-right: 4px; flex: 0 0 auto; }
  .mv-chat .emote-fallback { color: var(--text-primary); }
  .mv-chat .chat-modes { display: flex; flex-wrap: wrap; gap: 4px; padding: 4px 8px; border-bottom: 1px solid var(--border); background: var(--bg-panel); }
  .mv-chat .mode-pill { font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.04em; padding: 2px 6px; border-radius: 3px; color: var(--accent); background: var(--bg-hover); border: 1px solid var(--border); font-variant-numeric: tabular-nums; }
  .mv-chat .message--deleted .text,
  .mv-chat .message--deleted .username { text-decoration: line-through; opacity: 0.6; }
  .mv-chat .bits-badge { display: inline-flex; align-items: center; gap: 2px; margin-left: 6px; padding: 0 4px; border-radius: 3px; background: var(--bg-hover); color: var(--accent); font-size: 11px; font-weight: 700; font-variant-numeric: tabular-nums; vertical-align: 1px; }
  .mv-chat .message--notice { margin: 3px 0; padding: 3px 6px; border-left: 3px solid var(--accent); background: var(--bg-hover); border-radius: 3px; font-size: 12px; }
  .mv-chat .notice-system { display: block; color: var(--accent); font-weight: 600; font-style: italic; }
  .mv-chat .notice-msg { display: block; margin-top: 2px; color: var(--text-secondary); }
</style>
