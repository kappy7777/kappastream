<script lang="ts">
  import { searchChannels, type SearchChannelResult } from './gql'

  /*
   * Channel search box — replaces the bare `.channel-input` in the title bar.
   *
   * PRESERVES the existing muscle memory: typing an exact channel name and
   * pressing Enter connects directly with no extra click (the fast path). Live
   * search results appear in a dropdown as you type; arrow-key + Enter, or a
   * click, connects to a highlighted result instead. Both paths funnel through
   * the single `onselect(login)` callback, which App.svelte routes into its
   * existing selectChannel() → connect() logic (validation + toast included).
   *
   * Search is GQL-only with NO DecAPI fallback, so a transport failure is
   * surfaced in the dropdown as a visible, non-blocking error — never silently
   * shown as "no results". An empty result set is a success (a distinct
   * "no channels found" row that still leaves the Enter fast path available).
   *
   * Input is debounced ~300ms; each new keystroke aborts the in-flight request
   * via AbortController (gqlRequest checks the signal before AND after the
   * transport resolves, so a superseded result is dropped).
   */

  interface Props {
    onselect: (login: string) => void
    disabled?: boolean
  }

  const { onselect, disabled = false }: Props = $props()

  const DEBOUNCE_MS = 300

  let value = $state('')
  let results = $state<SearchChannelResult[]>([])
  // -1 = no row highlighted (Enter uses the fast path).
  let activeIndex = $state(-1)
  type Phase = 'idle' | 'loading' | 'results' | 'empty' | 'error'
  let phase = $state<Phase>('idle')
  let focused = $state(false)

  let searchTimer: ReturnType<typeof setTimeout> | null = null
  let searchController: AbortController | null = null

  // The dropdown panel is visible only while focused and there is something to
  // show (a query in flight, results, an empty-success notice, or an error).
  // Escape / blur / choosing all collapse back to 'idle'.
  const show = $derived(focused && phase !== 'idle')

  function formatViewers(n: number): string {
    if (n < 1000) return n.toString()
    if (n < 1_000_000) {
      const k = n / 1000
      return (k < 100 ? k.toFixed(1).replace(/\.0$/, '') : Math.round(k).toString()) + 'K'
    }
    return (n / 1_000_000).toFixed(1).replace(/\.0$/, '') + 'M'
  }

  // Debounced search. Re-runs on every keystroke (value change). The returned
  // cleanup cancels the pending timer and aborts any in-flight request before
  // the next run (and on unmount), so only the latest query's result applies.
  $effect(() => {
    const q = value.trim()
    if (q.length === 0) {
      results = []
      activeIndex = -1
      phase = 'idle'
      return
    }
    // Opening a query flips to loading immediately so the panel appears.
    phase = 'loading'
    activeIndex = -1
    const query = q
    searchTimer = setTimeout(async () => {
      const controller = new AbortController()
      searchController = controller
      try {
        const res = await searchChannels(query, controller.signal)
        // Drop results that lost the race against a newer keystroke.
        if (searchController !== controller) return
        results = res
        activeIndex = -1
        phase = res.length > 0 ? 'results' : 'empty'
      } catch {
        if (searchController !== controller) return
        // An abort from a newer keystroke is not a user-facing error.
        if (controller.signal.aborted) return
        results = []
        activeIndex = -1
        phase = 'error'
      } finally {
        if (searchController === controller) searchController = null
      }
    }, DEBOUNCE_MS)

    // Cleanup runs before the next keystroke's re-run AND on unmount — so an
    // in-flight request is always aborted rather than resolving into state
    // that may no longer be mounted.
    return () => {
      if (searchTimer) {
        clearTimeout(searchTimer)
        searchTimer = null
      }
      if (searchController) {
        searchController.abort()
        searchController = null
      }
    }
  })

  function onFocus(e: FocusEvent): void {
    focused = true
    ;(e.currentTarget as HTMLInputElement).select()
  }

  function onBlur(): void {
    focused = false
  }

  function clampActive(i: number): number {
    if (results.length === 0) return -1
    if (i < 0) return -1
    if (i >= results.length) return results.length - 1
    return i
  }

  function onKeyDown(e: KeyboardEvent): void {
    if (e.key === 'ArrowDown') {
      if (results.length === 0) return
      e.preventDefault()
      activeIndex = clampActive(activeIndex < 0 ? 0 : activeIndex + 1)
      return
    }
    if (e.key === 'ArrowUp') {
      if (results.length === 0) return
      e.preventDefault()
      activeIndex = clampActive(activeIndex - 1)
      return
    }
    if (e.key === 'Enter') {
      e.preventDefault()
      if (activeIndex >= 0 && results[activeIndex]) {
        choose(results[activeIndex])
      } else {
        submitDirect()
      }
      return
    }
    if (e.key === 'Escape') {
      if (phase !== 'idle') {
        // Close the dropdown but keep input focus so a new query can be typed
        // immediately (re-typing reopens the panel via the value effect).
        e.preventDefault()
        phase = 'idle'
        activeIndex = -1
      }
    }
  }

  // Fast path: connect directly to whatever is typed. Hands the raw text to
  // App.connect (via onselect → selectChannel), which normalizes, validates,
  // and shows the invalid-name toast — identical to the pre-search behavior.
  function submitDirect(): void {
    const name = value
    reset()
    onselect(name)
  }

  function choose(r: SearchChannelResult): void {
    reset()
    onselect(r.login)
  }

  function reset(): void {
    value = ''
    results = []
    activeIndex = -1
    phase = 'idle'
    if (searchController) {
      searchController.abort()
      searchController = null
    }
  }

  function onAvatarError(e: Event): void {
    ;(e.currentTarget as HTMLImageElement).style.visibility = 'hidden'
  }

  // Keep the highlighted row scrolled into view as the arrows move.
  $effect(() => {
    const i = activeIndex
    if (i < 0) return
    const el = document.getElementById(`search-opt-${i}`)
    el?.scrollIntoView({ block: 'nearest' })
  })
