<script lang="ts">
  import { slide } from 'svelte/transition'
  import { onMount } from 'svelte'
  import { settings, THEMES, UI_SCALE_PRESETS, UI_SCALE_MIN, UI_SCALE_MAX, UI_SCALE_STEP, UI_SCALE_DEFAULT, type ThemeId, type SortMode } from './settings.svelte.ts'
  import { favoritesStore, type FavoriteStatus } from './favorites.svelte'
  import { tooltip } from './tooltip.ts'

  let open = $state(false)
  let themeOpen = $state(false)
  let chatOpen = $state(false)
  let scaleOpen = $state(false)
  let panelEl: HTMLElement | undefined = $state()
  let buttonEl: HTMLButtonElement | undefined = $state()
  let fileInputEl: HTMLInputElement | undefined = $state()
  let importStatus = $state('')
  let favoritesCount = $state(0)

  let currentThemeLabel = $derived(
    THEMES.find((t) => t.id === settings.theme)?.label ?? 'Theme',
  )

  // Compact state shown on the Chat disclosure row. Surfaces the headline
  // (chat visible or hidden) so the panel is scannable without expanding it.
  let chatSummary = $derived(settings.chatVisible ? 'On' : 'Off')

  function toggle(): void {
    open = !open
  }

  function close(): void {
    open = false
  }

  function toggleTheme(): void {
    themeOpen = !themeOpen
  }

  function toggleChat(): void {
    chatOpen = !chatOpen
  }

  function toggleScale(): void {
    scaleOpen = !scaleOpen
  }

  function pickTheme(id: ThemeId): void {
    settings.setTheme(id)
  }

  function onUiScalePick(v: number): void {
    settings.setUiScale(v)
  }

  function resetUiScale(): void {
    settings.resetUiScale()
  }

  onMount(() => {
    const unsubscribe = favoritesStore.subscribe((snapshot: FavoriteStatus[]) => {
      favoritesCount = snapshot.length
    })
    return () => unsubscribe()
  })

