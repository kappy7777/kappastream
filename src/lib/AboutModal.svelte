<script lang="ts">
  // The About modal (kappa logo in the top bar). Extracted from App.svelte —
  // markup and styles moved verbatim; App owns the open/close state and the
  // Escape handling (shortcuts.ts' close-about action) so the keyboard path
  // and the modal stay decoupled. The Changelog button swaps this modal for
  // the version-log overlay (firstLaunch.openChangelog) — App wires that.
  import { t } from './i18n/index.svelte'

  interface Props {
    onclose: () => void
    onchangelog: () => void
  }
  const { onclose, onchangelog }: Props = $props()
</script>

<div class="about-backdrop" onclick={onclose} role="presentation"></div>
<div
  class="about-modal"
  role="dialog"
  aria-modal="true"
  aria-labelledby="about-title"
>
  <button
    type="button"
    class="about-close"
    onclick={onclose}
    aria-label={t('close')}
  >
    <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
      <path d="M3 3l10 10M13 3L3 13" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
    </svg>
  </button>
  <div id="about-title" class="about-modal-name">Kappastream</div>
  <div class="about-modal-version">v{__APP_VERSION__}</div>
  <p class="about-modal-tagline">{t('about_tagline')}</p>
  <p class="about-modal-body">{t('about_body')}</p>
  <p class="about-modal-body">{t('about_streamlink')}</p>
  <p class="about-modal-tagline about-modal-tagline--last">Built to watch, not to be watched.</p>
  <!-- On-demand changelog: swaps the About modal for the version-log
       overlay (the same log the post-update what's-new screen shows —
       every recorded release, scrollable). About closes so only one
       modal is up. -->
  <button type="button" class="about-changelog-btn" onclick={onchangelog}>
    {t('about_changelog')}
  </button>
  <div class="about-modal-donate">
    <span class="about-modal-donate-label">{t('donate')}</span>
    <div class="about-modal-donate-addr-group">
      <span
        class="about-modal-btc-symbol"
        aria-label={t('about_bitcoin')}
        title={t('about_bitcoin')}>₿</span
      >
      <code class="about-modal-donate-addr"
        >bc1qj9ge9ug4pp5mr3g0lepuyyjh4j6sazhg2hgcrv</code
      >
    </div>
  </div>
</div>

<style>
  .about-backdrop {
    position: fixed;
    inset: 0;
    background: var(--bg-overlay-strong);
    z-index: 1000;
  }
  .about-modal {
    position: fixed;
    top: 50%;
    left: 50%;
    transform: translate(-50%, -50%);
    z-index: 1001;
    width: calc(min(480px, calc(100vw - 32px)) / var(--ui-zoom, 1));
    max-height: calc((100vh - 64px) / var(--ui-zoom, 1));
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
  .about-close {
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
  .about-close:hover {
    background: var(--bg-hover);
    color: var(--text-primary);
  }
  .about-modal-name {
    font-size: 20px;
    font-weight: 700;
    letter-spacing: -0.01em;
  }
  .about-modal-version {
    font-size: 12px;
    color: var(--text-dim);
    margin-top: -10px;
  }
  .about-modal-tagline {
    font-size: 14px;
    font-weight: 600;
    color: var(--text-primary);
    line-height: 1.4;
    margin: 0;
  }
  .about-modal-tagline--last {
    font-style: italic;
    color: var(--accent);
  }
  /* Changelog button (opens the version-log overlay). Text-sized and pinned
     to the modal's LEFT edge (align-self overrides the flex column's stretch,
     which would make it a full-width row). */
  .about-changelog-btn {
    align-self: flex-start;
    background: var(--bg-input);
    border: 1px solid var(--border);
    color: var(--text-secondary);
    font-size: 12px;
    font-weight: 600;
    font-family: inherit;
    padding: 3px 10px;
    border-radius: 6px;
    cursor: pointer;
  }
  .about-changelog-btn:hover {
    background: var(--bg-hover);
    border-color: var(--accent);
    color: var(--text-primary);
  }
  .about-modal-body {
    font-size: 13px;
    color: var(--text-secondary);
    line-height: 1.55;
    margin: 0;
  }
  .about-modal-donate {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 8px;
    padding-top: 12px;
    margin-top: 2px;
    border-top: 1px solid var(--border);
    font-size: 12px;
  }
  .about-modal-donate-label {
    flex: 0 0 auto;
    color: var(--text-dim);
    font-size: 11px;
    font-weight: 600;
    letter-spacing: 0.06em;
    text-transform: uppercase;
  }
  .about-modal-donate-addr {
    font-family: ui-monospace, 'SF Mono', 'Cascadia Mono', 'Segoe UI Mono', Consolas, monospace;
    font-size: 11px;
    color: var(--text-secondary);
    word-break: break-all;
    user-select: all;
  }
  .about-modal-donate-addr-group {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 3px;
    min-width: 0;
  }
  .about-modal-btc-symbol {
    flex: 0 0 auto;
    color: #f7931a;
    font-size: 14px;
    font-weight: 700;
    line-height: 1;
    user-select: none;
  }
</style>