</script>

<div class="search-wrap">
  <input
    class="channel-input"
    type="text"
    placeholder="Search or enter channel…"
    bind:value
    onfocus={onFocus}
    onblur={onBlur}
    onkeydown={onKeyDown}
    oninput={() => {
      // Typing reopens the panel if Escape had collapsed it.
      if (!focused) focused = true
    }}
    {disabled}
    role="combobox"
    aria-expanded={show}
    aria-controls="search-listbox"
    aria-autocomplete="list"
    aria-activedescendant={activeIndex >= 0 ? `search-opt-${activeIndex}` : undefined}
    spellcheck="false"
    autocomplete="off"
  />

  {#if show}
    <div class="search-dropdown" id="search-listbox" role="listbox" aria-label="Channel search results">
      {#if phase === 'loading'}
        <div class="search-status">Searching…</div>
      {:else if phase === 'error'}
        <div class="search-status search-status--error">
          Search failed — press Enter to connect to the typed name directly.
        </div>
      {:else if phase === 'empty'}
        <div class="search-status">No channels found — press Enter to connect directly.</div>
      {:else}
        {#each results as r, i (r.id || r.login + i)}
          <button
            type="button"
            id="search-opt-{i}"
            class="search-opt"
            class:search-opt--active={i === activeIndex}
            role="option"
            aria-selected={i === activeIndex}
            onmousedown={(e) => e.preventDefault()}
            onclick={() => choose(r)}
            onmouseenter={() => (activeIndex = i)}
          >
            <img
              class="search-opt-avatar"
              src={r.avatarUrl || ''}
              alt=""
              loading="lazy"
              onerror={onAvatarError}
            />
            <div class="search-opt-main">
              <span class="search-opt-name">{r.displayName}</span>
              {#if r.displayName.toLowerCase() !== r.login}
                <span class="search-opt-login">{r.login}</span>
              {/if}
              {#if r.live && r.game}
                <span class="search-opt-game">{r.game}</span>
              {/if}
            </div>
            {#if r.live}
              <div class="search-opt-live">
                <span class="search-opt-badge">LIVE</span>
                {#if r.viewersCount > 0}
                  <span class="search-opt-viewers">{formatViewers(r.viewersCount)}</span>
                {/if}
              </div>
            {/if}
          </button>
        {/each}
      {/if}
    </div>
  {/if}
</div>

<style>
  .search-wrap {
    position: relative;
    width: 100%;
    max-width: 336px;
  }

  .channel-input {
    width: 100%;
    min-width: 0;
    height: 30px;
    padding: 0 10px;
    border: 1px solid var(--border);
    border-radius: 4px;
    background: var(--bg-input);
    color: var(--text-primary);
    font-size: 13px;
    outline: none;
    transition: border-color 150ms, box-shadow 150ms;
  }

  .channel-input::placeholder {
    color: var(--text-dim);
  }

  .channel-input:focus {
    border-color: var(--accent);
    box-shadow: 0 0 0 1px var(--accent);
  }

  .channel-input:disabled {
    opacity: 0.5;
  }

  .search-dropdown {
    position: absolute;
    top: calc(100% + 4px);
    left: 0;
    right: 0;
    min-width: 0;
    max-height: min(60vh, 420px);
    overflow-y: auto;
    background: var(--bg-panel);
    border: 1px solid var(--border);
    border-radius: 6px;
    box-shadow: var(--shadow-menu);
    z-index: 40;
    padding: 4px;
    transform-origin: top center;
    animation: search-in 120ms ease-out;
  }

  @keyframes search-in {
    from { opacity: 0; transform: translateY(-4px); }
    to { opacity: 1; transform: translateY(0); }
  }

  .search-status {
    padding: 8px 10px;
    font-size: 12px;
    color: var(--text-dim);
  }

  .search-status--error {
    color: var(--live);
  }

  .search-opt {
    display: flex;
    align-items: center;
    gap: 10px;
    width: 100%;
    padding: 6px 8px;
    border: none;
    border-radius: 4px;
    background: transparent;
    color: var(--text-primary);
    text-align: left;
    cursor: pointer;
    transition: background 100ms;
  }

  .search-opt:hover,
  .search-opt--active {
    background: var(--bg-hover);
  }

  .search-opt-avatar {
    flex: 0 0 auto;
    width: 32px;
    height: 32px;
    border-radius: 50%;
    object-fit: cover;
    background: var(--bg-input);
  }

  .search-opt-main {
    flex: 1 1 auto;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 1px;
  }

  .search-opt-name {
    font-size: 13px;
    font-weight: 600;
    color: var(--text-primary);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .search-opt-login {
    font-size: 11px;
    color: var(--text-dim);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .search-opt-game {
    font-size: 11px;
    color: var(--text-secondary);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .search-opt-live {
    flex: 0 0 auto;
    display: flex;
    flex-direction: column;
    align-items: flex-end;
    gap: 1px;
  }

  .search-opt-badge {
    font-size: 9px;
    font-weight: 700;
    letter-spacing: 0.05em;
    color: #fff;
    background: var(--live);
    border-radius: 3px;
    padding: 1px 4px;
    line-height: 1.4;
  }

  .search-opt-viewers {
    font-size: 11px;
    color: var(--text-secondary);
    font-variant-numeric: tabular-nums;
  }
</style>
