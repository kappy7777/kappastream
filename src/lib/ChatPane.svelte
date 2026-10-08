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
  // pane-specific AROUND it, anchored to their own positioned container
  // (App's `.chat` / MultiView's `.mv-chat-body`): layout chrome in flow
  // (App's resizer, MultiView's tab strip) and absolutely-positioned overlays
  // (the pinned-message banner, the chat-mode pill, the open-on-Twitch pill).
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

  import { tick, untrack } from 'svelte'
  import type { Snippet } from 'svelte'
  import LinkifiedText from './LinkifiedText.svelte'
  import {
    resolveBadgeImageUrl,
    isMessageStricken,
    usernoticeCategory,
    isNoticeVisible,
    DELETED_MESSAGE_CLASS,
  } from './irc'
  import { parseColorToken } from './custom-themes.svelte'
  import { compositeOver, readableNameColor } from './name-color'
  import { newChatEntryCount, type ChatEntry } from './merged-chat'
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
    /**
     * Fired whenever the follow state flips (following the bottom vs scrolled
     * up). Callers forward it to the rendered chat buffer so its front-trim is
     * HELD while the user reads history — the WebKit engines have no scroll
     * anchoring, so every front-trimmed line would slide the visible text up
     * one row (a busy channel moves it ~10 rows/s).
     */
    onfollow?: (following: boolean) => void
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
    onfollow,
    liftJump = false,
    padding = '8px 10px',
    attribution,
  }: Props = $props()

  // Whether a stored USERNOTICE line renders under the five granular notice
  // toggles (unknown msg-ids show when any of the five is on).
  function noticeShown(msgId: string | null): boolean {
    return isNoticeVisible(usernoticeCategory(msgId ?? ''), {
      sub: settings.chatNoticesSub,
      gift: settings.chatNoticesGift,
      raid: settings.chatNoticesRaid,
      announcement: settings.chatNoticesAnnouncement,
      streak: settings.chatNoticesStreak,
    })
  }

  // ---- sticky-bottom discipline (shared by both views) ----
  let chatEl = $state<HTMLElement | undefined>(undefined)
  let stickyBottom = $state(true)
  let newMessageCount = $state(0)
  // Last entry key already ACCOUNTED FOR as seen. It advances on every
  // bottom snap, jump, and at-bottom scroll (the user is looking at the
  // newest entry), and — while the pane is NOT following — the arrival
  // counter itself advances it per counted message (each unseen message is
  // accounted exactly once). Detaching must NOT touch it: messages that
  // arrived during the scroll grace were counted unseen, and re-baselining
  // at detach would erase them from the pill. The count keys off this
  // instead of the buffer LENGTH — the buffer is capped at 500, so past
  // the cap the length freezes and a length difference would report
  // nothing new ever again.
  let scrollBaselineKey: string | null = null
  const SCROLL_BOTTOM_THRESHOLD = 32

  // A scroll gesture is user intent: while one runs (plus a short grace
  // after the last tick), the follow effect below must NOT snap to the
  // bottom. WebKitGTK ANIMATES wheel scrolls, and assigning scrollTop
  // mid-animation cancels it — in a busy merged chat a message arrives
  // between wheel ticks, every snap killed the in-flight scroll, and the
  // user could never reach the 32px from the bottom that disengages the
  // follow in the first place. Only an UPWARD gesture needs the grace: a
  // wheel-down at the bottom scrolls nothing (and Ctrl+wheel is the
  // browser zoom), so arming on every wheel event let a harmless wheel-
  // down strand the next message below the fold until another arrived.
  let userScrollUntil = 0
  let graceTimer: ReturnType<typeof setTimeout> | null = null
  const USER_SCROLL_GRACE_MS = 350

  function armScrollGrace(): void {
    userScrollUntil = performance.now() + USER_SCROLL_GRACE_MS
    // One deferred re-check when the grace ends: a message that arrived
    // inside the window left the still-following pane off the bottom, and
    // in a quiet chat the next message (and with it the next snap) can be
    // minutes away. Idempotent — re-arming just pushes the check back.
    if (graceTimer) clearTimeout(graceTimer)
    graceTimer = setTimeout(() => {
      graceTimer = null
      const el = chatEl
      if (!el) return
      if (stickyBottom && performance.now() >= userScrollUntil) {
        snapToBottom(el)
      }
    }, USER_SCROLL_GRACE_MS)
  }

  function onChatWheel(e: WheelEvent): void {
    if (e.ctrlKey || e.deltaY >= 0) return
    armScrollGrace()
  }

  // Keyboard scrolls need the grace for the same reason (a snap mid-scroll
  // cancels the animated scroll on WebKitGTK). The container is click-
  // focusable (tabindex -1: no tab stop) so PageUp/Home actually reach it.
  const SCROLL_KEYS: ReadonlySet<string> = new Set(['PageUp', 'PageDown', 'Home', 'End', 'ArrowUp', 'ArrowDown'])

  function onChatKeyDown(e: KeyboardEvent): void {
    if (SCROLL_KEYS.has(e.key)) armScrollGrace()
  }

  function lastKeyOf(list: ChatEntry[]): string | null {
    return list.length > 0 ? list[list.length - 1]!.key : null
  }

  // Force the view to the bottom and mark everything seen. Every path that
  // puts the newest message on screen (message-arrival follow, grace-end
  // re-check, resize re-fit, the jump pill) goes through here, so the
  // unseen count can never disagree with what the user is looking at.
  function snapToBottom(el: HTMLElement): void {
    el.scrollTop = el.scrollHeight
    newMessageCount = 0
    scrollBaselineKey = lastKeyOf(entries)
  }

  function onChatScroll(): void {
    const el = chatEl
    if (!el) return
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight
    stickyBottom = distanceFromBottom <= SCROLL_BOTTOM_THRESHOLD
    if (stickyBottom) {
      // Arriving at the bottom by scrolling is seeing everything.
      newMessageCount = 0
      scrollBaselineKey = lastKeyOf(entries)
    }
    // Detaching is deliberately a no-op here: the baseline and count
    // already hold whatever arrived unseen (through the grace), and
    // resetting them is exactly the undercount this must not do.
  }

  function jumpToPresent(): void {
    if (chatEl) {
      snapToBottom(chatEl)
      stickyBottom = true
    }
  }

  // Follow the bottom as entries arrive (after the DOM update): stick while at
  // the bottom, otherwise just count what was added.
  $effect(() => {
    const len = entries.length
    void len
    void tick().then(() => {
      if (!chatEl) return
      if (stickyBottom && performance.now() >= userScrollUntil) {
        snapToBottom(chatEl)
      } else {
        const added = newChatEntryCount(entries, scrollBaselineKey)
        if (added > 0) newMessageCount += added
        scrollBaselineKey = lastKeyOf(entries)
      }
    })
  })

  // A resize re-fits the bottom: while following, a smaller pane (window
  // resize, chat-width drag, splitter move) leaves the last messages below
  // the fold — clientHeight shrank without any scroll event to re-check, so
  // nothing would snap until the next message arrived.
  $effect(() => {
    const el = chatEl
    if (!el || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(() => {
      if (stickyBottom && performance.now() >= userScrollUntil) {
        snapToBottom(el)
      }
    })
    ro.observe(el)
    return () => ro.disconnect()
  })

  $effect(() => {
    return () => {
      if (graceTimer) clearTimeout(graceTimer)
    }
  })

  // A resetKey change swaps the rendered buffer wholesale (channel change, chat
  // tab switch, merged-view toggle) — resume following from the new bottom.
  $effect(() => {
    void resetKey
    stickyBottom = true
    newMessageCount = 0
    scrollBaselineKey = null
  })

  // Report follow-state flips so the rendered buffer can hold its front-trim
  // while the user reads history (see the onfollow prop). The callback runs
  // untracked: it writes caller state this effect must not depend on.
  $effect(() => {
    const following = stickyBottom
    untrack(() => onfollow?.(following))
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

  // ---- readable username colours ----
  // Usernames paint with the colour the user picked (or the deterministic
  // default irc.ts substitutes for an empty tag), adjusted at RENDER time so
  // the name keeps its hue but reaches WCAG AA contrast (4.5:1) against the
  // chat background of the ACTIVE theme. The background is measured from the
  // computed --bg-panel whenever the theme changes (custom themes write the
  // same property), composited over --bg-app when the panel colour is
  // translucent. The #18181b seed is the dark-panel fallback until the first
  // measurement lands.
  let chatBg = $state('#18181b')
  $effect(() => {
    // themeRev, not theme: re-saving the ACTIVE custom theme keeps the id,
    // and the equal id write would never re-measure the background.
    void settings.themeRev
    const cs = getComputedStyle(document.documentElement)
    const panel = parseColorToken(cs.getPropertyValue('--bg-panel'))
    if (!panel) return
    let c: { r: number; g: number; b: number }
    if (panel.a >= 1) {
      c = { r: panel.r, g: panel.g, b: panel.b }
    } else {
      const app = parseColorToken(cs.getPropertyValue('--bg-app')) ?? { r: 14, g: 14, b: 16, a: 1 }
      c = compositeOver(panel, app)
    }
    chatBg = `rgb(${Math.round(c.r)}, ${Math.round(c.g)}, ${Math.round(c.b)})`
  })

  function nameColor(raw: string): string {
    return readableNameColor(raw, chatBg)
  }
</script>

<!-- The keydown handler only arms the scroll grace around the container's
     OWN native keyboard scrolling — it introduces no new interaction. -->
<!-- svelte-ignore a11y_no_static_element_interactions -->
<div
  class="chat-pane-scroll"
  bind:this={chatEl}
  tabindex="-1"
  onscroll={onChatScroll}
  onwheel={onChatWheel}
  onkeydown={onChatKeyDown}
  style:padding
>
  {#if entries.length === 0}
    <p class="chat-pane-placeholder">{placeholder}</p>
  {:else}
    {#each entries as e (e.key)}
      {@const msg = e.msg}
      {#if msg.kind === 'notice'}
        {#if noticeShown(msg.noticeMsgId) && !settings.isMuted(msg.login)}
          <div class="message message--notice">
            {#if settings.chatTimestamps}<span
                class="message-time"
                use:tooltip={new Date(msg.timestamp).toLocaleString()}>{formatChatTime(msg.timestamp)}</span
              >{/if}
            {#if attribution}{@render attribution(e)}{/if}
            <span class="notice-system">{msg.systemText}</span>
            {#if msg.parts.length > 0}
              <span class="notice-msg"
                >{#each msg.parts as part}{#if part.type === 'text'}<LinkifiedText
                      text={part.text}
                      {onlink}
                    />{:else if erroredEmotes.has(part.url)}<span class="emote-fallback">{part.name}</span>{:else}<img
                      class="emote"
                      class:emote--twitch={part.provider === 'twitch'}
                      src={part.url}
                      alt={part.name}
                      title={part.name}
                      loading="lazy"
                      onerror={() => markEmoteErrored(part.url)}
                    />{/if}{/each}</span
              >
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
            <span class="message-time" use:tooltip={new Date(msg.timestamp).toLocaleString()}
              >{formatChatTime(msg.timestamp)}</span
            >
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
          <span class="username" style="color: {nameColor(msg.color)}">{msg.username}</span>{#if !msg.isAction}<span
              class="username-sep">:</span
            >{/if}
          {#if msg.isAction}<span class="action-mark"> </span>{/if}
          <span class="text"
            >{#each msg.parts as part}{#if part.type === 'text'}<LinkifiedText
                  text={part.text}
                  {onlink}
                />{:else if erroredEmotes.has(part.url)}<span class="emote-fallback">{part.name}</span>{:else}<img
                  class="emote"
                  class:emote--twitch={part.provider === 'twitch'}
                  src={part.url}
                  alt={part.name}
                  title={part.name}
                  loading="lazy"
                  onerror={() => markEmoteErrored(part.url)}
                />{/if}{/each}</span
          >
          {#if settings.chatBits && msg.bits}
            <span class="bits-badge" use:tooltip={t('mod_bits', { n: msg.bits })}>
              <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">
                <path d="M8 1l5 5-5 9-5-9z" fill="currentColor" />
                <path
                  d="M3 6h10M8 1l3 5-3 9-3-9z"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="0.8"
                  stroke-linejoin="round"
                />
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
    <svg
      class="chat-pane-jump-icon"
      viewBox="0 0 16 16"
      width="12"
      height="12"
      aria-hidden="true"
      fill="none"
      stroke="currentColor"
      stroke-width="1.8"
      stroke-linecap="round"
      stroke-linejoin="round"
    >
      <path d="M8 3v9M4 8l4 4 4-4" />
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
    /* No visible scrollbar: WebKitGTK scrollbars are classic and reserve
       layout space, which broke the pane's horizontal symmetry (the message
       block sat a scrollbar-width off center). Scrolling stays fully
       available via wheel/keyboard/touch; the jump pill is the way back
       down. Mirrors .mv-chat-tabs / .video-scroll. */
    scrollbar-width: none;
  }
  .chat-pane-scroll::-webkit-scrollbar {
    display: none;
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
    transition:
      color 150ms,
      background 150ms,
      border-color 150ms,
      transform 150ms;
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
    color: var(--on-accent);
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
