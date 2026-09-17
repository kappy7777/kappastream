<script lang="ts">
  // The scrollable per-version release log — every recorded release, newest
  // first. Shared by the post-update what's-new screen (inside
  // WelcomeOverlay's fixed-height modal) and the Settings changelog section
  // (inside the content-height settings modal); each parent owns whether and
  // where the log scrolls via its own container, this component just sizes to
  // its content (flex:1 + overflow-y:auto makes it fill/scroll when the
  // parent bounds it). Sections (Added / Changed / Fixed) mirror the
  // CHANGELOG's headings per version; the running version leads, accented.
  import { t } from './i18n/index.svelte'
  import { releaseNotesFor, releaseNoteVersions } from './release-notes'

  const noteVersions = $derived(releaseNoteVersions(__APP_VERSION__))
</script>

<div class="version-log">
  {#if noteVersions.length === 0}
    <p class="version-log-intro">{t('whatsnew_generic')}</p>
  {:else}
    {#each noteVersions as version, idx (version)}
      {@const vn = releaseNotesFor(version)}
      <section class="version-block" class:version-block--first={idx === 0}>
        <h3 class="version-h" class:version-h--latest={version === __APP_VERSION__}>v{version}</h3>
        {#if vn.added && vn.added.length > 0}
          <p class="version-section-h">{t('whatsnew_added')}</p>
          <ul class="version-list">
            {#each vn.added as h (h)}
              <li>{h}</li>
            {/each}
          </ul>
        {/if}
        {#if vn.changed && vn.changed.length > 0}
          <p class="version-section-h">{t('whatsnew_changed')}</p>
          <ul class="version-list">
            {#each vn.changed as h (h)}
              <li>{h}</li>
            {/each}
          </ul>
        {/if}
        {#if vn.fixed && vn.fixed.length > 0}
          <p class="version-section-h">{t('whatsnew_fixed')}</p>
          <ul class="version-list">
            {#each vn.fixed as h (h)}
              <li>{h}</li>
            {/each}
          </ul>
        {/if}
      </section>
    {/each}
  {/if}
</div>

<style>
  /* min-height:0 lets it shrink inside a flex-column parent (without it the
     content height wins and overflows instead of scrolling). */
  .version-log {
    flex: 1 1 auto;
    min-height: 0;
    overflow-y: auto;
    overscroll-behavior: contain;
    display: flex;
    flex-direction: column;
    gap: 14px;
    padding-right: 6px;
  }

  .version-log-intro {
    margin: 0;
    color: var(--text-secondary);
    font-size: 13px;
    line-height: 1.5;
  }

  .version-block {
    display: flex;
    flex-direction: column;
    gap: 6px;
    padding-top: 14px;
    border-top: 1px solid var(--border);
  }
  .version-block--first {
    padding-top: 0;
    border-top: none;
  }
  .version-h {
    margin: 0;
    font-size: 13px;
    font-weight: 700;
    color: var(--text-primary);
  }
  /* The RUNNING version leads the log — accent it so the "what changed in
     THIS update" answer is visually first. */
  .version-h--latest {
    color: var(--accent);
  }
  .version-section-h {
    margin: 0;
    font-size: 12px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: var(--text-secondary);
  }
  .version-list {
    margin: 0;
    padding-left: 18px;
    display: flex;
    flex-direction: column;
    gap: 6px;
    color: var(--text-primary);
    font-size: 13px;
    line-height: 1.5;
  }
</style>
