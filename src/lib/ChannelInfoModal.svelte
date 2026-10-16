<script lang="ts">
  // The channel-info modal (Info button next to Videos in the status bar).
  // Extracted from App.svelte like AboutModal: App owns the open/close state
  // and the Escape path (shortcuts.ts' close-channel-info action), this
  // component owns the CONTENT FETCH — which fires here, on mount, so a
  // channel-info request is made ONLY when the user pressed the button
  // (App mounts the modal on press; nothing polls or pre-fetches).
  import { t, getLocale } from './i18n/index.svelte'
  import { fetchChannelInfo, type ChannelInfo } from './gql'
  import { formatAge, formatCompact } from './format'

  interface Props {
    login: string
    onclose: () => void
  }
  const { login, onclose }: Props = $props()

  let info = $state<ChannelInfo | null>(null)
  let error = $state('')
  let loading = $state(true)
  // Bumped by the Retry button so the fetch effect re-runs on demand.
  let attempt = $state(0)

  $effect(() => {
    const channel = login
    void attempt
    const controller = new AbortController()
    loading = true
    error = ''
    info = null
    fetchChannelInfo(channel, controller.signal).then(
      (result) => {
        info = result
        loading = false
      },
      (err: unknown) => {
        if (controller.signal.aborted) return
        console.warn('[channel-info] fetch failed:', err)
        error = err instanceof Error ? err.message : String(err)
        loading = false
      },
    )
    return () => controller.abort()
  })

  function retry(): void {
    attempt++
  }

  const createdText = $derived.by(() => {
    if (!info?.createdAt) return ''
    const ts = Date.parse(info.createdAt)
    if (!Number.isFinite(ts)) return ''
    return new Intl.DateTimeFormat(getLocale(), { year: 'numeric', month: 'long', day: 'numeric' }).format(new Date(ts))
  })

  // Next scheduled segment in the user's local timezone (the raw startAt is
  // UTC). Empty when the channel has no schedule or no upcoming segment.
  const nextStreamText = $derived.by(() => {
    const seg = info?.schedule?.nextSegment
    if (!seg) return ''
    const ts = Date.parse(seg.startAt)
    if (!Number.isFinite(ts)) return ''
    return new Intl.DateTimeFormat(getLocale(), {
      weekday: 'short',
      day: 'numeric',
      month: 'short',
      hour: '2-digit',
      minute: '2-digit',
    }).format(new Date(ts))
  })
  const nextStreamSub = $derived.by(() => {
    const seg = info?.schedule?.nextSegment
    if (!seg) return ''
    const parts: string[] = []
    if (seg.title) parts.push(seg.title)
    if (seg.category) parts.push(seg.category)
    if (seg.isCancelled) parts.push(t('ci_cancelled'))
    return parts.join(' · ')
  })
  const vacationText = $derived.by(() => {
    if (info?.schedule?.nextSegment) return ''
    const end = info?.schedule?.interruptionEndAt
    if (!end) return ''
    const ts = Date.parse(end)
    if (!Number.isFinite(ts)) return ''
    return t('ci_vacation', {
      date: new Intl.DateTimeFormat(getLocale(), { day: 'numeric', month: 'long' }).format(new Date(ts)),
    })
  })
  // Last-broadcast rows are redundant while live (lastBroadcast IS the
  // running stream), so the block renders for offline channels only.
  const lastLiveAgo = $derived.by(() => {
    if (!info || info.live || !info.lastBroadcast?.startedAt) return ''
    return formatAge(info.lastBroadcast.startedAt)
  })
  const lastLiveSub = $derived.by(() => {
    const last = info?.lastBroadcast
    if (!last || info?.live) return ''
    const parts: string[] = []
    if (last.title) parts.push(last.title)
    if (last.game) parts.push(last.game)
    return parts.join(' · ')
  })
</script>

