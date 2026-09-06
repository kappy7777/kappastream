<script lang="ts">
  // First-launch welcome + post-update "what's new" overlay + on-demand
  // changelog viewer.
  //
  // Shown when `firstLaunch.visible` is true (first install → welcome; updated
  // → what's new; normal launch / downgrade → renders nothing) OR when the
  // user opens the changelog from the About modal (`firstLaunch.changelogOpen`
  // — never writes `lastSeenVersion`). The what's-new and changelog surfaces
  // render the same scrollable per-version log (see `isLog`). Dismissal is
  // one click (the button, the ×, the backdrop, or Escape via App.svelte's
  // global handler) and — for the launch screens — writes `lastSeenVersion`
  // so the screen never re-shows for the current version. It is purely
  // additive DOM: it does not delay startup, block playback, or interrupt any
  // in-progress action — everything else (IRC, HLS, favorites polling) is
  // user-triggered and runs after the user dismisses.
  //
  // Non-conflict: the overlay's backdrop (z-index 1000, same as the About
  // modal) covers the top bar, so the About modal, multi-view toggle, and the
  // update banner cannot be reached while this is up. The update banner will
  // not co-occur anyway: on a first install or right after an update the
  // startup update check finds the current version is latest → no banner.
  import { onMount } from 'svelte'
  import { invoke, isTauri } from '@tauri-apps/api/core'
  import { t } from './i18n/index.svelte'
  import { firstLaunch, streamlinkProbeFromResult } from './first-launch.svelte'
  import { releaseNotesFor, releaseNoteVersions } from './release-notes'

  // Streamlink presence probe. Fires once on mount ONLY for the welcome screen
  // (first install) and ONLY under Tauri; the what's-new screen never probes.
  //   'checking' — probe in flight (welcome only)
  //   'present'  — streamlink found; show the ✓ "good to go" line, never install
  //   'missing'  — streamlink absent; show ⚠ + the platform-specific install cmd
  //   'unknown'  — not under Tauri, or the probe failed; render nothing (no nag)
  type StreamlinkState = 'checking' | 'present' | 'missing' | 'unknown'
  let streamlink = $state<StreamlinkState>('unknown')
  let platform = $state<string>('linux')

  // Platform-specific streamlink install commands. Universal (commands are not
  // translated — only the surrounding chrome is). Linux can't be distro-detected
  // from the OS alone, so the common package managers are all listed; macOS →
  // Homebrew; Windows → pip + the install page. Picked at render time from the
  // `platform` the Rust probe reports (the compile-time target OS).
  const STREAMLINK_INSTALL: Record<string, string> = {
    linux: 'pacman -S streamlink (Arch)  ·  apt install streamlink (Debian/Ubuntu)  ·  dnf install streamlink (Fedora)',
    macos: 'brew install streamlink',
    windows: 'pip install streamlink  ·  streamlink.github.io/install.html',
  }

  // One fitting emoji per feature bullet (universal, kept out of the translated
  // strings so the catalogue stays clean text).
  const FEAT_EMOJIS = ['📺', '💬', '⭐', '🧭', '🪟', '🎨'] as const
  const features = $derived([
    t('welcome_feat1'),
    t('welcome_feat2'),
    t('welcome_feat3'),
    t('welcome_feat4'),
    t('welcome_feat5'),
    t('welcome_feat6'),
  ])
  const installCommands = $derived(STREAMLINK_INSTALL[platform] ?? STREAMLINK_INSTALL.linux)

  // Which surface the overlay shows: the on-demand changelog (opened from the
  // About modal) takes precedence; otherwise the launch screen. They cannot
  // both be up (the store's changelogOpen comment explains why).
  const mode = $derived(firstLaunch.changelogOpen ? 'changelog' : firstLaunch.screen)
  // Both the post-update screen and the changelog viewer render the full
  // version LOG — every recorded release, newest first, scrollable — so
  // highlights from previous updates stay reachable. Only the first-install
  // welcome keeps its own layout.
  const isLog = $derived(mode === 'whats-new' || mode === 'changelog')
  const noteVersions = $derived(releaseNoteVersions(__APP_VERSION__))

  onMount(() => {
    if (firstLaunch.screen !== 'welcome') return
    if (!isTauri()) return
    streamlink = 'checking'
    void invoke<{ present: boolean; platform: string }>('streamlink_status')
      .then((r) => {
        const res = streamlinkProbeFromResult(r)
        streamlink = res.state
        platform = res.platform
      })
      .catch(() => {
        streamlink = 'unknown'
      })
  })

  function dismiss(): void {
    firstLaunch.close()
  }
</script>

