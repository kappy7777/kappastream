<script lang="ts">
  import { fetchChannelVideos, fetchChannelClips, type ChannelVideo, type ChannelClip, type ClipsPeriod } from './gql'
  import { revealMore, hasMoreToShow } from './browse-reveal'

  /*
   * Per-channel content sections (Past Broadcasts / Highlights / Recent Clips
   * / Popular Clips) shown BELOW the status bar in side-by-side non-theater
   * mode. App.svelte renders this component only when
   * `!stacked && !theaterMode && channelJoined`, so it is never present in
   * stacked or theater layouts.
   *
   * Fetching is lazy: an IntersectionObserver on a sentinel at the top of the
   * component fires the FIRST time the sections scroll into view. Most sessions
   * never scroll, so this avoids wasted GQL requests per channel open. In-flight
   * requests are aborted on channel change. Empty is a SUCCESS (a channel may
   * have no clips); only a transport failure shows an error.
   *
   * Pagination is client-side reveal (browse-reveal): each list over-fetches
   * its 100-row hard cap up front and reveals a few at a time — no `after`
   * cursor (anonymous GQL cursors fail IntegrityCheckFailed).
   */

  // VOD sections show more initially; clip sections show fewer (5 each) since
  // there are two of them stacked.
  const CC_VOD_INITIAL = 5
  const CC_CLIP_INITIAL = 5

  interface Props {
    channel: string
    onplayVod: (video: ChannelVideo) => void
    onplayClip: (clip: ChannelClip) => void
  }

  const { channel, onplayVod, onplayClip }: Props = $props()

  type Status = 'idle' | 'loading' | 'ready' | 'error'

  let archives = $state<ChannelVideo[]>([])
  let highlights = $state<ChannelVideo[]>([])
  let popularClips = $state<ChannelClip[]>([])
  let recentClips = $state<ChannelClip[]>([])
  let archivesVisible = $state(CC_VOD_INITIAL)
  let highlightsVisible = $state(CC_VOD_INITIAL)
  let popularClipsVisible = $state(CC_CLIP_INITIAL)
  let recentClipsVisible = $state(CC_CLIP_INITIAL)
  let aStatus = $state<Status>('idle')
  let hStatus = $state<Status>('idle')
  let pcStatus = $state<Status>('idle')
  let rcStatus = $state<Status>('idle')

  // The channel we have fetched for (null = not yet fetched). Guards the
  // IntersectionObserver so it only fires once per channel.
  let fetchedChannel = $state<string | null>(null)
  let aborter: AbortController | null = null
  let sentinel = $state<HTMLElement | null>(null)

  function reset(): void {
    archives = []
    highlights = []
    popularClips = []
    recentClips = []
    archivesVisible = CC_VOD_INITIAL
    highlightsVisible = CC_VOD_INITIAL
    popularClipsVisible = CC_CLIP_INITIAL
    recentClipsVisible = CC_CLIP_INITIAL
    aStatus = 'idle'
    hStatus = 'idle'
    pcStatus = 'idle'
    rcStatus = 'idle'
    fetchedChannel = null
  }

  async function loadAll(ch: string): Promise<void> {
    if (!ch || fetchedChannel === ch) return
    fetchedChannel = ch
    aborter?.abort()
    aborter = new AbortController()
    const signal = aborter.signal
    aStatus = 'loading'
    hStatus = 'loading'
    pcStatus = 'loading'
    rcStatus = 'loading'

    const [a, h, pc, rc] = await Promise.allSettled([
      fetchChannelVideos(ch, 'ARCHIVE', signal),
      fetchChannelVideos(ch, 'HIGHLIGHT', signal),
      fetchChannelClips(ch, 'ALL_TIME', signal),
      fetchChannelClips(ch, 'LAST_WEEK', signal),
    ])

    // A channel change/unmount aborted this fetch; drop the result.
    if (signal.aborted || fetchedChannel !== ch) return

    if (a.status === 'fulfilled') {
      archives = a.value
      archivesVisible = CC_VOD_INITIAL
      aStatus = 'ready'
    } else {
      aStatus = 'error'
    }
    if (h.status === 'fulfilled') {
      highlights = h.value
      highlightsVisible = CC_VOD_INITIAL
      hStatus = 'ready'
    } else {
      hStatus = 'error'
    }
    if (pc.status === 'fulfilled') {
      popularClips = pc.value
      popularClipsVisible = CC_CLIP_INITIAL
      pcStatus = 'ready'
    } else {
      pcStatus = 'error'
    }
    if (rc.status === 'fulfilled') {
      recentClips = rc.value
      recentClipsVisible = CC_CLIP_INITIAL
      rcStatus = 'ready'
    } else {
      rcStatus = 'error'
    }
  }

  function retryAll(): void {
    const ch = channel
    if (!ch) return
    fetchedChannel = null
    void loadAll(ch)
  }

  // Reset displayed content whenever the channel changes (plain guard var so
  // the reset itself doesn't retrigger this effect).
  let lastSeenChannel = ''
  $effect(() => {
    const ch = channel
    if (ch !== lastSeenChannel) {
      lastSeenChannel = ch
      reset()
    }
  })

  // Lazy fetch: observe a sentinel and fire the first time it scrolls into view.
  $effect(() => {
    const el = sentinel
    const ch = channel
    if (!el || !ch) return
    const obs = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) void loadAll(ch)
      },
      { rootMargin: '200px' },
    )
    obs.observe(el)
    return () => obs.disconnect()
  })

  function formatViewers(n: number): string {
    if (n < 1000) return n.toString()
    if (n < 1_000_000) {
      const k = n / 1000
      return (k < 100 ? k.toFixed(1).replace(/\.0$/, '') : Math.round(k).toString()) + 'K'
    }
    return (n / 1_000_000).toFixed(1).replace(/\.0$/, '') + 'M'
  }

  function formatDuration(sec: number): string {
    if (!sec || sec < 0) return '0:00'
    const h = Math.floor(sec / 3600)
    const m = Math.floor((sec % 3600) / 60)
    const s = Math.floor(sec % 60)
    if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
    return `${m}:${String(s).padStart(2, '0')}`
  }

  function formatAge(iso: string): string {
    if (!iso) return ''
    const then = Date.parse(iso)
    if (!Number.isFinite(then)) return ''
    const diff = Date.now() - then
    const hr = 3_600_000
    const day = 86_400_000
    if (diff < hr) return Math.max(1, Math.floor(diff / 60_000)) + 'm ago'
    if (diff < day) return Math.floor(diff / hr) + 'h ago'
    if (diff < 30 * day) return Math.floor(diff / day) + 'd ago'
    const mo = Math.floor(diff / (30 * day))
    if (mo < 12) return mo + 'mo ago'
    return Math.floor(mo / 12) + 'y ago'
  }

  function onThumbError(e: Event): void {
    const img = e.currentTarget as HTMLImageElement
    img.style.visibility = 'hidden'
  }
