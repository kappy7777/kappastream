<script lang="ts">
  import { onMount } from 'svelte'
  import {
    fetchTopStreams,
    fetchTopCategories,
    fetchGameStreams,
    type BrowseStream,
    type BrowseCategory,
  } from './gql'

  /*
   * Channel discovery browse overlay — top live channels and top categories,
   * with the ability to drill into a category's live streams. Read-only and
   * anonymous; backed entirely by the GQL transport (no DecAPI fallback).
   *
   * Failure discipline matches the rest of the app: an empty result set is a
   * SUCCESS (just an empty grid), while a transport failure shows a visible,
   * non-blocking error with a Retry control — never silently "no results".
   * All data is user-triggered (on open / on pagination); there is no
   * background polling, so the favorites loop and its refresh interval are
   * untouched.
   *
   * Selecting a stream funnels through the single `onselect(login)` callback,
   * which App.svelte routes into its existing selectChannel() → connect().
   */

  interface Props {
    onselect: (login: string) => void
    onclose: () => void
  }

  const { onselect, onclose }: Props = $props()

  const FIRST = 30

  type View = 'overview' | 'category'
  let view = $state<View>('overview')
  let activeCategory = $state<BrowseCategory | null>(null)

  // Overview: top live channels.
  let streams = $state<BrowseStream[]>([])
  let streamsCursor = $state<string | null>(null)
  let streamsLoading = $state(false)
  let streamsLoadingMore = $state(false)
  let streamsError = $state(false)

  // Overview: top categories.
  let categories = $state<BrowseCategory[]>([])
  let categoriesCursor = $state<string | null>(null)
  let categoriesLoading = $state(false)
  let categoriesLoadingMore = $state(false)
  let categoriesError = $state(false)

  // Category drill-in: that category's live streams.
  let gameStreams = $state<BrowseStream[]>([])
  let gameCursor = $state<string | null>(null)
  let gameLoading = $state(false)
  let gameLoadingMore = $state(false)
  let gameError = $state(false)

  function formatViewers(n: number): string {
    if (n < 1000) return n.toString()
    if (n < 1_000_000) {
      const k = n / 1000
      return (k < 100 ? k.toFixed(1).replace(/\.0$/, '') : Math.round(k).toString()) + 'K'
    }
    return (n / 1_000_000).toFixed(1).replace(/\.0$/, '') + 'M'
  }

  async function loadStreams(append: boolean): Promise<void> {
    if (append && (!streamsCursor || streamsLoadingMore)) return
    if (append) streamsLoadingMore = true
    else streamsLoading = true
    streamsError = false
    try {
      const page = await fetchTopStreams(FIRST, append ? streamsCursor : null)
      if (append && page.streams.length === 0) {
        streamsCursor = null
      } else {
        streams = append ? [...streams, ...page.streams] : page.streams
        streamsCursor = page.cursor
      }
    } catch {
      streamsError = true
    } finally {
      streamsLoading = false
      streamsLoadingMore = false
    }
  }

  async function loadCategories(append: boolean): Promise<void> {
    if (append && (!categoriesCursor || categoriesLoadingMore)) return
    if (append) categoriesLoadingMore = true
    else categoriesLoading = true
    categoriesError = false
    try {
      const page = await fetchTopCategories(FIRST, append ? categoriesCursor : null)
      if (append && page.categories.length === 0) {
        categoriesCursor = null
      } else {
        categories = append ? [...categories, ...page.categories] : page.categories
        categoriesCursor = page.cursor
      }
    } catch {
      categoriesError = true
    } finally {
      categoriesLoading = false
      categoriesLoadingMore = false
    }
  }

  async function loadGameStreams(append: boolean): Promise<void> {
    if (!activeCategory) return
    if (append && (!gameCursor || gameLoadingMore)) return
    if (append) gameLoadingMore = true
    else gameLoading = true
    gameError = false
    try {
      const page = await fetchGameStreams(activeCategory.name, FIRST, append ? gameCursor : null)
      if (append && page.streams.length === 0) {
        gameCursor = null
      } else {
        gameStreams = append ? [...gameStreams, ...page.streams] : page.streams
        gameCursor = page.cursor
      }
    } catch {
      gameError = true
    } finally {
      gameLoading = false
      gameLoadingMore = false
    }
  }

  function openCategory(cat: BrowseCategory): void {
    activeCategory = cat
    view = 'category'
    gameStreams = []
    gameCursor = null
    gameError = false
    void loadGameStreams(false)
  }

  function closeCategory(): void {
    view = 'overview'
    activeCategory = null
  }

  function close(): void {
    onclose()
  }

  function onThumbError(e: Event): void {
    const img = e.currentTarget as HTMLImageElement
    img.style.visibility = 'hidden'
  }

  function onKeyDown(e: KeyboardEvent): void {
    if (e.key === 'Escape') {
      e.preventDefault()
      if (view === 'category') closeCategory()
      else close()
    }
  }

  onMount(() => {
    void loadStreams(false)
    void loadCategories(false)
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  })
</script>