{#if firstLaunch.visible || firstLaunch.changelogOpen}
  <div class="welcome-backdrop" onclick={dismiss} role="presentation"></div>
  <div
    class="welcome-modal"
    class:welcome-modal--log={isLog}
    role="dialog"
    aria-modal="true"
    aria-labelledby="welcome-title"
  >
    <button
      type="button"
      class="welcome-close"
      onclick={dismiss}
      aria-label={t('close')}
    >×</button>

    {#if mode === 'welcome'}
      <h2 id="welcome-title" class="welcome-title">{t('welcome_title')}</h2>
      <p class="welcome-tagline">{t('welcome_tagline')}</p>

      <section class="welcome-section">
        <h3 class="welcome-section-h">{t('welcome_whatYouCanDo')}</h3>
        <ul class="welcome-features">
          {#each features as f, i (f)}
            <li class="welcome-feat">
              <span class="welcome-feat-emoji" aria-hidden="true">{FEAT_EMOJIS[i] ?? '•'}</span>
              <span class="welcome-feat-text">{f}</span>
            </li>
          {/each}
        </ul>
      </section>

      <section class="welcome-section">
        <h3 class="welcome-section-h">{t('welcome_privacy')}</h3>
        <p class="welcome-body">{t('welcome_privacyBody')}</p>
      </section>

      <section class="welcome-section">
        {#if streamlink === 'present'}
          <p class="welcome-ok">
            <span class="welcome-mark" aria-hidden="true">✓</span>
            {t('welcome_streamlinkOk')}
          </p>
        {:else if streamlink === 'missing'}
          <p class="welcome-missing">
            <span class="welcome-mark welcome-mark--warn" aria-hidden="true">⚠</span>
            {t('welcome_streamlinkMissing')}
          </p>
          <p class="welcome-install">
            <span class="welcome-install-label">{t('welcome_installLabel')}</span>
            <code class="welcome-install-cmd">{installCommands}</code>
          </p>
        {:else if streamlink === 'checking'}
          <p class="welcome-muted">{t('loading')}</p>
        {/if}
      </section>
    {:else}
      <!-- Version log (post-update what's-new AND the on-demand changelog):
           every recorded release, newest first, scrollable — the running
           version leads with the accent header. Sections (Added / Changed /
           Fixed) mirror the CHANGELOG's headings per version. -->
      <h2 id="welcome-title" class="welcome-title">{mode === 'changelog' ? t('about_changelog') : t('whatsnew_title')}</h2>
      <p class="welcome-version">v{__APP_VERSION__}</p>
      <div class="welcome-log">
        {#if noteVersions.length === 0}
          <p class="welcome-intro">{t('whatsnew_generic')}</p>
        {:else}
          {#each noteVersions as version, idx (version)}
            {@const vn = releaseNotesFor(version)}
            <section class="welcome-version-block" class:welcome-version-block--first={idx === 0}>
              <h3 class="welcome-version-h" class:welcome-version-h--latest={version === __APP_VERSION__}>v{version}</h3>
              {#if vn.added && vn.added.length > 0}
                <p class="welcome-section-h">{t('whatsnew_added')}</p>
                <ul class="welcome-list">
                  {#each vn.added as h (h)}
                    <li>{h}</li>
                  {/each}
                </ul>
              {/if}
              {#if vn.changed && vn.changed.length > 0}
                <p class="welcome-section-h">{t('whatsnew_changed')}</p>
                <ul class="welcome-list">
                  {#each vn.changed as h (h)}
                    <li>{h}</li>
                  {/each}
                </ul>
              {/if}
              {#if vn.fixed && vn.fixed.length > 0}
                <p class="welcome-section-h">{t('whatsnew_fixed')}</p>
                <ul class="welcome-list">
                  {#each vn.fixed as h (h)}
                    <li>{h}</li>
                  {/each}
                </ul>
              {/if}
            </section>
          {/each}
        {/if}
      </div>
    {/if}

    <div class="welcome-actions">
      <button
        type="button"
        class="welcome-primary"
        onclick={dismiss}
      >{mode === 'welcome' ? t('welcome_getStarted') : mode === 'changelog' ? t('close') : t('whatsnew_continue')}</button>
    </div>
  </div>
{/if}

<style>
  .welcome-backdrop {
    position: fixed;
    inset: 0;
    background: var(--bg-overlay-strong);
    z-index: 1000;
  }

  .welcome-modal {
    position: fixed;
    top: 50%;
    left: 50%;
    transform: translate(-50%, -50%);
    z-index: 1001;
    width: calc(min(520px, calc(100vw - 32px)) / var(--ui-zoom, 1));
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

  /* Log mode (what's-new + changelog): a fixed comfortable height whose only
     scrolling region is the version log — title and button stay put. */
  .welcome-modal--log {
    height: calc(min(600px, 100vh - 64px) / var(--ui-zoom, 1));
    overflow: hidden;
  }

  /* The scrollable per-version log. min-height:0 lets it shrink inside the
     flex-column modal (without it the content height wins and overflows). */
  .welcome-log {
    flex: 1 1 auto;
    min-height: 0;
    overflow-y: auto;
    display: flex;
    flex-direction: column;
    gap: 14px;
    padding-right: 6px;
  }

  .welcome-version-block {
    display: flex;
    flex-direction: column;
    gap: 6px;
    padding-top: 14px;
    border-top: 1px solid var(--border);
  }
  .welcome-version-block--first {
    padding-top: 0;
    border-top: none;
  }
  .welcome-version-h {
    margin: 0;
    font-size: 13px;
    font-weight: 700;
    color: var(--text-primary);
  }
  /* The RUNNING version leads the log in both modes — accent it so the
     "what changed in THIS update" answer is visually first. */
  .welcome-version-h--latest {
    color: var(--accent);
  }

  .welcome-close {
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
    font-size: 16px;
    line-height: 1;
  }
  .welcome-close:hover {
    background: var(--bg-hover);
    color: var(--text-primary);
  }

  .welcome-title {
    margin: 0;
    font-size: 18px;
    font-weight: 700;
  }

  .welcome-version {
    margin: -8px 0 0;
    color: var(--text-secondary);
    font-size: 13px;
  }

  .welcome-tagline {
    margin: 0;
    color: var(--text-secondary);
    font-size: 13px;
    line-height: 1.5;
  }

  .welcome-intro {
    margin: 0;
    color: var(--text-secondary);
    font-size: 13px;
    line-height: 1.5;
  }

  .welcome-body {
    margin: 0;
    color: var(--text-secondary);
    font-size: 13px;
    line-height: 1.5;
  }

  .welcome-section {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }

  .welcome-section-h {
    margin: 0;
    font-size: 12px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: var(--text-secondary);
  }

  .welcome-ok {
    margin: 0;
    color: var(--text-primary);
    font-size: 13px;
    display: flex;
    align-items: flex-start;
    gap: 6px;
  }

  .welcome-missing {
    margin: 0;
    color: var(--text-primary);
    font-size: 13px;
    font-weight: 600;
    display: flex;
    align-items: flex-start;
    gap: 6px;
  }

  .welcome-mark {
    flex: 0 0 auto;
    font-weight: 700;
    color: var(--accent);
    line-height: 1.5;
  }
  .welcome-mark--warn {
    color: var(--live);
  }

  .welcome-install {
    margin: 0;
    padding: 8px 10px;
    background: var(--bg-input);
    border: 1px solid var(--border);
    border-radius: 4px;
    color: var(--text-secondary);
    font-size: 12px;
    line-height: 1.5;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .welcome-install-label {
    color: var(--text-dim);
    text-transform: uppercase;
    letter-spacing: 0.04em;
    font-size: 10px;
    font-weight: 700;
  }
  .welcome-install-cmd {
    font-family: 'Inter', system-ui, monospace;
    word-break: break-word;
    white-space: pre-wrap;
  }

  .welcome-muted {
    margin: 0;
    color: var(--text-dim);
    font-size: 13px;
  }

  .welcome-features {
    margin: 0;
    padding: 0;
    list-style: none;
    display: flex;
    flex-direction: column;
    gap: 6px;
    color: var(--text-primary);
    font-size: 13px;
    line-height: 1.5;
  }
  .welcome-feat {
    display: flex;
    align-items: flex-start;
    gap: 8px;
  }
  .welcome-feat-emoji {
    flex: 0 0 auto;
    width: 1.4em;
    text-align: center;
    line-height: 1.5;
  }
  .welcome-feat-text {
    flex: 1 1 auto;
    min-width: 0;
  }

  .welcome-list {
    margin: 0;
    padding-left: 18px;
    display: flex;
    flex-direction: column;
    gap: 6px;
    color: var(--text-primary);
    font-size: 13px;
    line-height: 1.5;
  }

  .welcome-actions {
    display: flex;
    justify-content: flex-end;
    margin-top: 4px;
  }
  .welcome-primary {
    background: var(--accent);
    border: 1px solid var(--accent);
    color: #fff;
    font-weight: 600;
    font-size: 13px;
    padding: 8px 18px;
    border-radius: 6px;
    cursor: pointer;
  }
  .welcome-primary:hover {
    background: var(--accent-hover);
    border-color: var(--accent-hover);
  }
</style>