<div class="ci-backdrop" onclick={onclose} role="presentation"></div>
<div class="ci-modal" role="dialog" aria-modal="true" aria-labelledby="ci-title">
  <button type="button" class="ci-close" onclick={onclose} aria-label={t('close')}>
    <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
      <path d="M3 3l10 10M13 3L3 13" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" />
    </svg>
  </button>

  {#if loading}
    <div class="ci-status">{t('loading')}</div>
  {:else if error}
    <div class="ci-status ci-status--error">{t('ci_error')}</div>
    <button type="button" class="ci-retry" onclick={retry}>{t('ci_retry')}</button>
  {:else if !info}
    <div class="ci-status">{t('ci_notFound')}</div>
  {:else}
    <div class="ci-head">
      {#if info.avatarUrl}
        <img class="ci-avatar" src={info.avatarUrl} alt="" loading="lazy" />
      {/if}
      <div class="ci-names">
        <div id="ci-title" class="ci-name">{info.displayName}</div>
        <div class="ci-login">@{info.login}</div>
      </div>
    </div>
    {#if info.live}
      <div class="ci-live">
        <span class="ci-live-badge"><span class="ci-live-dot"></span>{t('liveBadge')}</span>
        {#if info.game}
          <span class="ci-live-game">{info.game}</span>
        {/if}
        <span class="ci-live-viewers">{formatCompact(info.viewersCount)} {t('viewers')}</span>
      </div>
    {:else}
      <div class="ci-offline">{t('offline')}</div>
    {/if}
    <p class="ci-bio" class:ci-bio--empty={!info.description}>{info.description || t('ci_noBio')}</p>
    {#if nextStreamText}
      <div class="ci-extra">
        <span class="ci-extra-label">{t('ci_nextStream')}</span>
        <div class="ci-extra-main">{nextStreamText}</div>
        {#if nextStreamSub}
          <div class="ci-extra-sub">{nextStreamSub}</div>
        {/if}
      </div>
    {:else if vacationText}
      <div class="ci-extra">
        <span class="ci-extra-label">{t('ci_nextStream')}</span>
        <div class="ci-extra-sub">{vacationText}</div>
      </div>
    {/if}
    {#if lastLiveAgo}
      <div class="ci-extra">
        <span class="ci-extra-label">{t('ci_lastLive')}</span>
        <div class="ci-extra-main">{lastLiveAgo}</div>
        {#if lastLiveSub}
          <div class="ci-extra-sub">{lastLiveSub}</div>
        {/if}
      </div>
    {/if}
    <div class="ci-meta">
      {#if info.followers != null}
        <div class="ci-meta-row">
          <span class="ci-meta-label">{t('si_followers')}</span>
          <span class="ci-meta-value">{formatCompact(info.followers)}</span>
        </div>
      {/if}
      {#if createdText}
        <div class="ci-meta-row">
          <span class="ci-meta-label">{t('ci_created')}</span>
          <span class="ci-meta-value">{createdText}</span>
        </div>
      {/if}
    </div>
  {/if}
</div>

<style>
  .ci-backdrop {
    position: fixed;
    inset: 0;
    background: var(--bg-overlay-strong);
    z-index: 1000;
  }
  .ci-modal {
    position: fixed;
    top: 50%;
    left: 50%;
    transform: translate(-50%, -50%);
    z-index: 1001;
    width: min(440px, calc(100vw / var(--ui-zoom, 1) - 32px));
    max-height: calc(100vh / var(--ui-zoom, 1) - 64px);
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
  .ci-close {
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
  .ci-close:hover {
    background: var(--bg-hover);
    color: var(--text-primary);
  }
  .ci-status {
    font-size: 13px;
    color: var(--text-secondary);
    text-align: center;
    padding: 28px 0;
    animation: ci-pulse 1.2s ease-in-out infinite alternate;
  }
  .ci-status--error {
    color: var(--accent);
    animation: none;
  }
  @keyframes ci-pulse {
    from {
      opacity: 0.55;
    }
    to {
      opacity: 1;
    }
  }
  .ci-retry {
    align-self: center;
    padding: 4px 12px;
    border: 1px solid var(--border);
    border-radius: 4px;
    background: transparent;
    color: var(--text-secondary);
    font-size: 12px;
    font-weight: 600;
    cursor: pointer;
  }
  .ci-retry:hover {
    background: var(--bg-hover);
    color: var(--text-primary);
  }
  .ci-head {
    display: flex;
    align-items: center;
    gap: 14px;
    min-width: 0;
    padding-right: 24px;
  }
  .ci-avatar {
    flex: 0 0 auto;
    width: 64px;
    height: 64px;
    border-radius: 50%;
    border: 1px solid var(--border);
    object-fit: cover;
  }
  .ci-name {
    font-size: 20px;
    font-weight: 700;
    letter-spacing: -0.01em;
    overflow-wrap: anywhere;
  }
  .ci-login {
    font-size: 12px;
    color: var(--text-dim);
    overflow-wrap: anywhere;
  }
  .ci-live {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 8px;
    font-size: 12px;
    color: var(--text-secondary);
  }
  .ci-live-badge {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    background: var(--live);
    color: var(--on-live);
    font-size: 10px;
    font-weight: 700;
    letter-spacing: 0.05em;
    border-radius: 3px;
    padding: 1px 6px;
  }
  .ci-live-dot {
    width: 6px;
    height: 6px;
    background: var(--on-live);
    border-radius: 50%;
  }
  .ci-live-game {
    font-weight: 600;
    color: var(--text-primary);
  }
  .ci-offline {
    font-size: 12px;
    color: var(--text-dim);
  }
  .ci-bio {
    font-size: 13px;
    color: var(--text-secondary);
    line-height: 1.55;
    margin: 0;
    overflow-wrap: anywhere;
    white-space: pre-line;
  }
  .ci-bio--empty {
    color: var(--text-dim);
    font-style: italic;
  }
  .ci-extra {
    display: flex;
    flex-direction: column;
    gap: 3px;
  }
  .ci-extra-label {
    color: var(--text-dim);
    font-size: 11px;
    font-weight: 600;
    letter-spacing: 0.06em;
    text-transform: uppercase;
  }
  .ci-extra-main {
    font-size: 13px;
    color: var(--text-primary);
    font-weight: 600;
  }
  .ci-extra-sub {
    font-size: 12px;
    color: var(--text-secondary);
    line-height: 1.45;
    overflow-wrap: anywhere;
  }
  .ci-meta {
    display: flex;
    flex-direction: column;
    gap: 8px;
    padding-top: 12px;
    margin-top: 2px;
    border-top: 1px solid var(--border);
  }
  .ci-meta-row {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 12px;
    font-size: 12px;
  }
  .ci-meta-label {
    flex: 0 0 auto;
    color: var(--text-dim);
    font-size: 11px;
    font-weight: 600;
    letter-spacing: 0.06em;
    text-transform: uppercase;
  }
  .ci-meta-value {
    color: var(--text-secondary);
    font-weight: 600;
    text-align: right;
    overflow-wrap: anywhere;
  }
</style>
