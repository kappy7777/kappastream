<script lang="ts">
  // The pinned-chat-message banner: compact one-line by default, expandable to
  // the full message, dismissable (keyed to the pin id, persisted — see
  // pinned-chat.svelte). Sits at the top of the chat pane in BOTH the
  // single-stream view and the multi-view chat column; themed purely through
  // the existing CSS custom properties, so all 34 built-in themes + custom
  // themes apply with no extra work, and px/em sizing keeps it correct at
  // every uiScale (no viewport units → no --ui-zoom compensation needed).
  //
  // The body is the MESSAGE ITSELF (the "Pinned by …" header already names
  // the moderator; the original sender is deliberately left unmentioned per
  // the owner's direction). It renders through the same renderMessage()
  // pipeline the chat pane uses — same third-party emote map prop, Twitch
  // emote ranges rebuilt from the pin's own fragments — plus the shared
  // twitch-link handling (LinkifiedText): only twitch.tv URLs are
  // interactive, javascript:/data: are impossible to produce, and what a
  // click does is the parent's onlink policy (in-app clip playback in the
  // single-stream view, the twitch page otherwise). The pin text is remote,
  // moderator-chosen content: text nodes and <img src> only, never injected
  // as raw HTML (pinned-chat.test.ts guards that repo-wide).

  import { renderMessage, type Emote } from './emotes'
  import { t } from './i18n/index.svelte'
  import LinkifiedText from './LinkifiedText.svelte'
  import type { PinnedChatPin } from './pinned-chat.svelte'
  import { tooltip } from './tooltip.ts'

  let {
    pin,
    thirdParty,
    onlink,
    ondismiss,
  }: {
    pin: PinnedChatPin
    thirdParty: Map<string, Emote>
    onlink: (url: string) => void
    ondismiss: (pinId: string) => void
  } = $props()

  let expanded = $state(false)
  let erroredEmotes = $state<Set<string>>(new Set())

  function markEmoteErrored(url: string): void {
    if (erroredEmotes.has(url)) return
    erroredEmotes = new Set(erroredEmotes).add(url)
  }

  // The existing chat render path: same function, same emote map, Twitch
  // ranges from the pin's own fragments. Recomputes when the pin changes or
  // when the (reactive) third-party map gains emotes.
  const parts = $derived(renderMessage({ message: pin.text, thirdParty, twitchRanges: pin.emoteRanges }))
</script>

<section class="pin-banner" aria-label={t('pin_aria')}>
  <div class="pin-head">
    <svg class="pin-icon" viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">
      <path d="M9.5 1L15 6.5l-2 .5-2.5 3 .5 3-2-1.5L4 14l-1-1 2.5-5-1.5-2 3-1L9.5 1z" fill="currentColor" opacity="0.9" transform="rotate(8 8 8)"/>
      <circle cx="10.5" cy="5.5" r="1" fill="currentColor"/>
    </svg>
    <span class="pin-by">{t('pin_pinnedBy', { name: pin.pinnedBy.displayName || pin.pinnedBy.login })}</span>
    <span class="pin-actions">
      <button
        type="button"
        class="pin-btn"
        onclick={() => (expanded = !expanded)}
        aria-expanded={expanded}
        aria-label={expanded ? t('pin_collapse') : t('pin_expand')}
        use:tooltip={expanded ? t('pin_collapse') : t('pin_expand')}
      >
        <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
          {#if expanded}
            <path d="M3 10l5-5 5 5"/>
          {:else}
            <path d="M3 6l5 5 5-5"/>
          {/if}
        </svg>
      </button>
      <button
        type="button"
        class="pin-btn"
        onclick={() => ondismiss(pin.pinId)}
        aria-label={t('pin_dismiss')}
        use:tooltip={t('pin_dismiss')}
      >
        <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round">
          <path d="M4 4l8 8M12 4l-8 8"/>
        </svg>
      </button>
    </span>
  </div>
  <div class="pin-body" class:pin-body--expanded={expanded}>
    {#each parts as part, i (i)}
      {#if part.type === 'text'}
        <LinkifiedText text={part.text} {onlink} />
      {:else if erroredEmotes.has(part.url)}
        <span class="emote-fallback">{part.name}</span>
      {:else}
        <img class="emote" class:emote--twitch={part.provider === 'twitch'} src={part.url} alt={part.name} title={part.name} loading="lazy" onerror={() => markEmoteErrored(part.url)} />
      {/if}
    {/each}
  </div>
</section>

<style>
  .pin-banner {
    flex: 0 0 auto;
    display: flex;
    flex-direction: column;
    gap: 2px;
    padding: 5px 8px;
    border-bottom: 1px solid var(--border);
    background: var(--bg-panel);
    min-width: 0;
  }

  .pin-head {
    display: flex;
    align-items: center;
    gap: 5px;
    min-width: 0;
  }
  .pin-icon { flex: 0 0 auto; color: var(--accent); }
  .pin-by {
    flex: 1 1 auto;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--text-secondary);
    font-size: 11px;
    font-weight: 600;
  }
  .pin-actions { display: inline-flex; gap: 2px; flex: 0 0 auto; }
  .pin-btn {
    width: 20px;
    height: 20px;
    padding: 0;
    border: none;
    border-radius: 4px;
    background: transparent;
    color: var(--text-secondary);
    cursor: pointer;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    transition: background 120ms ease, color 120ms ease;
  }
  .pin-btn:hover { background: var(--bg-hover); color: var(--text-primary); }
  .pin-btn:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }

  .pin-body {
    display: block;
    min-width: 0;
    line-height: 1.4;
    font-size: 13px;
    word-wrap: break-word;
    color: var(--text-primary);
    /* Compact by default: exactly one truncated line (mirrors Twitch). */
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
  }
  .pin-body--expanded {
    white-space: normal;
    text-overflow: clip;
    /* Expanded still cannot push chat off screen: px cap (zoom-safe — no
       viewport units, so no --ui-zoom compensation needed). */
    max-height: 300px;
    overflow-y: auto;
  }

  .emote { vertical-align: middle; }
  .emote-fallback { color: var(--text-primary); }
</style>
