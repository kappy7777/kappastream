<script lang="ts">
  import { onMount, tick } from 'svelte'
  import {
    favoritesStore,
    isValidChannelName,
    MAX_FAVORITES,
    normalizeChannelName,
    type FavoriteStatus,
    type LiveStatus,
  } from './favorites.svelte'
  import { tooltip } from './tooltip.ts'

  interface Props {
    currentChannel: string | null
    onselect: (channel: string) => void
    iconsOnly?: boolean
    zoomK?: number
  }

  const { currentChannel, onselect, iconsOnly = false, zoomK = 1 }: Props = $props()

  const store = favoritesStore
  let statuses: FavoriteStatus[] = $state([])
  let hoveredName: string | null = $state(null)
  let draggingName: string | null = $state(null)
  let dragOverName: string | null = $state(null)
  let addMenuOpen = $state(false)
  let addInput = $state('')
  let addError = $state('')
  let addInputEl: HTMLInputElement | null = $state(null)

  // Hover tooltip — only active in icons-only mode. Lives outside the
  // .sidebar-list (which has overflow: auto and would clip the tooltip).
  // Positioned with `position: fixed` so it escapes any overflow clipping;
  // because it lives in the zoomed tree, it scales with the UI scale.
  let tooltipFav: { name: string; status: LiveStatus; rect: DOMRect; lastFetched: number | null } | null = $state(null)
  let favTooltipEl: HTMLElement | null = $state(null)
  let favTooltipPos = $state({ left: 0, top: 0 })

  $effect(() => {
    if (!tooltipFav || !favTooltipEl) return
    void zoomK // reposition if the zoom factor changed while up
    const target = tooltipFav.rect
    const tip = favTooltipEl.getBoundingClientRect()
    // Visual viewport bounds (same visual space as the rects); see App.svelte
    // for why we use the documentElement rect instead of window.innerWidth.
    const root = document.documentElement.getBoundingClientRect()
    const vw = root.width
    const vh = root.height
    const m = 8
    const k = zoomK || 1
    let left = target.right + m
    let top = target.top + target.height / 2
    if (left + tip.width > vw - m) {
      const flipped = target.left - tip.width - m
      left = flipped >= m ? flipped : vw - tip.width - m
    }
    const halfH = tip.height / 2
    if (top - halfH < m) top = m + halfH
    else if (top + halfH > vh - m) top = vh - m - halfH
    favTooltipPos = { left: left / k, top: top / k }
  })

  function showTooltip(e: MouseEvent, name: string, status: LiveStatus): void {
    const fav = store.getStatus(name)
    tooltipFav = {
      name,
      status,
      rect: (e.currentTarget as HTMLElement).getBoundingClientRect(),
      lastFetched: fav?.lastFetched ?? null,
    }
  }
  function hideTooltip(): void {
    tooltipFav = null
  }

  onMount(() => {
    const unsubscribe = store.subscribe((s) => {
      statuses = s
    })
    store.start()
    return unsubscribe
  })

  function removeFav(name: string, e: Event): void {
    e.stopPropagation()
    store.remove(name)
  }

  async function openAddMenu(): Promise<void> {
    addMenuOpen = true
    addError = ''
    addInput = ''
    await tick()
    addInputEl?.focus()
  }

  function closeAddMenu(): void {
    addMenuOpen = false
    addError = ''
    addInput = ''
  }

  function submitAdd(e: Event): void {
    e.preventDefault()
    const raw = addInput
    if (!raw.trim()) return
    const name = normalizeChannelName(raw)
    if (!isValidChannelName(name)) {
      addError = 'Invalid channel name'
      return
    }
    if (store.has(name)) {
      addError = 'Already in favorites'
      return
    }
    if (!store.add(name)) {
      addError = `Favorites are limited to ${MAX_FAVORITES}`
      return
    }
    closeAddMenu()
  }

  function onAddInputKeydown(e: KeyboardEvent): void {
    if (e.key === 'Escape') {
      e.preventDefault()
      closeAddMenu()
    }
  }

  function handleContextMenu(name: string, e: MouseEvent): void {
    e.preventDefault()
    if (confirm('Remove ' + name + ' from favorites?')) {
      store.remove(name)
    }
  }

  function onDragStart(e: DragEvent, name: string): void {
    if (!e.dataTransfer) return
    draggingName = name
    e.dataTransfer.effectAllowed = 'move'
    e.dataTransfer.setData('text/plain', name)
  }

  function onDragOver(e: DragEvent, name: string): void {
    if (!draggingName || draggingName === name) return
    e.preventDefault()
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'move'
    dragOverName = name
  }

  function onDragLeave(_e: DragEvent, name: string): void {
    if (dragOverName === name) dragOverName = null
  }

  function onDrop(e: DragEvent, name: string): void {
    e.preventDefault()
    if (draggingName && draggingName !== name) {
      store.reorder(draggingName, name)
    }
    draggingName = null
    dragOverName = null
  }

  function onDragEnd(): void {
    draggingName = null
    dragOverName = null
  }

  function avatarInitial(name: string): string {
    return name.charAt(0).toUpperCase() || '?'
  }

  function avatarBg(name: string): string {
    let h = 0
    for (let i = 0; i < name.length; i++) {
      h = (h * 31 + name.charCodeAt(i)) >>> 0
    }
    const hue = h % 360
    return 'hsl(' + hue + ' 45% 35%)'
  }

  function statusLabel(s: LiveStatus): string {
    if (s.state === 'live') {
      return s.viewers.toLocaleString() + ' viewers'
    }
    if (s.state === 'offline') return 'Offline'
    if (s.state === 'error') return 'Error'
    return ''
  }

  function formatViewers(n: number): string {
    if (n < 1000) return n.toString()
    if (n < 1_000_000) {
      const k = n / 1000
      return (k < 100 ? k.toFixed(1).replace(/\.0$/, '') : Math.round(k).toString()) + 'K'
    }
    return (n / 1_000_000).toFixed(1).replace(/\.0$/, '') + 'M'
  }

  function isLive(s: LiveStatus): boolean {
    return s.state === 'live'
  }

  function liveInfo(s: LiveStatus): { title: string; viewers: number; game: string; avatarUrl: string } | null {
    return s.state === 'live' ? s : null
  }

  function avatarSrc(s: LiveStatus): string | null {
    if ((s.state === 'live' || s.state === 'offline') && s.avatarUrl) return s.avatarUrl
    return null
  }

  function timeAgo(ts: number | null): string {
    if (ts === null) return ''
    const diff = Date.now() - ts
    if (diff < 0) return ''
    if (diff < 60_000) return 'just now'
    if (diff < 3_600_000) return Math.floor(diff / 60_000) + 'm ago'
    if (diff < 86_400_000) return Math.floor(diff / 3_600_000) + 'h ago'
    return Math.floor(diff / 86_400_000) + 'd ago'
  }
