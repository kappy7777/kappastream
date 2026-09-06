<script lang="ts">
  // Renders one text run, turning twitch.tv URLs into interactive buttons.
  // Shared by the chat message renderer (App.svelte + MultiView.svelte) and
  // the pinned-message banner so all chat text linkifies identically. Only
  // twitch.tv links ever become interactive (see chat-links.ts — that is
  // exactly what the existing open_url_robust validator accepts, and it keeps
  // javascript:/data: URLs impossible); every other URL stays plain text.
  // What a click DOES is caller policy via the onlink prop: the single-stream
  // view plays clips in-app and opens other twitch pages externally, while
  // multi-view (no player of its own) opens the twitch page for everything.

  import { splitTwitchLinks } from './chat-links'

  let { text, onlink }: { text: string; onlink: (url: string) => void } = $props()
</script>

{#each splitTwitchLinks(text) as chunk, i (i)}
  {#if chunk.url}
    <button type="button" class="chat-link" onclick={() => onlink(chunk.url!)}>{chunk.text}</button>
  {:else}
    {chunk.text}
  {/if}
{/each}

<style>
  .chat-link {
    padding: 0;
    border: none;
    background: transparent;
    color: var(--accent);
    font: inherit;
    /* Buttons default to centered text (UA stylesheet); when a long URL
       stretches the button to max-width the content would sit centered in
       the chat line — force the left alignment every other message uses. */
    text-align: left;
    text-decoration: underline;
    cursor: pointer;
    /* Links can be long; never break the chat line layout. */
    max-width: 100%;
    overflow: hidden;
    text-overflow: ellipsis;
    vertical-align: bottom;
  }
  .chat-link:hover { color: var(--accent-hover, var(--accent)); }
  .chat-link:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
</style>
