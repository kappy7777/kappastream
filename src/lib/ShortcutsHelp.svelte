<script lang="ts">
  // The keyboard-shortcuts help overlay (the ? action). Extracted from
  // App.svelte — markup and styles moved verbatim; App owns the open state
  // and the Escape/? handling (shortcuts.ts) so the keyboard path and the
  // modal stay decoupled. The chrome (backdrop + panel + close button)
  // intentionally matches AboutModal's.
  import { t } from './i18n/index.svelte'

  interface Props {
    onclose: () => void
  }
  const { onclose }: Props = $props()
</script>

<div class="about-backdrop" onclick={onclose} role="presentation"></div>
<div class="about-modal shortcuts-modal" role="dialog" aria-label={t('shortcuts_title')}>
  <button
    type="button"
    class="about-close"
    onclick={onclose}
    aria-label={t('shortcuts_close')}
  >×</button>
  <h2 id="shortcuts-title" class="shortcuts-title">{t('shortcuts_title')}</h2>
  <ul class="shortcuts-list" aria-labelledby="shortcuts-title">
    <li><span class="shortcut-keys"><kbd>Space</kbd> <span class="shortcut-or">/</span> <kbd>K</kbd></span><span class="shortcut-desc">{t('shortcuts_playPause')}</span></li>
    <li><span class="shortcut-keys"><kbd>M</kbd></span><span class="shortcut-desc">{t('shortcuts_muteUnmute')}</span></li>
    <li><span class="shortcut-keys"><kbd>F</kbd></span><span class="shortcut-desc">{t('shortcuts_fullscreen')}</span></li>
    <li><span class="shortcut-keys"><kbd>T</kbd></span><span class="shortcut-desc">{t('shortcuts_theater')}</span></li>
    <li><span class="shortcut-keys"><kbd>←</kbd> <span class="shortcut-or">/</span> <kbd>→</kbd></span><span class="shortcut-desc">{t('shortcuts_seek')}</span></li>
    <li><span class="shortcut-keys"><kbd>↑</kbd> <span class="shortcut-or">/</span> <kbd>↓</kbd></span><span class="shortcut-desc">{t('shortcuts_volume')}</span></li>
    <li><span class="shortcut-keys"><kbd>?</kbd></span><span class="shortcut-desc">{t('shortcuts_showHelp')}</span></li>
  </ul>
  <p class="shortcuts-note">{t('shortcuts_note')}</p>
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
  /* Keyboard-shortcuts help overlay (?). Reuses the about-modal chrome. */
  .shortcuts-modal {
    max-width: 420px;
    width: calc(min(420px, calc(100vw - 32px)) / var(--ui-zoom, 1));
  }
  .shortcuts-title {
    margin: 0;
    font-size: 18px;
    font-weight: 700;
  }
  .shortcuts-list {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .shortcuts-list li {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 16px;
  }
  .shortcut-keys {
    flex: 0 0 auto;
    display: inline-flex;
    align-items: center;
    gap: 4px;
    min-width: 96px;
  }
  .shortcut-or {
    color: var(--text-dim);
    font-size: 11px;
  }
  .shortcut-desc {
    flex: 1 1 auto;
    text-align: right;
    color: var(--text-secondary);
    font-size: 13px;
  }
  .shortcuts-list kbd {
    display: inline-block;
    padding: 2px 7px;
    border: 1px solid var(--border);
    border-bottom-width: 2px;
    border-radius: 4px;
    background: var(--bg-input);
    color: var(--text-primary);
    font-family: 'Menlo', 'Consolas', monospace;
    font-size: 12px;
    line-height: 1.4;
    min-width: 16px;
    text-align: center;
  }
  .shortcuts-note {
    margin: 4px 0 0;
    font-size: 12px;
    color: var(--text-dim);
  }
</style>