</script>

<aside class="sidebar" class:sidebar--icons={iconsOnly}>
  {#if !iconsOnly}
  <div class="sidebar-header">
    <div class="header-row">
      <h2 class="sidebar-title">Favorites</h2>
      <button
        type="button"
        class="add-fav-btn"
        onclick={addMenuOpen ? closeAddMenu : openAddMenu}
        aria-label={addMenuOpen ? 'Close add favorite' : 'Add favorite'}
        aria-expanded={addMenuOpen}
        use:tooltip={addMenuOpen ? 'Close' : 'Add favorite'}
      >
        {#if addMenuOpen}
          <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">
            <path d="M3 3l10 10M13 3L3 13" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
          </svg>
        {:else}
          <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">
            <path d="M8 3v10M3 8h10" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
          </svg>
        {/if}
      </button>
    </div>
    {#if addMenuOpen}
      <form class="add-fav-form" onsubmit={submitAdd}>
        <input
          bind:this={addInputEl}
          bind:value={addInput}
          type="text"
          class="add-fav-input"
          placeholder="channel name"
          spellcheck="false"
          autocomplete="off"
          aria-label="Channel name"
          aria-invalid={!!addError}
          onkeydown={onAddInputKeydown}
        />
        <button type="submit" class="add-fav-submit" disabled={!addInput.trim()}>
          Add
        </button>
      </form>
      {#if addError}
        <div class="add-fav-error" role="alert">{addError}</div>
      {/if}
    {/if}
    {#if store.rateLimited}
      <div class="rate-limit-banner" role="status">
        DecAPI rate-limited — live statuses may be stale
      </div>
    {/if}
  </div>
  {/if}

  <div class="sidebar-list">
    {#if statuses.length === 0}
      <div class="empty">No favorites yet. Click the + at the top of the sidebar to add a channel.</div>
    {:else}
      {#each statuses as fav (fav.name)}
        {@const info = liveInfo(fav.status)}
        {@const isOff = fav.status.state === 'offline'}
        {@const isErr = fav.status.state === 'error'}
        <button
          type="button"
          class="fav"
          class:fav--active={currentChannel === fav.name}
          class:fav--offline={isOff}
          class:fav--error={isErr}
          class:fav--dragging={draggingName === fav.name}
          class:fav--drag-over={dragOverName === fav.name}
          draggable="true"
          ondragstart={(e) => onDragStart(e, fav.name)}
          ondragover={(e) => onDragOver(e, fav.name)}
          ondragleave={(e) => onDragLeave(e, fav.name)}
          ondrop={(e) => onDrop(e, fav.name)}
          ondragend={onDragEnd}
          onmouseenter={(e) => {
            hoveredName = fav.name
            if (iconsOnly) showTooltip(e, fav.name, fav.status)
          }}
          onmouseleave={() => {
            hoveredName = null
            hideTooltip()
          }}
          oncontextmenu={(e) => handleContextMenu(fav.name, e)}
          onclick={() => onselect(fav.name)}
        >
          <span class="avatar" style="background: {info && info.avatarUrl ? 'transparent' : avatarBg(fav.name)}">
            {#if avatarSrc(fav.status)}
              <img src={avatarSrc(fav.status)} alt="" loading="lazy" />
            {:else}
              <span class="avatar-initial">{avatarInitial(fav.name)}</span>
            {/if}
          </span>
          {#if !iconsOnly}
          <span class="fav-body">
            <span class="fav-name">
              {fav.name}
              {#if hoveredName === fav.name}
                <span
                  class="fav-remove"
                  role="button"
                  tabindex="-1"
                  aria-label="Remove"
                  onclick={(e) => removeFav(fav.name, e)}
                  onkeydown={(e) => { if (e.key === 'Enter' || e.key === ' ') removeFav(fav.name, e) }}
                >×</span>
              {/if}
              {#if fav.updateDelayed}
                <span
                  class="fav-stale-dot"
                  aria-label="Updates paused — couldn't reach the API across consecutive attempts"
                  title="Updates paused — couldn't reach the API across consecutive attempts"
                  aria-hidden="false"
                ></span>
              {/if}
            </span>
            {#if info}
              {#if info.title}
                <span class="fav-title" use:tooltip={{ text: info.title, delay: 1500 }}>{info.title}</span>
              {/if}
              {#if info.game}
                <span class="fav-game" use:tooltip={{ text: info.game, delay: 1500 }}>{info.game}</span>
              {:else if !info.title}
                <span class="fav-title fav-title--muted">Live</span>
              {/if}
            {:else if isOff}
              <span class="fav-title fav-title--muted">Offline</span>
            {:else if isErr}
              <span class="fav-title fav-title--muted">
                Couldn't load{#if fav.lastFetched} · {timeAgo(fav.lastFetched)}{/if}
              </span>
              <span
                class="fav-retry"
                role="button"
                tabindex="0"
                aria-label="Retry"
                onclick={(e) => { e.stopPropagation(); store.retryFetch(fav.name) }}
                onkeydown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); store.retryFetch(fav.name) } }}
                use:tooltip={{ text: 'Retry now', delay: 1500 }}
              >
                <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">
                  <path d="M13.5 8a5.5 5.5 0 1 1-1.6-3.9M13.5 3v3h-3" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
                </svg>
              </span>
            {:else}
              <span class="fav-title fav-title--muted">Loading…</span>
            {/if}
          </span>
           {#if info}
             <span class="fav-meta">
               <span class="live-dot" aria-hidden="true"></span>
               <span class="fav-viewers">{formatViewers(info.viewers)}</span>
             </span>
           {/if}
         {/if}
         </button>
       {/each}
     {/if}
   </div>

  <!-- Hover tooltip — rendered at the sidebar level (not inside .sidebar-list
       which would clip it via overflow: auto). Positioned with position: fixed
       so it's not clipped by any ancestor, and lives in the zoomed tree so
       it scales with UI scale. -->
  {#if iconsOnly && tooltipFav}
    {@const tip = tooltipFav}
    <div
      bind:this={favTooltipEl}
      class="fav-tooltip fav-tooltip--visible"
      role="tooltip"
      style:left="{favTooltipPos.left}px"
      style:top="{favTooltipPos.top}px"
    >
      <div class="fav-tooltip-name">{tip.name}</div>
      {#if tip.status.state === 'live'}
        {@const live = tip.status}
        <div class="fav-tooltip-row fav-tooltip-row--live">
          <span class="fav-tooltip-dot" aria-hidden="true"></span>
          <span>Live · {formatViewers(live.viewers)} viewers</span>
        </div>
        {#if live.title}
          <div class="fav-tooltip-title" use:tooltip={{ text: live.title, delay: 1500 }}>{live.title}</div>
        {/if}
        {#if live.game}
          <div class="fav-tooltip-game" use:tooltip={{ text: live.game, delay: 1500 }}>{live.game}</div>
        {/if}
      {:else if tip.status.state === 'offline'}
        <div class="fav-tooltip-row fav-tooltip-row--muted">Offline</div>
      {:else if tip.status.state === 'error'}
        <div class="fav-tooltip-row fav-tooltip-row--muted">
          Couldn't load{tip.lastFetched ? ` · ${timeAgo(tip.lastFetched)}` : ''}
        </div>
      {:else}
        <div class="fav-tooltip-row fav-tooltip-row--muted">Loading…</div>
      {/if}
    </div>
  {/if}
</aside>

<style>
  .sidebar {
    flex: 0 0 220px;
    width: 220px;
    height: 100%;
    background: var(--bg-panel);
    border-right: 1px solid var(--border);
    display: flex;
    flex-direction: column;
    box-sizing: border-box;
    min-height: 0;
  }

  .sidebar--icons {
    flex: 0 0 56px;
    width: 56px;
  }

  .sidebar--icons .sidebar-list {
    padding: 4px 0;
  }

  .sidebar--icons .fav {
    justify-content: center;
    padding: 4px 0;
  }

  .sidebar-header {
    padding: 8px 10px;
    border-bottom: 1px solid var(--border);
    flex: 0 0 auto;
    display: flex;
    flex-direction: column;
    gap: 6px;
  }

  .header-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
  }

  .sidebar-title {
    margin: 0;
    font-size: 11px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: var(--text-secondary);
  }

  .add-fav-btn {
    background: transparent;
    border: 1px solid transparent;
    color: var(--text-secondary);
    width: 22px;
    height: 22px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    border-radius: 4px;
    cursor: pointer;
    padding: 0;
  }
  .add-fav-btn:hover {
    background: var(--bg-input);
    color: var(--text);
  }
  .add-fav-btn[aria-expanded="true"] {
    background: var(--bg-input);
    color: var(--text);
  }

  .add-fav-form {
    display: flex;
    gap: 4px;
    align-items: stretch;
  }
  .add-fav-input {
    flex: 1 1 auto;
    min-width: 0;
    background: var(--bg-input);
    border: 1px solid var(--border);
    color: var(--text);
    border-radius: 4px;
    padding: 4px 6px;
    font-size: 12px;
    font-family: inherit;
  }
  .add-fav-input:focus {
    outline: none;
    border-color: var(--accent);
  }
  .add-fav-input[aria-invalid="true"] {
    border-color: var(--live, #c0392b);
  }
  .add-fav-submit {
    flex: 0 0 auto;
    background: var(--accent);
    color: var(--accent-text, #fff);
    border: 1px solid transparent;
    border-radius: 4px;
    padding: 4px 10px;
    font-size: 12px;
    font-weight: 600;
    cursor: pointer;
  }
  .add-fav-submit:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
  .add-fav-error {
    font-size: 11px;
    color: var(--live, #c0392b);
  }

  .rate-limit-banner {
    margin-top: 6px;
    padding: 4px 8px;
    border-radius: 3px;
    background: var(--bg-input);
    color: var(--live);
    border: 1px solid var(--border);
    font-size: 10px;
    font-weight: 600;
    line-height: 1.3;
  }

  .sidebar-list {
    flex: 1 1 auto;
    overflow-y: auto;
    min-height: 0;
  }

  .empty {
    padding: 16px 12px;
    color: var(--text-dim);
    font-size: 12px;
    text-align: center;
  }

  .fav {
    display: flex;
    align-items: center;
    gap: 10px;
    width: 100%;
    padding: 6px 10px 6px 9px;
    border: none;
    border-left: 3px solid transparent;
    background: transparent;
    color: var(--text-primary);
    text-align: left;
    cursor: pointer;
    box-sizing: border-box;
    font-family: inherit;
    transition: background 150ms, border-color 150ms;
    min-height: 42px;
    position: relative;
  }

  .fav:hover {
    background: var(--bg-input);
  }

  .fav--active {
    border-left-color: var(--accent);
    background: var(--bg-input);
  }

  .fav--active:hover {
    background: var(--bg-hover);
  }

  .avatar {
    position: relative;
    flex: 0 0 auto;
    width: 30px;
    height: 30px;
    border-radius: 50%;
    overflow: hidden;
    display: flex;
    align-items: center;
    justify-content: center;
    color: var(--text-primary);
    font-weight: 700;
    font-size: 13px;
  }

  .avatar img {
    width: 100%;
    height: 100%;
    object-fit: cover;
    display: block;
  }

  .avatar-initial {
    line-height: 1;
  }

  .fav-body {
    flex: 1 1 auto;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 2px;
    line-height: 1.25;
  }

  .fav-name {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 13px;
    font-weight: 700;
    color: var(--text-primary);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .fav-remove {
    flex: 0 0 auto;
    width: 16px;
    height: 16px;
    line-height: 14px;
    text-align: center;
    border-radius: 50%;
    background: var(--track);
    color: var(--text-primary);
    font-size: 12px;
    cursor: pointer;
    user-select: none;
    transition: background 150ms;
  }

  .fav-remove:hover {
    background: var(--live);
  }

  .fav-title {
    font-size: 12px;
    color: var(--text-secondary);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .fav-game {
    font-size: 11px;
    color: var(--text-dim);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .fav-title--muted {
    color: var(--text-dim);
  }

  .fav-meta {
    display: flex;
    align-items: center;
    gap: 4px;
    flex: 0 0 auto;
    font-size: 12px;
    color: var(--text-secondary);
    white-space: nowrap;
    font-variant-numeric: tabular-nums;
  }

  .live-dot {
    flex: 0 0 auto;
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: var(--live);
  }

  .fav-viewers {
    color: var(--text-secondary);
  }

  .fav--offline .fav-name {
    color: var(--text-dim);
  }

  .fav--offline .avatar {
    opacity: 0.5;
    filter: grayscale(0.6);
  }

  .fav--error .fav-name {
    color: var(--text-secondary);
  }

  /* Hover tooltip — only visible in icons-only mode. Rendered as a
     child of .sidebar (not inside .sidebar-list which would clip it).
     Positioned with `position: fixed` so it escapes any overflow
     clipping, and because it lives in the zoomed tree, it scales
     with the UI scale. The .fav:hover/.fav:focus-visible rules don't
     reach this tooltip anymore (it's now a sibling of .fav), so
     visibility is driven by the JS state via the --visible class. */
  .fav-tooltip {
    position: fixed;
    z-index: 100;
    min-width: 180px;
    max-width: 280px;
    padding: 8px 10px;
    background: var(--bg-overlay-strong);
    border: 1px solid var(--border);
    border-radius: 6px;
    box-shadow: 0 4px 12px rgba(0, 0, 0, 0.45);
    font-size: 12px;
    line-height: 1.35;
    color: var(--text-primary);
    text-align: left;
    opacity: 0;
    visibility: hidden;
    pointer-events: none;
    transform: translateY(-50%);
    transition: opacity 120ms ease, visibility 0s linear 120ms;
  }
  .fav-tooltip--visible {
    opacity: 1;
    visibility: visible;
    transition: opacity 120ms ease, visibility 0s linear 0s;
  }
  .fav-tooltip-name {
    font-weight: 700;
    color: var(--text-primary);
    margin-bottom: 4px;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .fav-tooltip-row {
    display: flex;
    align-items: center;
    gap: 4px;
    font-variant-numeric: tabular-nums;
    color: var(--text-secondary);
  }
  .fav-tooltip-row--live {
    color: var(--live);
  }
  .fav-tooltip-row--muted {
    color: var(--text-dim);
  }
  .fav-tooltip-dot {
    flex: 0 0 auto;
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: var(--live);
  }
  .fav-tooltip-title {
    margin-top: 4px;
    color: var(--text-primary);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .fav-tooltip-game {
    color: var(--text-secondary);
    font-size: 11px;
    margin-top: 2px;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .fav-stale-dot {
    flex: 0 0 auto;
    width: 6px;
    height: 6px;
    margin-left: 6px;
    border-radius: 50%;
    background: var(--text-dim);
    box-shadow: 0 0 0 2px var(--bg-panel);
    animation: fav-stale-pulse 2.4s ease-in-out infinite;
  }

  @keyframes fav-stale-pulse {
    0%, 100% { opacity: 0.45; }
    50%      { opacity: 0.9; }
  }

  .fav-retry {
    flex: 0 0 auto;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 18px;
    height: 18px;
    margin-left: 4px;
    border-radius: 4px;
    color: var(--text-secondary);
    cursor: pointer;
    user-select: none;
  }
  .fav-retry:hover {
    background: var(--bg-hover);
    color: var(--text-primary);
  }

  .fav--dragging {
    opacity: 0.4;
  }

  .fav--drag-over {
    border-top: 2px solid var(--accent);
    padding-top: calc(6px - 2px);
  }

  .sidebar-list::-webkit-scrollbar {
    width: 6px;
  }

  .sidebar-list::-webkit-scrollbar-track {
    background: transparent;
  }

  .sidebar-list::-webkit-scrollbar-thumb {
    background: var(--bg-hover);
    border-radius: 3px;
  }

  .sidebar-list::-webkit-scrollbar-thumb:hover {
    background: var(--track);
  }

  @media (max-width: 900px) {
    .sidebar:not(.sidebar--icons) {
      flex: 0 0 200px;
      width: 200px;
    }
  }

  @media (max-width: 900px) {
    .sidebar:not(.sidebar--icons) {
      flex: 0 0 50px;
      width: 50px;
      overflow: hidden;
    }
    .sidebar:not(.sidebar--icons) .sidebar-header,
    .sidebar:not(.sidebar--icons) .fav-body,
    .sidebar:not(.sidebar--icons) .fav-meta {
      display: none;
    }
    .sidebar:not(.sidebar--icons) .fav {
      justify-content: center;
      padding: 6px 0 6px 0;
      border-left-width: 3px;
    }
  }
</style>
