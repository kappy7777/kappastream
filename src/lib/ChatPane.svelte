<script lang="ts">
  // The shared chat pane: the scroll-following message list used by BOTH the
  // single-stream chat (App.svelte) and the multi-view chat (MultiView.svelte).
  // This is the ONE place the chat renderer exists — before it, App.svelte and
  // MultiView.svelte carried near-identical copies of the message loop, the
  // sticky-bottom discipline and the errored badge/emote tracking, and every
  // chat feature had to be edited twice.
  //
  // Owns: the scroll container, the notice + message branches, the auto-follow
  // logic (follow while at bottom, count new messages while scrolled up, the
  // "back to bottom" pill), and the errored-art sets. Callers keep everything
  // pane-specific AROUND it as absolutely-positioned overlays anchored to their
  // own positioned container (App's `.chat` / MultiView's `.mv-chat-body`): the
  // pinned-message banner, the chat-mode pill, the tab strip, the resizer, the
  // open-on-Twitch pill.
  //
  // Input is a ChatEntry[] (merged-chat.ts) rather than a bare ChatMessage[]:
  // the entry carries the per-message badge override (per-channel art) and, in
  // the merged view, the origin for attribution. Callers showing ONE chat use
  // singleChatEntries() which leaves the attribution fields null.
  //
  // Rendering follows the "ALWAYS parse + store; gate only PRESENTATION" rule:
  // the four Tier-2 toggles (notice groups / roomstate / moderation / bits) and
  // the mute list are read from `settings` at RENDER time, so flipping any of
  // them retroactively re-evaluates already-buffered messages.

  import { tick } from 'svelte'
  import type { Snippet } from 'svelte'
  import LinkifiedText from './LinkifiedText.svelte'
  import { resolveBadgeImageUrl, isMessageStricken, usernoticeCategory, isNoticeVisible, DELETED_MESSAGE_CLASS } from './irc'
  import type { ChatEntry } from './merged-chat'
  import { settings } from './settings.svelte.ts'
  import { formatCompact, formatChatTime } from './format'
  import { tooltip } from './tooltip.ts'
  import { t } from './i18n/index.svelte'

  interface Props {
    /** What the pane renders (merged or single view model). */
    entries: ChatEntry[]
    /** Shown while entries is empty (caller composes the exact state text). */
    placeholder: string
    /** A twitch link was clicked (clip links, opener). */
    onlink: (url: string) => void
    /** Changing this value resets the follow state (new channel / tab switch /
     *  merged-view toggle / chat going idle) — the caller defines the key. */
    resetKey: string | number
    /** Lift the jump pill above the caller's floating chat-mode pill. */
    liftJump?: boolean
    /** Scroll-container padding — App uses the default, MultiView is tighter. */
    padding?: string
    /** Per-message source mark (merged-view avatar). Null in single-chat panes. */
    attribution?: Snippet<[ChatEntry]>
  }

  const {
    entries,
    placeholder,
    onlink,
    resetKey,
    liftJump = false,
    padding = '8px 10px',
    attribution,
  }: Props = $props()

  // Whether a stored USERNOTICE line renders under the four granular notice
  // toggles (unknown msg-ids show when any of the four is on).
  function noticeShown(msgId: string | null): boolean {
    return isNoticeVisible(usernoticeCategory(msgId ?? ''), {
      sub: settings.chatNoticesSub,
      gift: settings.chatNoticesGift,
      raid: settings.chatNoticesRaid,
      announcement: settings.chatNoticesAnnouncement,
    })
  }

  // ---- sticky-bottom discipline (shared by both views) ----
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
    if (stickyBottom) {
      newMessageCount = 0
      scrollBaseline = entries.length
    } else if (wasSticky && !stickyBottom) {
      scrollBaseline = entries.length
      newMessageCount = 0
    }
  }

  function jumpToPresent(): void {
    if (chatEl) {
      chatEl.scrollTop = chatEl.scrollHeight
      stickyBottom = true
      newMessageCount = 0
      scrollBaseline = entries.length
    }
  }

  // Follow the bottom as entries arrive (after the DOM update): stick while at
  // the bottom, otherwise just count what was added.
  $effect(() => {
    const len = entries.length
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

  // A resetKey change swaps the rendered buffer wholesale (channel change, chat
  // tab switch, merged-view toggle) — resume following from the new bottom.
  $effect(() => {
    void resetKey
    stickyBottom = true
    newMessageCount = 0
    scrollBaseline = 0
  })

  // ---- errored-art tracking ----
  // A failed badge/emote URL is hidden and remembered so it does not flicker a
  // broken-image icon on every re-render. Copy-on-write Sets so $state notices.
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
</script>

<div class="chat-pane-scroll" bind:this={chatEl} onscroll={onChatScroll} style:padding>
  {#if entries.length === 0}
    <p class="chat-pane-placeholder">{placeholder}</p>
  {:else}
    {#each entries as e (e.key)}
      {@const msg = e.msg}
      {#if msg.kind === 'notice'}
        {#if noticeShown(msg.noticeMsgId) && !settings.isMuted(msg.login)}
          <div class="message message--notice">
            {#if settings.chatTimestamps}<span class="message-time" use:tooltip={new Date(msg.timestamp).toLocaleString()}>{formatChatTime(msg.timestamp)}</span>{/if}
            {#if attribution}{@render attribution(e)}{/if}
            <span class="notice-system">{msg.systemText}</span>
            {#if msg.parts.length > 0}
              <span class="notice-msg">{#each msg.parts as part}{#if part.type === 'text'}<LinkifiedText text={part.text} {onlink} />{:else if erroredEmotes.has(part.url)}<span class="emote-fallback">{part.name}</span>{:else}<img
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
      {:else if !settings.isMuted(msg.login)}
        <div
          class="message{isMessageStricken(settings.chatModeration, msg.deleted) ? ' ' + DELETED_MESSAGE_CLASS : ''}"
          class:action={msg.isAction}
          class:emote-only={msg.emoteOnly && !msg.isAction}
          title={isMessageStricken(settings.chatModeration, msg.deleted) ? (msg.deletedReason ?? '') : ''}
        >
          {#if settings.chatTimestamps}
            <span class="message-time" use:tooltip={new Date(msg.timestamp).toLocaleString()}>{formatChatTime(msg.timestamp)}</span>
          {/if}
          {#if attribution}{@render attribution(e)}{/if}
          {#each msg.badges as b (b.id + b.version)}
            {@const effUrl = resolveBadgeImageUrl(b, e.override)}
            {#if effUrl && !erroredBadges.has(effUrl)}
              <img
                class="badge badge--{b.id}"
                src={effUrl}
                alt={b.label}
                use:tooltip={b.label}
                loading="lazy"
                onerror={() => markBadgeErrored(effUrl!)}
              />
            {/if}
          {/each}
          <span class="username" style="color: {msg.color}">{msg.username}</span>{#if !msg.isAction}<span class="username-sep">:</span>{/if}
          {#if msg.isAction}<span class="action-mark"> </span>{/if}
          <span class="text">{#each msg.parts as part}{#if part.type === 'text'}<LinkifiedText text={part.text} {onlink} />{:else if erroredEmotes.has(part.url)}<span class="emote-fallback">{part.name}</span>{:else}<img
            class="emote"
            class:emote--twitch={part.provider === 'twitch'}
            src={part.url}
            alt={part.name}
            title={part.name}
            loading="lazy"
            onerror={() => markEmoteErrored(part.url)}
          />{/if}{/each}</span>
          {#if settings.chatBits && msg.bits}
            <span class="bits-badge" use:tooltip={t('mod_bits', { n: msg.bits })}>
              <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">
                <path d="M8 1l5 5-5 9-5-9z" fill="currentColor"/>
                <path d="M3 6h10M8 1l3 5-3 9-3-9z" fill="none" stroke="currentColor" stroke-width="0.8" stroke-linejoin="round"/>
              </svg>
              {formatCompact(msg.bits)}
            </span>
          {/if}
        </div>
      {/if}
    {/each}
  {/if}
</div>

{#if !stickyBottom && entries.length > 0}
  <button
    type="button"
    class="chat-pane-jump"
    class:chat-pane-jump--lifted={liftJump}
    onclick={jumpToPresent}
    title={t('chat_jumpToLatest')}
  >
    <svg class="chat-pane-jump-icon" viewBox="0 0 16 16" width="12" height="12" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
      <path d="M8 3v9M4 8l4 4 4-4"/>
    </svg>
    {t('chat_backToBottom')}
    {#if newMessageCount > 0}
      <span class="chat-pane-jump-count">{newMessageCount}</span>
    {/if}
  </button>
{/if}

<style>
  .chat-pane-scroll {
    flex: 1 1 auto;
    overflow-y: auto;
    overflow-x: hidden;
    min-height: 0;
  }

  .chat-pane-placeholder {
    text-align: center;
    color: var(--text-dim);
    margin-top: 40px;
    font-size: 13px;
  }

  /* "Back to bottom" pill — absolutely positioned against the CALLER's
     positioned container (App's .chat / MultiView's .mv-chat-body), exactly
     where each view's own jump button used to sit. */
  .chat-pane-jump {
    position: absolute;
    bottom: 10px;
    left: 50%;
    transform: translateX(-50%);
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
    color: var(--text-secondary);
    font-size: 11px;
    font-weight: 600;
    font-family: inherit;
    cursor: pointer;
    box-shadow: 0 4px 12px rgba(0, 0, 0, 0.45);
    transition: color 150ms, background 150ms, border-color 150ms, transform 150ms;
    white-space: nowrap;
  }

  .chat-pane-jump:hover {
    color: var(--accent);
    background: var(--bg-hover);
    border-color: var(--accent);
    transform: translateX(-50%) translateY(-1px);
  }

  /* Lifted above the caller's floating chat-mode pill (a fixed-height
     one-liner — ChatModesPill marquees overflowing labels instead of
     wrapping — so a constant lift is correct). */
  .chat-pane-jump--lifted {
    bottom: 48px;
  }

  .chat-pane-jump-count {
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

  /* ---- message rendering (moved from App.svelte / MultiView.svelte, which
     carried near-identical copies; theme tokens only) ---- */

  .message {
    margin: 1px 0;
    padding: 2px 0;
    line-height: 1.4;
    word-wrap: break-word;
    font-size: 13px;
  }

  .message-time {
    color: var(--text-dim);
    font-size: 11px;
    font-weight: 500;
    font-variant-numeric: tabular-nums;
    margin-right: 4px;
    flex: 0 0 auto;
  }

  .username {
    font-weight: 700;
    margin-right: 4px;
  }

  .username-sep {
    color: var(--text-primary);
    margin-right: 4px;
  }

  .text {
    color: var(--text-primary);
  }

  .action {
    color: var(--accent);
  }

  .action-mark {
    color: var(--accent);
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

  /* Fallback span rendered in place of an emote <img> whose URL failed to
     load — mirrors the erroredBadges pattern so a broken image is
     distinguishable from a lookup miss (the alt text would otherwise look
     identical to plain chat text). */
  .emote-fallback {
    color: var(--text-primary);
  }

  /* Deleted / timed-out message presentation (Toggle C). This single rule is
     the source of truth for how a stricken message looks — the class is added
     via isMessageStricken() + DELETED_MESSAGE_CLASS. Tradeoff: strikethrough
     keeps the moderator-removed text VISIBLE. */
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
</style>