</script>

<div class="channel-content" bind:this={sentinel}>
  <!-- Past Broadcasts -->
  <section class="cc-section">
    <h2 class="cc-title">Past Broadcasts</h2>
    {#if aStatus === 'loading'}
      <div class="cc-status">Loading past broadcasts…</div>
    {:else if aStatus === 'error'}
      <div class="cc-status cc-status--error">
        Failed to load past broadcasts.
        <button type="button" class="cc-retry" onclick={retryAll}>Retry</button>
      </div>
    {:else if aStatus === 'ready' && archives.length === 0}
      <div class="cc-status">No past broadcasts.</div>
    {:else if aStatus === 'ready'}
      <div class="cc-grid">
        {#each archives.slice(0, archivesVisible) as v (v.id)}
          <button type="button" class="cc-card" onclick={() => onplayVod(v)}>
            <div class="cc-thumb">
              <img src={v.thumbnailUrl || ''} alt="" width="320" height="180" loading="lazy" onerror={onThumbError} />
              <span class="cc-dur">{formatDuration(v.lengthSeconds)}</span>
            </div>
            <span class="cc-name">{v.title || 'Untitled broadcast'}</span>
            <span class="cc-meta">{formatViewers(v.viewCount)} views{#if v.game}<span class="cc-dot">·</span>{v.game}{/if}</span>
            <span class="cc-age">{formatAge(v.createdAt)}</span>
          </button>
        {/each}
      </div>
      {#if hasMoreToShow(archivesVisible, archives.length)}
        <button type="button" class="cc-more" onclick={() => (archivesVisible = revealMore(archivesVisible, archives.length))}>Load more</button>
      {/if}
    {/if}
  </section>

  <!-- Highlights -->
  <section class="cc-section">
    <h2 class="cc-title">Highlights</h2>
    {#if hStatus === 'loading'}
      <div class="cc-status">Loading highlights…</div>
    {:else if hStatus === 'error'}
      <div class="cc-status cc-status--error">
        Failed to load highlights.
        <button type="button" class="cc-retry" onclick={retryAll}>Retry</button>
      </div>
    {:else if hStatus === 'ready' && highlights.length === 0}
      <div class="cc-status">No highlights.</div>
    {:else if hStatus === 'ready'}
      <div class="cc-grid">
        {#each highlights.slice(0, highlightsVisible) as v (v.id)}
          <button type="button" class="cc-card" onclick={() => onplayVod(v)}>
            <div class="cc-thumb">
              <img src={v.thumbnailUrl || ''} alt="" width="320" height="180" loading="lazy" onerror={onThumbError} />
              <span class="cc-dur">{formatDuration(v.lengthSeconds)}</span>
            </div>
            <span class="cc-name">{v.title || 'Untitled highlight'}</span>
            <span class="cc-meta">{formatViewers(v.viewCount)} views{#if v.game}<span class="cc-dot">·</span>{v.game}{/if}</span>
            <span class="cc-age">{formatAge(v.createdAt)}</span>
          </button>
        {/each}
      </div>
      {#if hasMoreToShow(highlightsVisible, highlights.length)}
        <button type="button" class="cc-more" onclick={() => (highlightsVisible = revealMore(highlightsVisible, highlights.length))}>Load more</button>
      {/if}
    {/if}
  </section>

  <!-- Recent Clips -->
  <section class="cc-section">
    <h2 class="cc-title">Recent Clips</h2>
    {#if rcStatus === 'loading'}
      <div class="cc-status">Loading recent clips…</div>
    {:else if rcStatus === 'error'}
      <div class="cc-status cc-status--error">
        Failed to load recent clips.
        <button type="button" class="cc-retry" onclick={retryAll}>Retry</button>
      </div>
    {:else if rcStatus === 'ready' && recentClips.length === 0}
      <div class="cc-status">No recent clips.</div>
    {:else if rcStatus === 'ready'}
      <div class="cc-grid">
        {#each recentClips.slice(0, recentClipsVisible) as c (c.id)}
          <button type="button" class="cc-card" onclick={() => onplayClip(c)}>
            <div class="cc-thumb">
              <img src={c.thumbnailUrl || ''} alt="" width="320" height="180" loading="lazy" onerror={onThumbError} />
              <span class="cc-dur">{formatDuration(c.durationSeconds)}</span>
            </div>
            <span class="cc-name">{c.title || 'Untitled clip'}</span>
            <span class="cc-meta">{formatViewers(c.viewCount)} views{#if c.game}<span class="cc-dot">·</span>{c.game}{/if}</span>
            <span class="cc-age">{#if c.curator}{c.curator}<span class="cc-dot">·</span>{/if}{formatAge(c.createdAt)}</span>
          </button>
        {/each}
      </div>
      {#if hasMoreToShow(recentClipsVisible, recentClips.length)}
        <button type="button" class="cc-more" onclick={() => (recentClipsVisible = revealMore(recentClipsVisible, recentClips.length))}>Load more</button>
      {/if}
    {/if}
  </section>

  <!-- Popular Clips -->
  <section class="cc-section">
    <h2 class="cc-title">Popular Clips</h2>
    {#if pcStatus === 'loading'}
      <div class="cc-status">Loading popular clips…</div>
    {:else if pcStatus === 'error'}
      <div class="cc-status cc-status--error">
        Failed to load popular clips.
        <button type="button" class="cc-retry" onclick={retryAll}>Retry</button>
      </div>
    {:else if pcStatus === 'ready' && popularClips.length === 0}
      <div class="cc-status">No popular clips.</div>
    {:else if pcStatus === 'ready'}
      <div class="cc-grid">
        {#each popularClips.slice(0, popularClipsVisible) as c (c.id)}
          <button type="button" class="cc-card" onclick={() => onplayClip(c)}>
            <div class="cc-thumb">
              <img src={c.thumbnailUrl || ''} alt="" width="320" height="180" loading="lazy" onerror={onThumbError} />
              <span class="cc-dur">{formatDuration(c.durationSeconds)}</span>
            </div>
            <span class="cc-name">{c.title || 'Untitled clip'}</span>
            <span class="cc-meta">{formatViewers(c.viewCount)} views{#if c.game}<span class="cc-dot">·</span>{c.game}{/if}</span>
            <span class="cc-age">{#if c.curator}{c.curator}<span class="cc-dot">·</span>{/if}{formatAge(c.createdAt)}</span>
          </button>
        {/each}
      </div>
      {#if hasMoreToShow(popularClipsVisible, popularClips.length)}
        <button type="button" class="cc-more" onclick={() => (popularClipsVisible = revealMore(popularClipsVisible, popularClips.length))}>Load more</button>
      {/if}
    {/if}
  </section>
</div>

<style>
  .channel-content {
    display: flex;
    flex-direction: column;
    gap: 24px;
    padding: 14px 16px 32px;
    background: var(--bg-app);
  }

  .cc-section {
    display: flex;
    flex-direction: column;
    gap: 10px;
  }

  .cc-title {
    font-size: 12px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: var(--text-secondary);
    margin: 0;
  }

  .cc-status {
    padding: 12px;
    font-size: 13px;
    color: var(--text-dim);
    text-align: center;
  }

  .cc-status--error {
    color: var(--live);
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 8px;
  }

  .cc-retry {
    border: 1px solid var(--border);
    border-radius: 4px;
    background: var(--bg-input);
    color: var(--text-primary);
    font-size: 12px;
    padding: 2px 8px;
    cursor: pointer;
  }

  .cc-retry:hover {
    background: var(--bg-hover);
  }

  .cc-grid {
    display: grid;
    gap: 12px;
    grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
  }

  .cc-card {
    display: flex;
    flex-direction: column;
    gap: 4px;
    padding: 0;
    border: none;
    background: transparent;
    color: var(--text-primary);
    text-align: left;
    cursor: pointer;
    min-width: 0;
  }

  .cc-thumb {
    position: relative;
    width: 100%;
    aspect-ratio: 16 / 9;
    background: var(--bg-input);
    border-radius: 6px;
    overflow: hidden;
    margin-bottom: 4px;
  }

  .cc-thumb img {
    width: 100%;
    height: 100%;
    object-fit: cover;
    display: block;
  }

  .cc-dur {
    position: absolute;
    bottom: 6px;
    right: 6px;
    font-size: 11px;
    font-weight: 600;
    color: #fff;
    background: rgba(0, 0, 0, 0.75);
    border-radius: 3px;
    padding: 1px 5px;
    font-variant-numeric: tabular-nums;
  }

  .cc-name {
    font-size: 13px;
    font-weight: 600;
    color: var(--text-primary);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .cc-card:hover .cc-name {
    color: var(--accent);
  }

  .cc-meta {
    font-size: 12px;
    color: var(--text-secondary);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    display: flex;
    align-items: center;
    gap: 6px;
  }

  .cc-age {
    font-size: 11px;
    color: var(--text-dim);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    display: flex;
    align-items: center;
    gap: 6px;
  }

  .cc-dot {
    color: var(--text-dim);
  }

  .cc-more {
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

  .cc-more:hover {
    background: var(--bg-hover);
  }
</style>
