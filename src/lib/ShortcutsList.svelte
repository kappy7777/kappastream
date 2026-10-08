<script lang="ts">
  // The canonical keyboard-shortcut list. Shared by the ? help overlay
  // (ShortcutsHelp.svelte) and the Settings → Keyboard shortcuts section so
  // the two surfaces list exactly the same keys and can never drift; the
  // overlay owns its modal chrome (backdrop, panel, close button), Settings
  // its section heading.
  import { t } from './i18n/index.svelte'
</script>

<ul class="shortcuts-list" aria-label={t('shortcuts_title')}>
  <li>
    <span class="shortcut-keys"><kbd>Space</kbd> <span class="shortcut-or">/</span> <kbd>K</kbd></span><span
      class="shortcut-desc">{t('shortcuts_playPause')}</span
    >
  </li>
  <li>
    <span class="shortcut-keys"><kbd>M</kbd></span><span class="shortcut-desc">{t('shortcuts_muteUnmute')}</span>
  </li>
  <li>
    <span class="shortcut-keys"><kbd>F</kbd></span><span class="shortcut-desc">{t('shortcuts_fullscreen')}</span>
  </li>
  <li><span class="shortcut-keys"><kbd>T</kbd></span><span class="shortcut-desc">{t('shortcuts_theater')}</span></li>
  <li>
    <span class="shortcut-keys"><kbd>←</kbd> <span class="shortcut-or">/</span> <kbd>→</kbd></span><span
      class="shortcut-desc">{t('shortcuts_seek')}</span
    >
  </li>
  <li>
    <span class="shortcut-keys"><kbd>↑</kbd> <span class="shortcut-or">/</span> <kbd>↓</kbd></span><span
      class="shortcut-desc">{t('shortcuts_volume')}</span
    >
  </li>
  <li><span class="shortcut-keys"><kbd>?</kbd></span><span class="shortcut-desc">{t('shortcuts_showHelp')}</span></li>
</ul>
<p class="shortcuts-note">{t('shortcuts_note')}</p>

<style>
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
