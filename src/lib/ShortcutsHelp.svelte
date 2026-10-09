<script lang="ts">
  // The keyboard-shortcuts help overlay (the ? action). Extracted from
  // App.svelte — markup and styles moved verbatim; App owns the open state
  // and the Escape/? handling (shortcuts.ts) so the keyboard path and the
  // modal stay decoupled. The chrome (backdrop + panel + close button)
  // intentionally matches AboutModal's; the rows themselves live in
  // ShortcutsList.svelte, shared with the Settings panel so both surfaces
  // list the same keys.
  import { t } from './i18n/index.svelte'
  import ShortcutsList from './ShortcutsList.svelte'

  interface Props {
    onclose: () => void
  }
  const { onclose }: Props = $props()
</script>

<div class="about-backdrop" onclick={onclose} role="presentation"></div>
<div class="about-modal shortcuts-modal" role="dialog" aria-label={t('shortcuts_title')}>
  <button type="button" class="about-close" onclick={onclose} aria-label={t('shortcuts_close')}>×</button>
  <h2 id="shortcuts-title" class="shortcuts-title">{t('shortcuts_title')}</h2>
  <ShortcutsList />
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
    width: min(480px, calc(100vw / var(--ui-zoom, 1) - 32px));
    max-height: calc(100vh / var(--ui-zoom, 1) - 64px);
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
    width: min(420px, calc(100vw / var(--ui-zoom, 1) - 32px));
  }
  .shortcuts-title {
    margin: 0;
    font-size: 18px;
    font-weight: 700;
  }
</style>