<div class="browse-backdrop" onclick={close} role="presentation"></div>
<div class="browse-modal" role="dialog" aria-modal="true" aria-label="Browse channels and categories">
  <header class="browse-head">
    <div class="browse-head-left">
      {#if view === 'category' && activeCategory}
        <button type="button" class="browse-back" onclick={closeCategory} aria-label="Back to browse">←</button>
        <span class="browse-title">{activeCategory.displayName}</span>
      {:else}
        <span class="browse-title">Browse</span>
      {/if}
    </div>
    <button type="button" class="browse-close" onclick={close} aria-label="Close">
      <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
        <path d="M3 3l10 10M13 3L3 13" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" />
      </svg>
    </button>
  </header>

  <div class="browse-body">
    {#if view === 'overview'}
      <section class="browse-section">
        <h2 class="browse-section-title">Top Live Channels</h2>
        {#if streamsLoading && streams.length === 0}
          <div class="browse-status">Loading channels…</div>
        {:else if streamsError && streams.length === 0}
          <div class="browse-status browse-status--error">
            Failed to load channels.
            <button type="button" class="retry-btn" onclick={() => loadStreams(false)}>Retry</button>
          </div>
        {:else if streams.length === 0}
          <div class="browse-status">No live channels right now.</div>
        {:else}
          <div class="browse-grid browse-grid--streams">
            {#each streams as s (s.id)}
              <button type="button" class="stream-card" onclick={() => onselect(s.login)}>
                <div class="stream-card-thumb">
                  <img
                    src={s.thumbnailUrl || ''}
                    alt=""
                    width="320"
                    height="180"
                    loading="lazy"
                    onerror={onThumbError}
                  />
                  <span class="stream-card-badge">LIVE</span>
                  {#if s.viewersCount > 0}
                    <span class="stream-card-viewers">{formatViewers(s.viewersCount)}</span>
                  {/if}
                </div>
                <div class="stream-card-meta">
                  <img
                    class="stream-card-avatar"
                    src={s.avatarUrl || ''}
                    alt=""
                    loading="lazy"
                    onerror={onThumbError}
                  />
                  <div class="stream-card-text">
                    <span class="stream-card-name">{s.displayName}</span>
                    <span class="stream-card-title">{s.title || 'Untitled broadcast'}</span>
                    {#if s.game}<span class="stream-card-game">{s.game}</span>{/if}
                  </div>
                </div>
              </button>
            {/each}
          </div>
          {#if streamsError}
            <div class="browse-inline-error">
              Failed to load more.
              <button type="button" class="retry-btn" onclick={() => loadStreams(true)}>Retry</button>
            </div>
          {/if}
          {#if streamsCursor}
            <button
              type="button"
              class="load-more"
              onclick={() => loadStreams(true)}
              disabled={streamsLoadingMore}
            >
              {streamsLoadingMore ? 'Loading…' : 'Load more'}
            </button>
          {/if}
        {/if}
      </section>

      <section class="browse-section">
        <h2 class="browse-section-title">Top Categories</h2>
        {#if categoriesLoading && categories.length === 0}
          <div class="browse-status">Loading categories…</div>
        {:else if categoriesError && categories.length === 0}
          <div class="browse-status browse-status--error">
            Failed to load categories.
            <button type="button" class="retry-btn" onclick={() => loadCategories(false)}>Retry</button>
          </div>
        {:else if categories.length === 0}
          <div class="browse-status">No categories right now.</div>
        {:else}
          <div class="browse-grid browse-grid--cats">
            {#each categories as c (c.id)}
              <button type="button" class="cat-card" onclick={() => openCategory(c)}>
                <img
                  class="cat-card-box"
                  src={c.boxArtUrl || ''}
                  alt={c.displayName}
                  width="144"
                  height="192"
                  loading="lazy"
                  onerror={onThumbError}
                />
                <span class="cat-card-name">{c.displayName}</span>
              </button>
            {/each}
          </div>
          {#if categoriesError}
            <div class="browse-inline-error">
              Failed to load more.
              <button type="button" class="retry-btn" onclick={() => loadCategories(true)}>Retry</button>
            </div>
          {/if}
          {#if categoriesCursor}
            <button
              type="button"
              class="load-more"
              onclick={() => loadCategories(true)}
              disabled={categoriesLoadingMore}
            >
              {categoriesLoadingMore ? 'Loading…' : 'Load more'}
            </button>
          {/if}
        {/if}
      </section>
    {:else}
      <section class="browse-section">
        {#if gameLoading && gameStreams.length === 0}
          <div class="browse-status">Loading streams…</div>
        {:else if gameError && gameStreams.length === 0}
          <div class="browse-status browse-status--error">
            Failed to load streams.
            <button type="button" class="retry-btn" onclick={() => loadGameStreams(false)}>Retry</button>
          </div>
        {:else if gameStreams.length === 0}
          <div class="browse-status">No live channels in this category right now.</div>
        {:else}
          <div class="browse-grid browse-grid--streams">
            {#each gameStreams as s (s.id)}
              <button type="button" class="stream-card" onclick={() => onselect(s.login)}>
                <div class="stream-card-thumb">
                  <img
                    src={s.thumbnailUrl || ''}
                    alt=""
                    width="320"
                    height="180"
                    loading="lazy"
                    onerror={onThumbError}
                  />
                  <span class="stream-card-badge">LIVE</span>
                  {#if s.viewersCount > 0}
                    <span class="stream-card-viewers">{formatViewers(s.viewersCount)}</span>
                  {/if}
                </div>
                <div class="stream-card-meta">
                  <img
                    class="stream-card-avatar"
                    src={s.avatarUrl || ''}
                    alt=""
                    loading="lazy"
                    onerror={onThumbError}
                  />
                  <div class="stream-card-text">
                    <span class="stream-card-name">{s.displayName}</span>
                    <span class="stream-card-title">{s.title || 'Untitled broadcast'}</span>
                    {#if s.game}<span class="stream-card-game">{s.game}</span>{/if}
                  </div>
                </div>
              </button>
            {/each}
          </div>
          {#if gameError}
            <div class="browse-inline-error">
              Failed to load more.
              <button type="button" class="retry-btn" onclick={() => loadGameStreams(true)}>Retry</button>
            </div>
          {/if}
          {#if gameCursor}
            <button
              type="button"
              class="load-more"
              onclick={() => loadGameStreams(true)}
              disabled={gameLoadingMore}
            >
              {gameLoadingMore ? 'Loading…' : 'Load more'}
            </button>
          {/if}
        {/if}
      </section>
    {/if}
  </div>
</div>

<style>
  .browse-backdrop {
    position: fixed;
    inset: 0;
    background: var(--bg-overlay-strong);
    z-index: 1000;
  }

  .browse-modal {
    position: fixed;
    top: 50%;
    left: 50%;
    transform: translate(-50%, -50%);
    z-index: 1001;
    width: min(1100px, calc(100vw - 32px));
    max-width: 100%;
    height: min(82vh, 820px);
    display: flex;
    flex-direction: column;
    background: var(--bg-panel);
    border: 1px solid var(--border);
    border-radius: 10px;
    box-shadow: var(--shadow-menu);
    color: var(--text-primary);
    overflow: hidden;
  }

  .browse-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 10px 14px;
    border-bottom: 1px solid var(--border);
    flex: 0 0 auto;
  }

  .browse-head-left {
    display: flex;
    align-items: center;
    gap: 10px;
    min-width: 0;
  }

  .browse-title {
    font-size: 16px;
    font-weight: 700;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .browse-back,
  .browse-close {
    flex: 0 0 auto;
    width: 30px;
    height: 30px;
    border: none;
    border-radius: 5px;
    background: transparent;
    color: var(--text-secondary);
    cursor: pointer;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    font-size: 16px;
    transition: background 120ms, color 120ms;
  }

  .browse-back {
    width: auto;
    padding: 0 8px;
    font-size: 15px;
  }

  .browse-back:hover,
  .browse-close:hover {
    background: var(--bg-hover);
    color: var(--text-primary);
  }

  .browse-body {
    flex: 1 1 auto;
    overflow-y: auto;
    padding: 14px;
    display: flex;
    flex-direction: column;
    gap: 24px;
  }

  .browse-section {
    display: flex;
    flex-direction: column;
    gap: 10px;
  }

  .browse-section-title {
    font-size: 12px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: var(--text-secondary);
    margin: 0;
  }

  .browse-status {
    padding: 16px;
    font-size: 13px;
    color: var(--text-dim);
    text-align: center;
  }

  .browse-status--error {
    color: var(--live);
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 8px;
  }

  .retry-btn {
    border: 1px solid var(--border);
    border-radius: 4px;
    background: var(--bg-input);
    color: var(--text-primary);
    font-size: 12px;
    padding: 2px 8px;
    cursor: pointer;
  }

  .retry-btn:hover {
    background: var(--bg-hover);
  }

  .browse-inline-error {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 8px 4px;
    font-size: 12px;
    color: var(--live);
  }

  .browse-grid {
    display: grid;
    gap: 12px;
  }

  /* Stream cards: 16:9 thumbnails tile across, collapsing gracefully. */
  .browse-grid--streams {
    grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
  }

  /* Category box-art cards are narrower (3:4), so a tighter min width. */
  .browse-grid--cats {
    grid-template-columns: repeat(auto-fill, minmax(120px, 1fr));
  }

  .stream-card {
    display: flex;
    flex-direction: column;
    gap: 8px;
    padding: 0;
    border: none;
    background: transparent;
    color: var(--text-primary);
    text-align: left;
    cursor: pointer;
    min-width: 0;
  }

  .stream-card-thumb {
    position: relative;
    width: 100%;
    aspect-ratio: 16 / 9;
    background: var(--bg-input);
    border-radius: 6px;
    overflow: hidden;
  }

  .stream-card-thumb img {
    width: 100%;
    height: 100%;
    object-fit: cover;
    display: block;
  }

  .stream-card-badge {
    position: absolute;
    top: 6px;
    left: 6px;
    font-size: 10px;
    font-weight: 700;
    letter-spacing: 0.04em;
    color: #fff;
    background: var(--live);
    border-radius: 3px;
    padding: 1px 5px;
    line-height: 1.5;
  }

  .stream-card-viewers {
    position: absolute;
    bottom: 6px;
    left: 6px;
    font-size: 11px;
    font-weight: 600;
    color: #fff;
    background: rgba(0, 0, 0, 0.7);
    border-radius: 3px;
    padding: 1px 5px;
    font-variant-numeric: tabular-nums;
  }

  .stream-card-meta {
    display: flex;
    align-items: flex-start;
    gap: 8px;
    min-width: 0;
  }

  .stream-card-avatar {
    flex: 0 0 auto;
    width: 28px;
    height: 28px;
    border-radius: 50%;
    object-fit: cover;
    background: var(--bg-input);
  }

  .stream-card-text {
    flex: 1 1 auto;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 1px;
  }

  .stream-card-name {
    font-size: 13px;
    font-weight: 600;
    color: var(--text-primary);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .stream-card-title {
    font-size: 12px;
    color: var(--text-secondary);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .stream-card-game {
    font-size: 11px;
    color: var(--text-dim);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .stream-card:hover .stream-card-name {
    color: var(--accent);
  }

  .cat-card {
    display: flex;
    flex-direction: column;
    gap: 6px;
    padding: 0;
    border: none;
    background: transparent;
    color: var(--text-primary);
    text-align: left;
    cursor: pointer;
    min-width: 0;
  }

  .cat-card-box {
    width: 100%;
    aspect-ratio: 3 / 4;
    object-fit: cover;
    border-radius: 6px;
    background: var(--bg-input);
    display: block;
  }

  .cat-card-name {
    font-size: 12px;
    font-weight: 600;
    color: var(--text-primary);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .cat-card:hover .cat-card-name {
    color: var(--accent);
  }

  .load-more {
    align-self: center;
    margin-top: 4px;
    padding: 7px 18px;
    border: 1px solid var(--border);
    border-radius: 5px;
    background: var(--bg-input);
    color: var(--text-primary);
    font-size: 13px;
    cursor: pointer;
    transition: background 120ms;
  }

  .load-more:hover:not(:disabled) {
    background: var(--bg-hover);
  }

  .load-more:disabled {
    opacity: 0.6;
    cursor: default;
  }
</style>