async function exportFavorites(): Promise<void> {
    if (favoritesCount === 0) return
    const json = favoritesStore.exportJson()
    const d = new Date()
    const pad = (n: number) => n.toString().padStart(2, '0')
    const stamp = d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate())
    const filename = 'twitch-favorites-' + stamp + '.json'
    try {
      await (window as unknown as {
        __TAURI_INTERNALS__: { invoke(cmd: string, args?: unknown): Promise<unknown> }
      }).__TAURI_INTERNALS__.invoke('save_favorites_export', { content: json, suggestedFilename: filename })
    } catch (err) {
      if (import.meta.env.DEV) console.error('favorites export failed', err)
    }
  }

  function triggerImport(): void {
    importStatus = ''
    fileInputEl?.click()
  }

  async function onFileSelected(e: Event): Promise<void> {
    const input = e.currentTarget as HTMLInputElement
    const file = input.files?.[0]
    input.value = ''
    if (!file) return
    if (file.size > 2_000_000) {
      importStatus = 'Import failed: file too large (> 2 MB)'
      return
    }
    let text: string
    try {
      text = await file.text()
    } catch (err) {
      importStatus = 'Import failed: ' + (err as Error).message
      return
    }
    const result = favoritesStore.importJson(text)
    if (result.invalid < 0) {
      importStatus = 'Import failed: not a valid favorites JSON'
      return
    }
    if (result.added === 0 && result.skipped === 0 && result.invalid === 0) {
      importStatus = 'Import: nothing to add'
    } else {
      const parts: string[] = []
      if (result.added > 0) parts.push('added ' + result.added)
      if (result.skipped > 0) parts.push('skipped ' + result.skipped + ' duplicate or over limit')
      if (result.invalid > 0) parts.push('ignored ' + result.invalid + ' invalid')
      importStatus = 'Import: ' + parts.join(', ')
    }
    setTimeout(() => { importStatus = '' }, 6000)
  }

  $effect(() => {
    if (!open) return
    function onDown(e: MouseEvent): void {
      const t = e.target as Node | null
      if (!t) return
      if (panelEl?.contains(t)) return
      if (buttonEl?.contains(t)) return
      open = false
    }
    function onKey(e: KeyboardEvent): void {
      if (e.key === 'Escape') {
        if (themeOpen) themeOpen = false
        else if (chatOpen) chatOpen = false
        else if (scaleOpen) scaleOpen = false
        else open = false
      }
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  })
</script>

<div class="settings-wrap">
  <button
    type="button"
    class="settings-btn"
    bind:this={buttonEl}
    onclick={toggle}
    aria-label="Settings"
    aria-haspopup="dialog"
    aria-expanded={open}
  >
    <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
      <path d="M19.14 12.94c.04-.31.06-.62.06-.94s-.02-.63-.07-.94l2.03-1.58c.18-.14.23-.41.12-.61l-1.92-3.32c-.12-.22-.37-.29-.59-.22l-2.39.96c-.5-.38-1.03-.7-1.62-.94l-.36-2.54c-.04-.24-.24-.41-.48-.41h-3.84c-.24 0-.43.17-.47.41l-.36 2.54c-.59.24-1.13.57-1.62.94l-2.39-.96c-.22-.08-.47 0-.59.22L2.74 8.87c-.12.21-.08.47.12.61l2.03 1.58c-.05.31-.09.63-.09.94s.02.63.07.94l-2.03 1.58c-.18.14-.23.41-.12.61l1.92 3.32c.12.22.37.29.59.22l2.39-.96c.5.38 1.03.7 1.62.94l.36 2.54c.05.24.24.41.48.41h3.84c.24 0 .44-.17.47-.41l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.22.08.47 0 .59-.22l1.92-3.32c.12-.22.07-.47-.12-.61l-2.01-1.58zM12 15.6c-1.98 0-3.6-1.62-3.6-3.6s1.62-3.6 3.6-3.6 3.6 1.62 3.6 3.6-1.62 3.6-3.6 3.6z" fill="currentColor"/>
    </svg>
  </button>

  {#if open}
    <div class="panel" bind:this={panelEl} role="dialog" aria-label="Settings">
      <section class="panel-section">
        <button
          type="button"
          class="disclosure"
          class:disclosure--open={themeOpen}
          aria-expanded={themeOpen}
          onclick={toggleTheme}
        >
          <span class="disclosure-label">Theme</span>
          <span class="disclosure-value">{currentThemeLabel}</span>
          <svg class="disclosure-chevron" viewBox="0 0 12 12" width="12" height="12" aria-hidden="true">
            <path d="M3 5 L6 8 L9 5" stroke="currentColor" stroke-width="1.5" fill="none" stroke-linecap="round" stroke-linejoin="round"/>
          </svg>
        </button>
        {#if themeOpen}
          <div class="disclosure-body" transition:slide={{ duration: 150 }}>
            <div class="swatches">
              {#each THEMES as t}
                <button
                  type="button"
                  class="swatch"
                  class:swatch--active={settings.theme === t.id}
                  onclick={() => pickTheme(t.id)}
                  aria-label={t.label}
                  aria-pressed={settings.theme === t.id}
                >
                  <span class="swatch-color" style="background: {t.swatch}"></span>
                  <span class="swatch-label">{t.label}</span>
                </button>
              {/each}
            </div>
          </div>
        {/if}
      </section>

      <section class="panel-section">
        <button
          type="button"
          class="disclosure"
          class:disclosure--open={chatOpen}
          aria-expanded={chatOpen}
          onclick={toggleChat}
        >
          <span class="disclosure-label">Chat</span>
          <span class="disclosure-value">{chatSummary}</span>
          <svg class="disclosure-chevron" viewBox="0 0 12 12" width="12" height="12" aria-hidden="true">
            <path d="M3 5 L6 8 L9 5" stroke="currentColor" stroke-width="1.5" fill="none" stroke-linecap="round" stroke-linejoin="round"/>
          </svg>
        </button>
        {#if chatOpen}
          <div class="disclosure-body" transition:slide={{ duration: 150 }}>
            <div class="toggle-row">
              <span class="toggle-label" id="show-chat-label">Show chat</span>
              <span
                class="toggle"
                class:toggle--on={settings.chatVisible}
                role="switch"
                tabindex="0"
                aria-checked={settings.chatVisible}
                aria-labelledby="show-chat-label"
                onclick={() => settings.toggleChatVisible()}
                onkeydown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); settings.toggleChatVisible() } }}
              >
                <span class="toggle-knob"></span>
              </span>
            </div>
            <div class="toggle-row">
              <span class="toggle-label" id="chat-timestamps-label">Chat timestamps</span>
              <span
                class="toggle"
                class:toggle--on={settings.chatTimestamps}
                role="switch"
                tabindex="0"
                aria-checked={settings.chatTimestamps}
                aria-labelledby="chat-timestamps-label"
                onclick={() => settings.toggleChatTimestamps()}
                onkeydown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); settings.toggleChatTimestamps() } }}
              >
                <span class="toggle-knob"></span>
              </span>
            </div>
            <div class="chat-subgroup-label">Features</div>
            <div class="toggle-row">
              <span class="toggle-label" id="chat-subnotices-label">
                Sub and raid notices
                <span class="toggle-hint">subs, resubs, gifts, raids, announcements</span>
              </span>
              <span
                class="toggle"
                class:toggle--on={settings.chatSubnotices}
                role="switch"
                tabindex="0"
                aria-checked={settings.chatSubnotices}
                aria-labelledby="chat-subnotices-label"
                onclick={() => settings.toggleChatSubnotices()}
                onkeydown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); settings.toggleChatSubnotices() } }}
              >
                <span class="toggle-knob"></span>
              </span>
            </div>
            <div class="toggle-row">
              <span class="toggle-label" id="chat-roomstate-label">
                Chat mode indicator
                <span class="toggle-hint">sub/followers-only, slow, emote-only, r9k</span>
              </span>
              <span
                class="toggle"
                class:toggle--on={settings.chatRoomstate}
                role="switch"
                tabindex="0"
                aria-checked={settings.chatRoomstate}
                aria-labelledby="chat-roomstate-label"
                onclick={() => settings.toggleChatRoomstate()}
                onkeydown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); settings.toggleChatRoomstate() } }}
              >
                <span class="toggle-knob"></span>
              </span>
            </div>
            <div class="toggle-row">
              <span class="toggle-label" id="chat-moderation-label">
                Show moderation actions
                <span class="toggle-hint">deleted messages and timeouts/bans shown struck through</span>
              </span>
              <span
                class="toggle"
                class:toggle--on={settings.chatModeration}
                role="switch"
                tabindex="0"
                aria-checked={settings.chatModeration}
                aria-labelledby="chat-moderation-label"
                onclick={() => settings.toggleChatModeration()}
                onkeydown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); settings.toggleChatModeration() } }}
              >
                <span class="toggle-knob"></span>
              </span>
            </div>
            <div class="toggle-row">
              <span class="toggle-label" id="chat-bits-label">
                Show bits
                <span class="toggle-hint">cheer amounts on messages</span>
              </span>
              <span
                class="toggle"
                class:toggle--on={settings.chatBits}
                role="switch"
                tabindex="0"
                aria-checked={settings.chatBits}
                aria-labelledby="chat-bits-label"
                onclick={() => settings.toggleChatBits()}
                onkeydown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); settings.toggleChatBits() } }}
              >
                <span class="toggle-knob"></span>
              </span>
            </div>
          </div>
        {/if}
      </section>

      <section class="panel-section">
        <div class="toggle-row">
          <span class="toggle-label" id="low-latency-label">
            Low latency
            <span class="toggle-hint">chase the live edge (closer to chat); may stutter on weak connections</span>
          </span>
          <span
            class="toggle"
            class:toggle--on={settings.lowLatency}
            role="switch"
            tabindex="0"
            aria-checked={settings.lowLatency}
            aria-labelledby="low-latency-label"
            onclick={() => settings.toggleLowLatency()}
            onkeydown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); settings.toggleLowLatency() } }}
          >
            <span class="toggle-knob"></span>
          </span>
        </div>
        <div class="toggle-row">
          <span class="toggle-label" id="close-to-tray-label">
            Close to tray
            <span class="toggle-hint">keep running + notifications when the window is closed</span>
          </span>
          <span
            class="toggle"
            class:toggle--on={settings.closeToTray}
            role="switch"
            tabindex="0"
            aria-checked={settings.closeToTray}
            aria-labelledby="close-to-tray-label"
            onclick={() => settings.toggleCloseToTray()}
            onkeydown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); settings.toggleCloseToTray() } }}
          >
            <span class="toggle-knob"></span>
          </span>
        </div>
        <div class="mention-row">
          <label class="panel-label" for="mention-username-input">Your Twitch username</label>
          <div class="mention-input-wrap">
            <span class="mention-prefix" aria-hidden="true">@</span>
            <input
              id="mention-username-input"
              type="text"
              class="mention-input"
              placeholder="notify on mention"
              value={settings.mentionUsername}
              oninput={(e) => settings.setMentionUsername((e.currentTarget as HTMLInputElement).value)}
              autocomplete="off"
              autocapitalize="off"
              spellcheck="false"
              maxlength="25"
              aria-describedby="mention-help"
            />
          </div>
          <p class="mention-help" id="mention-help">
            {#if !settings.mentionUsername}
              Get a desktop notification when chat messages mention @{''}you.
            {:else}
              You'll be notified when someone writes <span class="mention-pill">@{settings.mentionUsername}</span> in chat.
            {/if}
          </p>
        </div>
      </section>

      <section class="panel-section">
        <div class="panel-label">Favorite sort</div>
        <div class="seg" role="radiogroup" aria-label="Favorite sort mode">
          <button
            type="button"
            class="seg-btn"
            class:seg-btn--active={settings.sortMode === 'auto'}
            role="radio"
            aria-checked={settings.sortMode === 'auto'}
            onclick={() => settings.setSortMode('auto')}
          >Auto (live first, by viewers)</button>
          <button
            type="button"
            class="seg-btn"
            class:seg-btn--active={settings.sortMode === 'manual'}
            role="radio"
            aria-checked={settings.sortMode === 'manual'}
            onclick={() => settings.setSortMode('manual')}
          >Manual (live first, by drag order)</button>
        </div>
      </section>

      <section class="panel-section">
        <div class="panel-label">Favorites backup</div>
        <div class="seg" role="group" aria-label="Favorites import and export">
          <button
            type="button"
            class="seg-btn"
            onclick={triggerImport}
            aria-label="Import favorites from a JSON file"
          >
            <svg viewBox="0 0 24 24" width="12" height="12" aria-hidden="true">
              <path d="M9 16h6v-6h4l-7-7-7 7h4zm-4 2h14v2H5z" fill="currentColor"/>
            </svg>
            <span style="margin-left: 6px;">Import</span>
          </button>
          <button
            type="button"
            class="seg-btn"
            onclick={exportFavorites}
            disabled={favoritesCount === 0}
            aria-label={`Export ${favoritesCount} favorite${favoritesCount === 1 ? '' : 's'} to a JSON file`}
          >
            <svg viewBox="0 0 24 24" width="12" height="12" aria-hidden="true">
              <path d="M19 9h-4V3H9v6H5l7 7 7-7zM5 18v2h14v-2H5z" fill="currentColor"/>
            </svg>
            <span style="margin-left: 6px;">Export{favoritesCount > 0 ? ` (${favoritesCount})` : ''}</span>
          </button>
        </div>
        <input
          type="file"
          accept="application/json,.json"
          bind:this={fileInputEl}
          onchange={onFileSelected}
          style="display: none"
        />
        {#if importStatus}
          <p class="import-status" class:import-status--error={importStatus.startsWith('Import failed')}>
            {importStatus}
          </p>
        {/if}
      </section>

      <section class="panel-section">
        <button
          type="button"
          class="disclosure"
          class:disclosure--open={scaleOpen}
          aria-expanded={scaleOpen}
          onclick={toggleScale}
        >
          <span class="disclosure-label">UI scale</span>
          <span class="disclosure-value">{Math.round(settings.uiScale * 100)}%</span>
          <svg class="disclosure-chevron" viewBox="0 0 12 12" width="12" height="12" aria-hidden="true">
            <path d="M3 5 L6 8 L9 5" stroke="currentColor" stroke-width="1.5" fill="none" stroke-linecap="round" stroke-linejoin="round"/>
          </svg>
        </button>
        {#if scaleOpen}
          <div class="disclosure-body" transition:slide={{ duration: 150 }}>
            <div class="scale-grid" role="radiogroup" aria-label="UI scale">
              {#each UI_SCALE_PRESETS as preset (preset)}
                <button
                  type="button"
                  class="scale-btn"
                  class:scale-btn--active={Math.abs(settings.uiScale - preset) < 0.001}
                  role="radio"
                  aria-checked={Math.abs(settings.uiScale - preset) < 0.001}
                  onclick={() => onUiScalePick(preset)}
                >{preset}×</button>
              {/each}
            </div>
            <div class="scale-foot">
              <span class="scale-foot-label">{UI_SCALE_MIN}× min</span>
              <button
                type="button"
                class="scale-reset"
                onclick={resetUiScale}
                disabled={settings.uiScale === UI_SCALE_DEFAULT}
              >Reset to {UI_SCALE_DEFAULT}×</button>
              <span class="scale-foot-label">{UI_SCALE_MAX}× max</span>
            </div>
          </div>
        {/if}
      </section>

    </div>
  {/if}
</div>

<style>
  .settings-wrap {
    position: relative;
    flex: 0 0 auto;
  }

  .settings-btn {
    width: 30px;
    height: 30px;
    padding: 0;
    border: none;
    border-radius: 4px;
    background: transparent;
    color: var(--text-secondary);
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: center;
    transition: background 150ms, color 150ms;
  }

  .settings-btn:hover {
    background: var(--bg-hover);
    color: var(--text-primary);
  }

  .settings-btn[aria-expanded='true'] {
    background: var(--bg-hover);
    color: var(--text-primary);
  }

  .panel {
    position: absolute;
    top: calc(100% + 6px);
    right: 0;
    width: 260px;
    max-height: min(calc(100vh - 24px), 600px);
    overflow-y: auto;
    overscroll-behavior: contain;
    background: var(--bg-panel);
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 4px 0;
    box-shadow: var(--shadow-menu);
    z-index: 30;
    display: flex;
    flex-direction: column;
    animation: panel-in 150ms ease-out;
    transform-origin: top right;
  }

  @keyframes panel-in {
    from {
      opacity: 0;
      transform: scale(0.96) translateY(-4px);
    }
    to {
      opacity: 1;
      transform: scale(1) translateY(0);
    }
  }

  .panel-section {
    padding: 8px 12px;
    display: flex;
    flex-direction: column;
    gap: 8px;
  }

  .panel-section + .panel-section {
    border-top: 1px solid var(--border);
  }

  .panel-label {
    font-size: 11px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: var(--text-secondary);
  }

  .swatches {
    display: grid;
    grid-template-columns: repeat(5, 1fr);
    grid-template-columns: repeat(auto-fit, minmax(40px, 1fr));
    gap: 6px;
  }

  .swatch {
    border: 1px solid var(--border);
    border-radius: 6px;
    background: transparent;
    padding: 6px 4px;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 4px;
    cursor: pointer;
    transition: border-color 150ms, background 150ms;
  }

  .swatch:hover {
    background: var(--bg-hover);
  }

  .swatch--active {
    border-color: var(--accent);
    background: var(--bg-hover);
  }

  .swatch-color {
    width: 22px;
    height: 22px;
    border-radius: 50%;
    border: 1px solid var(--border);
  }

  .swatch-label {
    font-size: 10px;
    color: var(--text-secondary);
    font-weight: 600;
  }

  .swatch--active .swatch-label {
    color: var(--text-primary);
  }

  .disclosure {
    display: flex;
    align-items: center;
    gap: 8px;
    width: 100%;
    padding: 6px 8px;
    margin: 0;
    border: 1px solid transparent;
    border-radius: 5px;
    background: transparent;
    color: var(--text-primary);
    font-size: 13px;
    text-align: left;
    cursor: pointer;
    transition: background 150ms, border-color 150ms;
  }

  .disclosure:hover {
    background: var(--bg-hover);
  }

  .disclosure--open {
    background: var(--bg-hover);
    border-color: var(--border);
  }

  .disclosure-label {
    flex: 1 1 auto;
    font-weight: 500;
  }

  .disclosure-value {
    flex: 0 0 auto;
    font-size: 12px;
    color: var(--text-secondary);
    font-weight: 500;
    font-variant-numeric: tabular-nums;
    text-align: right;
    max-width: 60%;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .disclosure-chevron {
    flex: 0 0 auto;
    color: var(--text-secondary);
    transition: transform 150ms;
  }

  .disclosure--open .disclosure-chevron {
    transform: rotate(180deg);
  }

  .disclosure-body {
    padding: 2px 0 0;
  }

  /* Mini label separating the chat visibility toggles from the optional
     feature toggles inside the Chat dropdown. Mirrors .panel-label but a hair
     smaller and indented so it reads as a sub-group, not a top-level section. */
  .chat-subgroup-label {
    font-size: 10px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: var(--text-dim);
    margin-top: 6px;
    padding-top: 6px;
    border-top: 1px solid var(--border);
  }

  .toggle-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    cursor: pointer;
    user-select: none;
  }

  .toggle-label {
    font-size: 13px;
    color: var(--text-primary);
    display: flex;
    flex-direction: column;
    gap: 2px;
  }

  .toggle-hint {
    font-size: 11px;
    color: var(--text-dim);
    font-weight: 400;
  }

  .toggle {
    flex: 0 0 auto;
    width: 32px;
    height: 18px;
    border-radius: 999px;
    background: var(--track);
    position: relative;
    cursor: pointer;
    transition: background 150ms;
  }

  .toggle--on {
    background: var(--accent);
  }

  .toggle-knob {
    position: absolute;
    top: 2px;
    left: 2px;
    width: 14px;
    height: 14px;
    border-radius: 50%;
    background: var(--text-primary);
    transition: transform 150ms;
  }

  .toggle--on .toggle-knob {
    transform: translateX(14px);
  }

  .mention-row {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }

  .mention-input-wrap {
    position: relative;
    display: flex;
    align-items: center;
  }

  .mention-prefix {
    position: absolute;
    left: 8px;
    color: var(--text-dim);
    font-size: 13px;
    font-weight: 600;
    pointer-events: none;
  }

  .mention-input {
    width: 100%;
    padding: 6px 8px 6px 22px;
    border: 1px solid var(--border);
    border-radius: 4px;
    background: var(--bg-input);
    color: var(--text-primary);
    font-size: 13px;
    font-family: inherit;
    transition: border-color 150ms, background 150ms;
  }

  .mention-input::placeholder {
    color: var(--text-dim);
  }

  .mention-input:hover {
    border-color: var(--track-hover);
  }

  .mention-input:focus {
    outline: none;
    border-color: var(--accent);
  }

  .mention-help {
    margin: 2px 0 0;
    font-size: 11px;
    color: var(--text-dim);
  }

  .mention-pill {
    display: inline-block;
    padding: 0 5px;
    background: var(--bg-hover);
    border: 1px solid var(--border);
    border-radius: 3px;
    color: var(--accent);
    font-weight: 600;
    font-family: 'Menlo', 'Consolas', monospace;
  }

  .seg {
    display: flex;
    border: 1px solid var(--border);
    border-radius: 4px;
    overflow: hidden;
  }

  .seg-btn {
    flex: 1 1 0;
    padding: 6px 8px;
    border: none;
    border-right: 1px solid var(--border);
    background: transparent;
    color: var(--text-secondary);
    font-size: 11px;
    font-weight: 600;
    cursor: pointer;
    transition: background 150ms, color 150ms;
  }

  .seg-btn:last-child {
    border-right: none;
  }

  .seg-btn:hover:not(.seg-btn--active) {
    background: var(--bg-hover);
    color: var(--text-primary);
  }

  .seg-btn--active {
    background: var(--accent);
    color: var(--text-primary);
  }

  .seg-btn[disabled] {
    color: var(--text-dim);
    cursor: not-allowed;
    opacity: 0.7;
  }

  .seg-btn[disabled]:hover {
    background: transparent;
    color: var(--text-dim);
  }

  .seg-btn svg {
    flex: 0 0 auto;
    display: inline-block;
    vertical-align: -2px;
  }

  .import-status {
    margin: 0;
    font-size: 11px;
    color: var(--text-secondary);
  }

  .import-status--error {
    color: var(--live);
  }

  .scale-grid {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: 4px;
    margin-top: 2px;
  }

  .scale-btn {
    border: 1px solid var(--border);
    border-radius: 4px;
    background: transparent;
    color: var(--text-secondary);
    font-size: 12px;
    font-weight: 600;
    font-variant-numeric: tabular-nums;
    padding: 6px 4px;
    cursor: pointer;
    transition: background 150ms, color 150ms, border-color 150ms;
  }

  .scale-btn:hover:not(.scale-btn--active) {
    background: var(--bg-hover);
    color: var(--text-primary);
  }

  .scale-btn--active {
    background: var(--accent);
    color: var(--text-primary);
    border-color: var(--accent);
  }

  .scale-foot {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-top: 4px;
  }

  .scale-foot-label {
    font-size: 10px;
    color: var(--text-dim);
    font-variant-numeric: tabular-nums;
  }

  .scale-reset {
    border: none;
    background: transparent;
    color: var(--text-secondary);
    font-size: 10px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    cursor: pointer;
    padding: 2px 6px;
    border-radius: 3px;
    transition: background 150ms, color 150ms;
  }

  .scale-reset:hover:not(:disabled) {
    background: var(--bg-hover);
    color: var(--text-primary);
  }

  .scale-reset:disabled {
    color: var(--text-dim);
    cursor: default;
    opacity: 0.6;
  }
</style>
