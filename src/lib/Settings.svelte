<script lang="ts">
  import { slide } from 'svelte/transition'
  import { onMount } from 'svelte'
  import { settings, THEMES, UI_SCALE_PRESETS, UI_SCALE_MIN, UI_SCALE_MAX, UI_SCALE_DEFAULT, MAX_MUTED_USERS, type ThemeId } from './settings.svelte.ts'
  import { favoritesStore, type FavoriteStatus } from './favorites.svelte'
  import { sleepTimer, formatSleepRemaining, SLEEP_PRESETS } from './sleep-timer.svelte'
  import { t, getLocale, setLocale, LOCALES } from './i18n/index.svelte'

  let { onarmsleep }: { onarmsleep?: (minutes: number) => void } = $props()

  let open = $state(false)
  let themeOpen = $state(false)
  let chatOpen = $state(false)
  let scaleOpen = $state(false)
  let langOpen = $state(false)
  let sleepOpen = $state(false)
  let panelEl: HTMLElement | undefined = $state()
  let buttonEl: HTMLButtonElement | undefined = $state()
  let fileInputEl: HTMLInputElement | undefined = $state()
  let importStatus = $state('')
  let importError = $state(false)
  let favoritesCount = $state(0)

  let currentThemeLabel = $derived(
    THEMES.find((tmeta) => tmeta.id === settings.theme)?.label ?? t('theme'),
  )

  let currentLangLabel = $derived(
    LOCALES.find((loc) => loc.id === getLocale())?.label ?? t('settings_language'),
  )

  // Compact state shown on the Chat disclosure row. Surfaces the headline
  // (chat visible or hidden) so the panel is scannable without expanding it.
  let chatSummary = $derived(settings.chatVisible ? t('on') : t('off'))

  function toggle(): void {
    open = !open
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

  function toggleLang(): void {
    langOpen = !langOpen
  }

  function toggleSleep(): void {
    sleepOpen = !sleepOpen
  }

  function armSleep(minutes: number): void {
    onarmsleep?.(minutes)
  }

  function cancelSleep(): void {
    sleepTimer.cancel()
  }

  // Custom duration entry (minutes), for values outside the presets.
  let sleepCustom = $state('')
  const SLEEP_CUSTOM_MIN = 1
  const SLEEP_CUSTOM_MAX = 600
  let sleepCustomError = $state('')
  function parsedCustomMinutes(): number | null {
    const n = parseInt(sleepCustom, 10)
    if (!Number.isFinite(n) || n < SLEEP_CUSTOM_MIN || n > SLEEP_CUSTOM_MAX) return null
    return n
  }
  function armCustomSleep(): void {
    const n = parsedCustomMinutes()
    if (n === null) {
      sleepCustomError = t('settings_sleepCustomError', { min: SLEEP_CUSTOM_MIN, max: SLEEP_CUSTOM_MAX })
      return
    }
    sleepCustomError = ''
    sleepCustom = ''
    onarmsleep?.(n)
  }
  function onSleepCustomKeydown(e: KeyboardEvent): void {
    if (e.key === 'Enter') {
      e.preventDefault()
      armCustomSleep()
    }
  }

  let sleepSummary = $derived(
    sleepTimer.armed ? formatSleepRemaining(sleepTimer.remainingMs) : t('off'),
  )

  function pickTheme(id: ThemeId): void {
    settings.setTheme(id)
  }

  function onUiScalePick(v: number): void {
    settings.setUiScale(v)
  }

  function resetUiScale(): void {
    settings.resetUiScale()
  }

  // ---- Chat mute list -----------------------------------------------------
  // A client-side, login-keyed hide list. Adding/removing applies live to the
  // chat buffer (no reconnect) because the render predicate reads
  // settings.mutedUsers reactively.
  let muteInput = $state('')
  let muteStatus = $state('')
  let muteStatusTimer: ReturnType<typeof setTimeout> | null = null
  function setMuteStatus(msg: string): void {
    muteStatus = msg
    if (muteStatusTimer) clearTimeout(muteStatusTimer)
    muteStatusTimer = setTimeout(() => { muteStatus = '' }, 3000)
  }
  function addMuted(): void {
    const raw = muteInput
    muteInput = ''
    if (!raw.trim()) return
    const added = settings.addMutedUser(raw)
    if (!added) {
      setMuteStatus(
        settings.mutedUsers.length >= MAX_MUTED_USERS ? t('settings_muteFull') : t('settings_muteInvalid'),
      )
    }
  }
  function removeMuted(name: string): void {
    settings.removeMutedUser(name)
  }
  function onMuteInputKeydown(e: KeyboardEvent): void {
    if (e.key === 'Enter') {
      e.preventDefault()
      addMuted()
    }
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
    importError = false
    fileInputEl?.click()
  }

  async function onFileSelected(e: Event): Promise<void> {
    const input = e.currentTarget as HTMLInputElement
    const file = input.files?.[0]
    input.value = ''
    if (!file) return
    if (file.size > 2_000_000) {
      importStatus = t('settings_importFailedLarge')
      importError = true
      return
    }
    let text: string
    try {
      text = await file.text()
    } catch (err) {
      importStatus = t('settings_importFailed', { msg: (err as Error).message })
      importError = true
      return
    }
    const result = favoritesStore.importJson(text)
    if (result.invalid < 0) {
      importStatus = t('settings_importFailedJson')
      importError = true
      return
    }
    importError = false
    if (result.added === 0 && result.skipped === 0 && result.invalid === 0) {
      importStatus = t('settings_importNothing')
    } else {
      const parts: string[] = []
      if (result.added > 0) parts.push(t('settings_importAdded', { n: result.added }))
      if (result.skipped > 0) parts.push(t('settings_importSkipped', { n: result.skipped }))
      if (result.invalid > 0) parts.push(t('settings_importInvalid', { n: result.invalid }))
      importStatus = t('settings_importSummary', { summary: parts.join(', ') })
    }
    setTimeout(() => { importStatus = '' }, 6000)
  }

  $effect(() => {
    if (!open) return
    function onDown(e: MouseEvent): void {
      const target = e.target as Node | null
      if (!target) return
      if (panelEl?.contains(target)) return
      if (buttonEl?.contains(target)) return
      open = false
    }
    function onKey(e: KeyboardEvent): void {
      if (e.key === 'Escape') {
        if (themeOpen) themeOpen = false
        else if (chatOpen) chatOpen = false
        else if (scaleOpen) scaleOpen = false
        else if (langOpen) langOpen = false
        else if (sleepOpen) sleepOpen = false
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
    aria-label={t('settings')}
    aria-haspopup="dialog"
    aria-expanded={open}
  >
    <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
      <path d="M19.14 12.94c.04-.31.06-.62.06-.94s-.02-.63-.07-.94l2.03-1.58c.18-.14.23-.41.12-.61l-1.92-3.32c-.12-.22-.37-.29-.59-.22l-2.39.96c-.5-.38-1.03-.7-1.62-.94l-.36-2.54c-.04-.24-.24-.41-.48-.41h-3.84c-.24 0-.43.17-.47.41l-.36 2.54c-.59.24-1.13.57-1.62.94l-2.39-.96c-.22-.08-.47 0-.59.22L2.74 8.87c-.12.21-.08.47.12.61l2.03 1.58c-.05.31-.09.63-.09.94s.02.63.07.94l-2.03 1.58c-.18.14-.23.41-.12.61l1.92 3.32c.12.22.37.29.59.22l2.39-.96c.5.38 1.03.7 1.62.94l.36 2.54c.05.24.24.41.48.41h3.84c.24 0 .44-.17.47-.41l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.22.08.47 0 .59-.22l1.92-3.32c.12-.22.07-.47-.12-.61l-2.01-1.58zM12 15.6c-1.98 0-3.6-1.62-3.6-3.6s1.62-3.6 3.6-3.6 3.6 1.62 3.6 3.6-1.62 3.6-3.6 3.6z" fill="currentColor"/>
    </svg>
  </button>

  {#if open}
    <div class="panel" bind:this={panelEl} role="dialog" aria-label={t('settings')}>
      <section class="panel-section">
        <button
          type="button"
          class="disclosure"
          class:disclosure--open={themeOpen}
          aria-expanded={themeOpen}
          onclick={toggleTheme}
        >
          <span class="disclosure-label">{t('theme')}</span>
          <span class="disclosure-value">{currentThemeLabel}</span>
          <svg class="disclosure-chevron" viewBox="0 0 12 12" width="12" height="12" aria-hidden="true">
            <path d="M3 5 L6 8 L9 5" stroke="currentColor" stroke-width="1.5" fill="none" stroke-linecap="round" stroke-linejoin="round"/>
          </svg>
        </button>
        {#if themeOpen}
          <div class="disclosure-body" transition:slide={{ duration: 150 }}>
            <div class="swatches">
              {#each THEMES as tm (tm.id)}
                <button
                  type="button"
                  class="swatch"
                  class:swatch--active={settings.theme === tm.id}
                  onclick={() => pickTheme(tm.id)}
                  aria-label={tm.label}
                  aria-pressed={settings.theme === tm.id}
                >
                  <span class="swatch-color" style="background: {tm.swatch}"></span>
                  <span class="swatch-label">{tm.label}</span>
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
          <span class="disclosure-label">{t('settings_chat')}</span>
          <span class="disclosure-value">{chatSummary}</span>
          <svg class="disclosure-chevron" viewBox="0 0 12 12" width="12" height="12" aria-hidden="true">
            <path d="M3 5 L6 8 L9 5" stroke="currentColor" stroke-width="1.5" fill="none" stroke-linecap="round" stroke-linejoin="round"/>
          </svg>
        </button>
        {#if chatOpen}
          <div class="disclosure-body" transition:slide={{ duration: 150 }}>
            <div class="toggle-row">
              <span class="toggle-label" id="show-chat-label">{t('settings_showChat')}</span>
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
              <span class="toggle-label" id="chat-timestamps-label">{t('settings_chatTimestamps')}</span>
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
            <div class="chat-subgroup-label">{t('settings_features')}</div>
            <div class="toggle-row">
              <span class="toggle-label" id="chat-subnotices-label">
                {t('settings_subNotices')}
                <span class="toggle-hint">{t('settings_subNoticesHint')}</span>
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
                {t('settings_chatMode')}
                <span class="toggle-hint">{t('settings_chatModeHint')}</span>
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
                {t('settings_moderation')}
                <span class="toggle-hint">{t('settings_moderationHint')}</span>
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
                {t('settings_bits')}
                <span class="toggle-hint">{t('settings_bitsHint')}</span>
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
            <div class="chat-subgroup-label">{t('settings_mutedUsers')} <span class="mute-count">{settings.mutedUsers.length || ''}</span></div>
            <div class="mute-input-row">
              <span class="mention-prefix" aria-hidden="true">@</span>
              <input
                type="text"
                class="mention-input mute-input"
                placeholder={t('settings_mutePlaceholder')}
                value={muteInput}
                oninput={(e) => { muteInput = (e.currentTarget as HTMLInputElement).value }}
                onkeydown={onMuteInputKeydown}
                autocomplete="off"
                autocapitalize="off"
                spellcheck="false"
                maxlength="25"
                aria-label={t('settings_addMuteAria')}
              />
              <button type="button" class="mute-add" onclick={addMuted} disabled={!muteInput.trim()}>{t('add')}</button>
            </div>
            {#if muteStatus}
              <p class="mute-status" role="status">{muteStatus}</p>
            {/if}
            {#if settings.mutedUsers.length > 0}
              <ul class="mute-list" role="list">
                {#each settings.mutedUsers as name (name)}
                  <li class="mute-item">
                    <span class="mute-name" title={`@${name}`}>@{name}</span>
                    <button
                      type="button"
                      class="mute-remove"
                      onclick={() => removeMuted(name)}
                      aria-label={t('settings_unmute', { name })}
                    >×</button>
                  </li>
                {/each}
              </ul>
            {/if}
            <div class="mention-row">
              <label class="panel-label" for="mention-username-input">{t('settings_yourUsername')}</label>
              <div class="mention-input-wrap">
                <span class="mention-prefix" aria-hidden="true">@</span>
                <input
                  id="mention-username-input"
                  type="text"
                  class="mention-input"
                  placeholder={t('settings_mentionPlaceholder')}
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
                  {t('settings_mentionHelpEmpty')}
                {:else}
                  {t('settings_mentionHelpSet', { name: settings.mentionUsername })}
                {/if}
              </p>
            </div>
          </div>
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
          <span class="disclosure-label">{t('settings_uiScale')}</span>
          <span class="disclosure-value">{Math.round(settings.uiScale * 100)}%</span>
          <svg class="disclosure-chevron" viewBox="0 0 12 12" width="12" height="12" aria-hidden="true">
            <path d="M3 5 L6 8 L9 5" stroke="currentColor" stroke-width="1.5" fill="none" stroke-linecap="round" stroke-linejoin="round"/>
          </svg>
        </button>
        {#if scaleOpen}
          <div class="disclosure-body" transition:slide={{ duration: 150 }}>
            <div class="scale-grid" role="radiogroup" aria-label={t('settings_uiScale')}>
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
              <span class="scale-foot-label">{t('settings_uiScaleMin', { n: UI_SCALE_MIN })}</span>
              <button
                type="button"
                class="scale-reset"
                onclick={resetUiScale}
                disabled={settings.uiScale === UI_SCALE_DEFAULT}
              >{t('settings_resetTo', { n: UI_SCALE_DEFAULT })}</button>
              <span class="scale-foot-label">{t('settings_uiScaleMax', { n: UI_SCALE_MAX })}</span>
            </div>
          </div>
        {/if}
      </section>

      <section class="panel-section">
        <button
          type="button"
          class="disclosure"
          class:disclosure--open={langOpen}
          aria-expanded={langOpen}
          onclick={toggleLang}
        >
          <span class="disclosure-label">{t('settings_language')}</span>
          <span class="disclosure-value">{currentLangLabel}</span>
          <svg class="disclosure-chevron" viewBox="0 0 12 12" width="12" height="12" aria-hidden="true">
            <path d="M3 5 L6 8 L9 5" stroke="currentColor" stroke-width="1.5" fill="none" stroke-linecap="round" stroke-linejoin="round"/>
          </svg>
        </button>
        {#if langOpen}
          <div class="disclosure-body" transition:slide={{ duration: 150 }}>
            <div class="lang-grid" role="radiogroup" aria-label={t('settings_language')}>
              {#each LOCALES as loc (loc.id)}
                <button
                  type="button"
                  class="lang-btn"
                  class:lang-btn--active={getLocale() === loc.id}
                  role="radio"
                  aria-checked={getLocale() === loc.id}
                  onclick={() => setLocale(loc.id)}
                >{loc.label}</button>
              {/each}
            </div>
          </div>
        {/if}
      </section>

      <section class="panel-section">
        <div class="toggle-row">
          <span class="toggle-label" id="low-latency-label">
            {t('settings_lowLatency')}
            <span class="toggle-hint">{t('settings_lowLatencyHint')}</span>
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
            {t('settings_closeToTray')}
            <span class="toggle-hint">{t('settings_closeToTrayHint')}</span>
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
        <div class="toggle-row">
          <span class="toggle-label" id="check-updates-label">
            {t('settings_checkUpdates')}
            <span class="toggle-hint">{t('settings_checkUpdatesHint')}</span>
          </span>
          <span
            class="toggle"
            class:toggle--on={settings.checkUpdates}
            role="switch"
            tabindex="0"
            aria-checked={settings.checkUpdates}
            aria-labelledby="check-updates-label"
            onclick={() => settings.toggleCheckUpdates()}
            onkeydown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); settings.toggleCheckUpdates() } }}
          >
            <span class="toggle-knob"></span>
          </span>
        </div>
        <button
          type="button"
          class="disclosure"
          class:disclosure--open={sleepOpen}
          aria-expanded={sleepOpen}
          onclick={toggleSleep}
        >
          <span class="disclosure-label">{t('settings_sleepTimer')}</span>
          <span class="disclosure-value">{sleepSummary}</span>
          <svg class="disclosure-chevron" viewBox="0 0 12 12" width="12" height="12" aria-hidden="true">
            <path d="M3 5 L6 8 L9 5" stroke="currentColor" stroke-width="1.5" fill="none" stroke-linecap="round" stroke-linejoin="round"/>
          </svg>
        </button>
        {#if sleepOpen}
          <div class="disclosure-body" transition:slide={{ duration: 150 }}>
            <div class="seg" role="group" aria-label={t('settings_sleepDurationAria')}>
              <button
                type="button"
                class="seg-btn"
                class:seg-btn--active={!sleepTimer.armed}
                aria-pressed={!sleepTimer.armed}
                onclick={cancelSleep}
              >{t('off')}</button>
              {#each SLEEP_PRESETS as preset (preset)}
                <button
                  type="button"
                  class="seg-btn"
                  class:seg-btn--active={sleepTimer.armed && sleepTimer.armedMinutes === preset}
                  aria-pressed={sleepTimer.armed && sleepTimer.armedMinutes === preset}
                  onclick={() => armSleep(preset)}
                >{preset}m</button>
              {/each}
            </div>
            <div class="sleep-custom-row">
              <input
                type="number"
                class="sleep-custom-input"
                placeholder={t('settings_sleepCustomPlaceholder')}
                min={SLEEP_CUSTOM_MIN}
                max={SLEEP_CUSTOM_MAX}
                step="1"
                value={sleepCustom}
                oninput={(e) => { sleepCustom = (e.currentTarget as HTMLInputElement).value; sleepCustomError = '' }}
                onkeydown={onSleepCustomKeydown}
                aria-label={t('settings_sleepCustomAria')}
              />
              <span class="sleep-custom-unit">{t('settings_sleepCustomUnit')}</span>
              <button
                type="button"
                class="mute-add"
                onclick={armCustomSleep}
                disabled={parsedCustomMinutes() === null}
              >{t('set')}</button>
            </div>
            {#if sleepCustomError}
              <p class="sleep-custom-error" role="status">{sleepCustomError}</p>
            {/if}
            {#if sleepTimer.armed}
              <div class="sleep-armed-row">
                <span class="sleep-armed-text">
                  {t('settings_sleepStopsIn', { time: formatSleepRemaining(sleepTimer.remainingMs) })}
                </span>
                <button type="button" class="sleep-cancel" onclick={cancelSleep}>{t('cancel')}</button>
              </div>
            {:else}
              <p class="sleep-help">{t('settings_sleepHelp')}</p>
            {/if}
          </div>
        {/if}
      </section>

      <section class="panel-section">
        <div class="panel-label">{t('settings_favSort')}</div>
        <div class="seg" role="radiogroup" aria-label={t('settings_favSortMode')}>
          <button
            type="button"
            class="seg-btn"
            class:seg-btn--active={settings.sortMode === 'auto'}
            role="radio"
            aria-checked={settings.sortMode === 'auto'}
            onclick={() => settings.setSortMode('auto')}
          >{t('settings_sortAuto')}</button>
          <button
            type="button"
            class="seg-btn"
            class:seg-btn--active={settings.sortMode === 'manual'}
            role="radio"
            aria-checked={settings.sortMode === 'manual'}
            onclick={() => settings.setSortMode('manual')}
          >{t('settings_sortManual')}</button>
        </div>
      </section>

      <section class="panel-section">
        <div class="panel-label">{t('settings_favBackup')}</div>
        <div class="seg" role="group" aria-label={t('settings_backupGroup')}>
          <button
            type="button"
            class="seg-btn"
            onclick={triggerImport}
            aria-label={t('settings_importAria')}
          >
            <svg viewBox="0 0 24 24" width="12" height="12" aria-hidden="true">
              <path d="M9 16h6v-6h4l-7-7-7 7h4zm-4 2h14v2H5z" fill="currentColor"/>
            </svg>
            <span style="margin-left: 6px;">{t('import')}</span>
          </button>
          <button
            type="button"
            class="seg-btn"
            onclick={exportFavorites}
            disabled={favoritesCount === 0}
            aria-label={t(favoritesCount === 1 ? 'settings_exportAriaOne' : 'settings_exportAriaMany', { n: favoritesCount })}
          >
            <svg viewBox="0 0 24 24" width="12" height="12" aria-hidden="true">
              <path d="M19 9h-4V3H9v6H5l7 7 7-7zM5 18v2h14v-2H5z" fill="currentColor"/>
            </svg>
            <span style="margin-left: 6px;">{t('exportLabel')}{favoritesCount > 0 ? ` (${favoritesCount})` : ''}</span>
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
          <p class="import-status" class:import-status--error={importError}>
            {importStatus}
          </p>
        {/if}
      </section>

      <section class="panel-section">
        <p class="shortcut-hint">
          {t('shortcuts_hintPrefix')} <kbd>Space</kbd> {t('shortcuts_hintPlay')}, <kbd>M</kbd> {t('shortcuts_hintMute')}, <kbd>F</kbd> {t('shortcuts_hintFullscreen')}, <kbd>T</kbd> {t('shortcuts_hintTheater')}, {t('shortcuts_hintArrows')} {t('shortcuts_hintPress')} <kbd>?</kbd> {t('shortcuts_hintFullList')}
        </p>
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
    max-height: calc(min(calc(100vh - 24px), 600px) / var(--ui-zoom, 1));
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
    min-width: 0;
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

  .mute-count {
    font-size: 10px;
    color: var(--text-dim);
    font-weight: 600;
    margin-left: 2px;
  }

  .mute-input-row {
    position: relative;
    display: flex;
    align-items: center;
    gap: 4px;
  }

  .mute-input-row .mention-prefix {
    position: absolute;
    left: 8px;
  }

  .mute-input {
    flex: 1 1 auto;
    width: auto;
  }

  .mute-add {
    flex: 0 0 auto;
    padding: 6px 10px;
    border: 1px solid var(--border);
    border-radius: 4px;
    background: transparent;
    color: var(--text-secondary);
    font-size: 11px;
    font-weight: 700;
    cursor: pointer;
    transition: background 150ms, color 150ms, border-color 150ms;
  }

  .mute-add:hover:not(:disabled) {
    background: var(--bg-hover);
    color: var(--text-primary);
    border-color: var(--accent);
  }

  .mute-add:disabled {
    color: var(--text-dim);
    cursor: not-allowed;
    opacity: 0.6;
  }

  .mute-status {
    margin: 0;
    font-size: 11px;
    color: var(--text-secondary);
  }

  .mute-list {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 2px;
    max-height: 132px;
    overflow-y: auto;
    overscroll-behavior: contain;
  }

  .mute-item {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 6px;
    padding: 3px 6px;
    border-radius: 4px;
    transition: background 150ms;
  }

  .mute-item:hover {
    background: var(--bg-hover);
  }

  .mute-name {
    font-size: 12px;
    color: var(--text-primary);
    font-family: 'Menlo', 'Consolas', monospace;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .mute-remove {
    flex: 0 0 auto;
    width: 18px;
    height: 18px;
    padding: 0;
    border: none;
    border-radius: 3px;
    background: transparent;
    color: var(--text-dim);
    font-size: 14px;
    line-height: 1;
    cursor: pointer;
    transition: background 150ms, color 150ms;
  }

  .mute-remove:hover {
    background: var(--bg-hover);
    color: var(--live);
  }

  .sleep-armed-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    margin-top: 2px;
  }

  .sleep-armed-text {
    font-size: 12px;
    color: var(--text-primary);
  }

  .sleep-cancel {
    flex: 0 0 auto;
    padding: 4px 10px;
    border: 1px solid var(--border);
    border-radius: 4px;
    background: transparent;
    color: var(--text-secondary);
    font-size: 11px;
    font-weight: 700;
    cursor: pointer;
    transition: background 150ms, color 150ms, border-color 150ms;
  }

  .sleep-cancel:hover {
    background: var(--bg-hover);
    color: var(--text-primary);
    border-color: var(--accent);
  }

  .sleep-help {
    margin: 2px 0 0;
    font-size: 11px;
    color: var(--text-dim);
  }

  .sleep-custom-row {
    display: flex;
    align-items: center;
    gap: 4px;
    margin-top: 2px;
  }

  .sleep-custom-input {
    flex: 1 1 auto;
    width: auto;
    padding: 6px 8px;
    border: 1px solid var(--border);
    border-radius: 4px;
    background: var(--bg-input);
    color: var(--text-primary);
    font-size: 13px;
    font-family: inherit;
    font-variant-numeric: tabular-nums;
    transition: border-color 150ms, background 150ms;
  }

  .sleep-custom-input:hover {
    border-color: var(--track-hover);
  }

  .sleep-custom-input:focus {
    outline: none;
    border-color: var(--accent);
  }

  .sleep-custom-unit {
    flex: 0 0 auto;
    font-size: 11px;
    color: var(--text-dim);
    font-weight: 600;
  }

  .sleep-custom-error {
    margin: 0;
    font-size: 11px;
    color: var(--live);
  }

  .shortcut-hint {
    margin: 0;
    font-size: 11px;
    line-height: 1.5;
    color: var(--text-secondary);
  }

  .shortcut-hint kbd {
    display: inline-block;
    padding: 1px 5px;
    border: 1px solid var(--border);
    border-bottom-width: 2px;
    border-radius: 3px;
    background: var(--bg-input);
    color: var(--text-primary);
    font-family: 'Menlo', 'Consolas', monospace;
    font-size: 10px;
    line-height: 1.3;
  }

  .seg {
    display: flex;
    border: 1px solid var(--border);
    border-radius: 4px;
    overflow: hidden;
  }

  .seg-btn {
    flex: 1 1 0;
    min-width: 0;
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

  .lang-grid {
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
  }

  .lang-btn {
    flex: 1 1 auto;
    min-width: 0;
    border: 1px solid var(--border);
    border-radius: 4px;
    background: transparent;
    color: var(--text-secondary);
    font-size: 12px;
    font-weight: 600;
    padding: 6px 8px;
    cursor: pointer;
    transition: background 150ms, color 150ms, border-color 150ms;
  }

  .lang-btn:hover:not(.lang-btn--active) {
    background: var(--bg-hover);
    color: var(--text-primary);
  }

  .lang-btn--active {
    background: var(--accent);
    color: var(--text-primary);
    border-color: var(--accent);
  }
</style>
