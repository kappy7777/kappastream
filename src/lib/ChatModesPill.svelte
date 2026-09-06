<script lang="ts">
  // The floating chat-mode pill (Toggle B), shared by the single-stream chat
  // (App.svelte) and the multi-view chat pane (MultiView.svelte) — one
  // implementation so the two can never drift.
  //
  // Shape: ONE non-wrapping line, a leading info symbol, plain
  // comma-separated labels (no parenthesized thresholds — twitch.tv shows
  // plain labels). When the labels don't fit the pill's max width they GLIDE
  // back and forth inside a clipped window (an alternating marquee with a
  // dwell at each end), so every active mode is eventually readable — the
  // pill itself never grows, wraps, or changes height. `maxWidth` lets the
  // single-stream pill keep clear of the open-on-Twitch pill that shares its
  // row (the default symmetric margin is what the multi-view pane wants).
  import { t } from './i18n/index.svelte'
  import { tooltip } from './tooltip'
  import { ROOM_MODE_LABEL_KEYS, type RoomModeKey } from './irc'

  let {
    modes,
    label = '',
    maxWidth = 'calc(100% - 20px)',
  }: {
    /** Active modes in display order (activeRoomModes() in irc.ts). */
    modes: RoomModeKey[]
    /** Accessible name for the pill; the leading icon also carries it as a hover tooltip. */
    label?: string
    /** The pill's max-width CSS value — see the header comment. */
    maxWidth?: string
  } = $props()

  // Marquee driver. The WINDOW is the clipped flex item between the fixed
  // icon and the pill's right edge; the TRACK holds the nowrap label
  // sequence. ResizeObserver on both re-measures whenever the label
  // sequence (mode set / locale) or the pane width changes. When the labels
  // fit, no animation runs at all — the pill renders as a static one-liner.
  // The glide duration scales with the overflow distance (~25px/s, 8s floor)
  // so a long list moves at the same readable speed as a short one.
  let windowEl = $state<HTMLSpanElement | null>(null)
  let trackEl = $state<HTMLSpanElement | null>(null)
  let marquee = $state(false)
  let marqueeShift = $state('0px')
  let marqueeDuration = $state('0s')

  $effect(() => {
    const win = windowEl
    const track = trackEl
    if (!win || !track) return
    const measure = () => {
      const overflow = track.scrollWidth - win.clientWidth
      marquee = overflow > 1
      if (marquee) {
        marqueeShift = `${-overflow}px`
        marqueeDuration = `${Math.max(8, overflow / 25).toFixed(1)}s`
      }
    }
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(win)
    ro.observe(track)
    return () => ro.disconnect()
  })
</script>

<div class="chat-modes" role="status" aria-label={label || undefined} style:max-width={maxWidth}>
  <span class="chat-modes-icon" use:tooltip={label}>
    <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">
      <circle cx="8" cy="8" r="6.5" fill="none" stroke="currentColor" stroke-width="1.4"/>
      <path d="M8 7.4v3.6" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/>
      <circle cx="8" cy="4.9" r="0.95" fill="currentColor"/>
    </svg>
  </span>
  <span class="chat-modes-window" bind:this={windowEl}>
    <span
      class="chat-modes-track"
      class:chat-modes-track--marquee={marquee}
      style:--marquee-shift={marqueeShift}
      style:--marquee-duration={marqueeDuration}
      bind:this={trackEl}
    >
      {#each modes as mode, i (mode)}
        <span class="mode-pill">{t(ROOM_MODE_LABEL_KEYS[mode])}{#if i < modes.length - 1},{/if}</span>
      {/each}
    </span>
  </span>
</div>

<style>
  /* Floating pill over the chat (mirrors the jump-to-bottom button):
     centered at the bottom edge, rounded, translucent blur background.
     One non-wrapping line — an overflowing label sequence marquee-scrolls
     inside .chat-modes-window instead of wrapping or growing the pill. */
  .chat-modes {
    position: absolute;
    bottom: 10px;
    left: 50%;
    transform: translateX(-50%);
    z-index: 5;
    display: flex;
    flex-wrap: nowrap;
    align-items: center;
    gap: 4px;
    padding: 4px 10px;
    border: 1px solid var(--border);
    border-radius: 999px;
    background: var(--bg-overlay-strong);
    -webkit-backdrop-filter: blur(6px);
    backdrop-filter: blur(6px);
    box-shadow: 0 4px 12px rgba(0, 0, 0, 0.45);
    overflow: hidden;
  }

  .chat-modes-icon {
    flex: 0 0 auto;
    display: inline-flex;
    color: var(--text-dim);
  }

  /* The clipped marquee window. min-width:0 lets this flex item shrink when
     the pill reaches its max-width; the nowrap track then overflows THIS
     element (measured for the glide distance), not the pill. */
  .chat-modes-window {
    flex: 0 1 auto;
    min-width: 0;
    overflow: hidden;
    display: inline-flex;
  }

  .chat-modes-track {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    white-space: nowrap;
  }
  .chat-modes-track--marquee {
    animation: chat-modes-marquee var(--marquee-duration, 12s) ease-in-out infinite alternate;
  }
  /* Glide with dwells: rest at the left end, travel, rest at the right end —
     `alternate` then plays the same journey backwards, so the label list is
     stationary and readable at BOTH extremes. */
  @keyframes chat-modes-marquee {
    0%, 10% { transform: translateX(0); }
    90%, 100% { transform: translateX(var(--marquee-shift, 0px)); }
  }
  @media (prefers-reduced-motion: reduce) {
    .chat-modes-track--marquee { animation: none; }
  }

  /* Plain text labels — no per-mode chip background/border; the floating
     Gesamtbox (the pill itself) provides the only background. */
  .mode-pill {
    font-size: 10px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: var(--accent);
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
  }
</style>
