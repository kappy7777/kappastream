<script lang="ts">
  // Dismissible, non-modal update banner. Rendered once near the top of
  // App.svelte. Driven entirely by `updateStore`. A failed/absent check never
  // shows anything (the store stays `idle`); this component only renders when
  // an update is actually available (or a user-initiated install is in flight).
  import { updateStore, displayUpdateNotes, updateErrorReason } from './update.svelte'
  import { t } from './i18n/index.svelte'

  function fmtBytes(n: number): string {
    if (n <= 0) return '0 B'
    const units = ['B', 'KB', 'MB', 'GB']
    const i = Math.min(units.length - 1, Math.floor(Math.log(n) / Math.log(1024)))
    return `${(n / Math.pow(1024, i)).toFixed(i === 0 ? 0 : 1)} ${units[i]}`
  }

  // Relative "released Nd ago" from the manifest's pub_date, shown next to the
  // available version so the user has a sense of freshness before installing.
  // Returns null for a missing/unparseable date or one in the future (clock
  // skew) so nothing misleading is rendered. Computed once per render — it is a
  // banner, not a live clock.
  function fmtReleased(pubDate: string | null): string | null {
    if (!pubDate) return null
    const then = Date.parse(pubDate)
    if (!Number.isFinite(then)) return null
    const diffMs = Date.now() - then
    if (diffMs < 0) return null
    const mins = Math.floor(diffMs / 60000)
    if (mins < 1) return t('update_releasedJustNow')
    if (mins < 60) return t('update_releasedMins', { n: mins })
    const hours = Math.floor(mins / 60)
    if (hours < 24) return t('update_releasedHours', { n: hours })
    const days = Math.floor(hours / 24)
    if (days < 30) return t('update_releasedDays', { n: days })
    const months = Math.floor(days / 30)
    if (months < 12) return t('update_releasedMonths', { n: months })
    return t('update_releasedYears', { n: Math.floor(months / 12) })
  }
</script>

{#if updateStore.visible}
  <div class="update-banner" role="status" aria-live="polite">
    {#if updateStore.status === 'downloading' || updateStore.status === 'installing'}
      <div class="update-banner__main">
        <span class="update-banner__icon" aria-hidden="true">↻</span>
        <span class="update-banner__text">
          {updateStore.status === 'downloading'
            ? t('update_downloading', { version: updateStore.version ?? '' })
            : t('update_installing', { version: updateStore.version ?? '' })}
        </span>
        {#if updateStore.fraction !== null}
          <span class="update-banner__progress">
            <span class="update-banner__progress-bar" style="width: {updateStore.fraction * 100}%"></span>
          </span>
        {/if}
        <span class="update-banner__bytes">
          {fmtBytes(updateStore.downloaded)}{#if updateStore.contentLength > 0}
            / {fmtBytes(updateStore.contentLength)}{/if}
        </span>
      </div>
    {:else if updateStore.status === 'restart'}
      <div class="update-banner__main">
        <span class="update-banner__icon" aria-hidden="true">✓</span>
        <span class="update-banner__text">
          {t('update_restartNeeded', { version: updateStore.version ?? '' })}
        </span>
        <button
          type="button"
          class="update-banner__btn update-banner__btn--ghost"
          onclick={() => updateStore.dismiss()}
          aria-label={t('update_dismiss')}>×</button
        >
      </div>
    {:else if updateStore.status === 'error'}
      {@const reason = updateErrorReason(updateStore.errorMsg)}
      <div class="update-banner__main">
        <span class="update-banner__icon update-banner__icon--error" aria-hidden="true">!</span>
        <span class="update-banner__text">
          {t('update_failed', { version: updateStore.version ?? '' })}
          {#if reason}<span class="update-banner__reason"> — {t(reason)}</span>{/if}
        </span>
        <button type="button" class="update-banner__btn update-banner__btn--primary" onclick={() => updateStore.apply()}
          >{t('retry')}</button
        >
        <button
          type="button"
          class="update-banner__btn update-banner__btn--ghost"
          onclick={() => updateStore.dismiss()}
          aria-label={t('update_dismiss')}>×</button
        >
      </div>
    {:else}
      {@const notes = displayUpdateNotes(updateStore.notes, updateStore.version)}
      <div class="update-banner__main">
        <span class="update-banner__icon" aria-hidden="true">↑</span>
        <span class="update-banner__text">
          {t('update_available', { version: updateStore.version ?? '' })}
          {#if updateStore.currentVersion}<span class="update-banner__reason"
              >{t('update_youHave', { version: updateStore.currentVersion ?? '' })}</span
            >{/if}
          {#if fmtReleased(updateStore.pubDate)}<span class="update-banner__reason">
              · {fmtReleased(updateStore.pubDate)}</span
            >{/if}
          {#if notes}<span class="update-banner__reason"> — {notes}</span>{/if}
        </span>
        <button type="button" class="update-banner__btn update-banner__btn--primary" onclick={() => updateStore.apply()}
          >{t('update')}</button
        >
        <button
          type="button"
          class="update-banner__btn update-banner__btn--ghost"
          onclick={() => updateStore.dismiss()}
          aria-label={t('update_dismiss')}>×</button
        >
      </div>
    {/if}
  </div>
{/if}

<style>
  .update-banner {
    display: block;
    background: var(--bg-panel);
    border-bottom: 1px solid var(--accent);
    color: var(--text-primary);
    font-size: 0.8rem;
    line-height: 1.2;
    user-select: none;
  }
  .update-banner__main {
    display: flex;
    align-items: center;
    gap: 0.6rem;
    padding: 0.35rem 0.75rem;
    min-height: 1.6rem;
    flex-wrap: wrap;
  }
  .update-banner__icon {
    color: var(--accent);
    font-weight: 700;
    width: 1.1rem;
    text-align: center;
    flex-shrink: 0;
  }
  .update-banner__icon--error {
    color: var(--text-secondary);
  }
  .update-banner__text {
    flex: 1 1 auto;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .update-banner__reason {
    color: var(--text-secondary);
  }
  .update-banner__btn {
    background: transparent;
    border: 1px solid var(--border);
    color: var(--text-primary);
    border-radius: 4px;
    padding: 0.15rem 0.6rem;
    font-size: inherit;
    line-height: 1.3;
    cursor: pointer;
    flex-shrink: 0;
  }
  .update-banner__btn:hover {
    background: var(--bg-hover);
  }
  .update-banner__btn--primary {
    background: var(--accent);
    border-color: var(--accent);
    color: var(--on-accent);
    font-weight: 600;
  }
  .update-banner__btn--primary:hover {
    background: var(--accent-hover);
    border-color: var(--accent-hover);
  }
  .update-banner__btn--ghost {
    border-color: transparent;
    color: var(--text-secondary);
    padding: 0.15rem 0.4rem;
    font-size: 1.1rem;
    line-height: 1;
  }
  .update-banner__btn--ghost:hover {
    color: var(--text-primary);
    background: var(--bg-hover);
  }
  .update-banner__progress {
    display: inline-block;
    width: 8rem;
    height: 0.35rem;
    background: var(--bg-input);
    border-radius: 2px;
    overflow: hidden;
    flex-shrink: 0;
  }
  .update-banner__progress-bar {
    display: block;
    height: 100%;
    background: var(--accent);
    transition: width 0.12s linear;
  }
  .update-banner__bytes {
    color: var(--text-secondary);
    font-variant-numeric: tabular-nums;
    flex-shrink: 0;
  }
</style>
