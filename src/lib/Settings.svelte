<script lang="ts">
  import { onMount } from 'svelte'
  import { invoke, isTauri } from '@tauri-apps/api/core'
  import type { MpvAvailability } from './video-backend'
  import {
    settings,
    THEMES,
    UI_SCALE_PRESETS,
    UI_SCALE_MIN,
    UI_SCALE_MAX,
    UI_SCALE_DEFAULT,
    MAX_MUTED_USERS,
    type MpvHwdec,
    type ThemeId,
  } from './settings.svelte.ts'
  import { favoritesStore, type FavoriteStatus } from './favorites.svelte'
  import { sleepTimer, formatSleepRemaining, SLEEP_PRESETS } from './sleep-timer.svelte'
  import { t, getLocale, setLocale, LOCALES } from './i18n/index.svelte'
  import {
    listCustomThemes,
    importAndStoreThemeJson,
    MAX_CUSTOM_THEMES,
    MAX_THEME_FILE_BYTES,
    type CustomTheme,
  } from './custom-themes.svelte'
  import CustomThemeEditor from './CustomThemeEditor.svelte'
  import VersionLog from './VersionLog.svelte'

  let { onarmsleep }: { onarmsleep?: (minutes: number) => void } = $props()

  // ---- Experimental native video engine (LINUX mpv-embed builds only) ----
  // The engine is Linux-only (owner scope decision 2026-09-18). The probe
  // ALWAYS resolves: on Linux with the engine compiled in, a failed surface
  // init carries the Rust-side reason; everywhere else (Windows/macOS, or a
  // --no-default-features build) the Rust stub answers "not supported on
  // this platform". Both render a DISABLED row with the reason — only a
  // live engine shows the working toggle. A persisted mpvEngine=true copied
  // from a Linux machine stays INERT here: the engine selection requires
  // mpvAvailable and falls back to hls.js (video-backend.ts).
  let mpvAvailable = $state(false)
  let mpvUnavailableReason = $state('')
  // Compile-time target OS (the same authoritative `target_os` command App
  // uses) — decides which hwdec entries are offered. Empty until resolved.
  let platformOs = $state('')
  // Per-platform hwdec choices. Technical mpv property values, deliberately
  // NOT translated (same convention as the quality ids in PlayerControls).
  const HWDEC_BY_OS: Record<string, readonly MpvHwdec[]> = {
    // The engine is Linux-only; non-Linux target_os values get the safe
    // fallback pair below (the row never renders there anyway).
    linux: ['no', 'auto-safe', 'vaapi', 'nvdec'],
  }
  // Until target_os resolves (or outside Tauri): the safe pair only.
  const hwdecChoices = $derived<readonly MpvHwdec[]>(HWDEC_BY_OS[platformOs] ?? ['no', 'auto-safe'])
  onMount(() => {
    if (!isTauri()) return
    void invoke<string>('target_os')
      .then((os) => {
        platformOs = os
        // A hwdec stored on a different platform (copied config) may not be
        // valid here; fall back to the default instead of a phantom choice.
        if (!hwdecChoices.includes(settings.mpvHwdec)) settings.setMpvHwdec('no')
      })
      .catch(() => {
        /* leave empty — the safe pair stays offered */
      })
    void invoke<MpvAvailability>('mpv_available')
      .then((a) => {
        mpvAvailable = a?.available === true
        mpvUnavailableReason = mpvAvailable ? '' : (a?.reason ?? 'engine init failed')
      })
      .catch(() => {
        mpvAvailable = false // command not registered = default build
      })
  })

  // ---- Settings window -------------------------------------------------------
  // A centered About-sized modal with a section sidebar — every setting is
  // visible flat in its section pane (no disclosure rows). The last-open
  // section sticks across opens.
  type SettingsSection = 'general' | 'appearance' | 'chat' | 'playback' | 'favorites' | 'changelog' | 'shortcuts'
  let open = $state(false)
  let section = $state<SettingsSection>('general')

  function toggle(): void {
    open = !open
  }

  function closePanel(): void {
    open = false
  }

  // The theme editor (z 60) renders behind the settings modal (z 1000) —
  // opening it must close the panel so it is immediately visible.
  function openThemeEditor(ct: CustomTheme | null): void {
    themeEditorFor = ct
    closePanel()
  }

  function pickTheme(id: ThemeId): void {
    settings.setTheme(id)
  }

  // ---- Custom themes ---------------------------------------------------------
  // undefined = editor closed; null = creating a NEW theme; a CustomTheme =
  // editing that one. Tri-state so "new" (no theme yet) is distinguishable.
  let themeEditorFor = $state<CustomTheme | null | undefined>(undefined)
  let themeFileEl: HTMLInputElement | undefined = $state()
  let themeImportStatus = $state('')
  let themeImportError = $state(false)
  let themeImportTimer: ReturnType<typeof setTimeout> | null = null

  function setThemeImportStatus(msg: string, error: boolean): void {
    themeImportStatus = msg
    themeImportError = error
    if (themeImportTimer) clearTimeout(themeImportTimer)
    themeImportTimer = setTimeout(() => {
      themeImportStatus = ''
    }, 6000)
  }

  function triggerThemeImport(): void {
    setThemeImportStatus('', false)
    themeFileEl?.click()
  }

  async function onThemeFileSelected(e: Event): Promise<void> {
    const input = e.currentTarget as HTMLInputElement
    const file = input.files?.[0]
    input.value = ''
    if (!file) return
    if (file.size > MAX_THEME_FILE_BYTES) {
      setThemeImportStatus(t('settings_ctImportLarge'), true)
      return
    }
    let text: string
    try {
      text = await file.text()
    } catch {
      setThemeImportStatus(t('settings_ctImportBad'), true)
      return
    }
    const result = importAndStoreThemeJson(text)
    if (!result.ok) {
      // Whole-file rejection: nothing was stored or applied.
      setThemeImportStatus(
        result.reason === 'full'
          ? t('settings_ctImportFull', { n: MAX_CUSTOM_THEMES })
          : result.reason === 'too-large'
            ? t('settings_ctImportLarge')
            : t('settings_ctImportBad'),
        true,
      )
      return
    }
    setThemeImportStatus(t('settings_ctImportOk', { name: result.theme.label }), false)
  }

  function onUiScalePick(v: number): void {
    settings.setUiScale(v)
  }

  function resetUiScale(): void {
    settings.resetUiScale()
  }

  // ---- UI-scale line -------------------------------------------------------
  // A draggable scale LINE instead of a button grid: one track, a tick dot
  // per preset stop, and a knob that snaps to the stops while dragging. The
  // stops ARE the existing presets (0.5×…4×) — nothing in between exists.
  // All geometry math is ratio-based (clientX vs the track rect, both in the
  // same visual space), so UI-scale zoom cancels out and no zoomDivisor is
  // needed here.
  let scaleLineEl = $state<HTMLElement | undefined>(undefined)
  let scaleDragging = $state(false)
  const SCALE_LAST = UI_SCALE_PRESETS.length - 1

  function scaleIndexOf(v: number): number {
    const i = UI_SCALE_PRESETS.findIndex((p) => Math.abs(p - v) < 0.001)
    return i === -1 ? UI_SCALE_PRESETS.indexOf(UI_SCALE_DEFAULT) : i
  }
  const scaleIndex = $derived(scaleIndexOf(settings.uiScale))
  function scalePct(i: number): number {
    return (i / SCALE_LAST) * 100
  }
  function pickScaleIndex(i: number): void {
    onUiScalePick(UI_SCALE_PRESETS[Math.max(0, Math.min(SCALE_LAST, i))])
  }
  function scaleFromPointer(e: PointerEvent): void {
    if (!scaleLineEl) return
    const r = scaleLineEl.getBoundingClientRect()
    if (r.width < 1) return
    pickScaleIndex(Math.round(((e.clientX - r.left) / r.width) * SCALE_LAST))
  }
  function onScaleDown(e: PointerEvent): void {
    scaleDragging = true
    ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
    scaleFromPointer(e)
  }
  function onScaleMove(e: PointerEvent): void {
    if (scaleDragging) scaleFromPointer(e)
  }
  function onScaleUp(e: PointerEvent): void {
    scaleDragging = false
    try {
      ;(e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId)
    } catch {
      /* pointer already released */
    }
  }
  function onScaleKey(e: KeyboardEvent): void {
    const step =
      e.key === 'ArrowRight' || e.key === 'ArrowUp' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowDown' ? -1 : null
    if (step !== null) {
      e.preventDefault()
      pickScaleIndex(scaleIndex + step)
    } else if (e.key === 'Home') {
      e.preventDefault()
      pickScaleIndex(0)
    } else if (e.key === 'End') {
      e.preventDefault()
      pickScaleIndex(SCALE_LAST)
    }
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
    muteStatusTimer = setTimeout(() => {
      muteStatus = ''
    }, 3000)
  }
  function addMuted(): void {
    const raw = muteInput
    muteInput = ''
    if (!raw.trim()) return
    const added = settings.addMutedUser(raw)
    if (!added) {
      setMuteStatus(settings.mutedUsers.length >= MAX_MUTED_USERS ? t('settings_muteFull') : t('settings_muteInvalid'))
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

  // ---- Sleep timer ---------------------------------------------------------
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

  // ---- Favorites backup ----------------------------------------------------
  let fileInputEl: HTMLInputElement | undefined = $state()
  let importStatus = $state('')
  let importError = $state(false)
  let favoritesCount = $state(0)

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
      await invoke('save_favorites_export', { content: json, suggestedFilename: filename })
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
    setTimeout(() => {
      importStatus = ''
    }, 6000)
  }

  $effect(() => {
    if (!open) return
    function onKey(e: KeyboardEvent): void {
      if (e.key !== 'Escape') return
      // The custom-theme editor owns Escape while it is open.
      if (themeEditorFor !== undefined) return
      closePanel()
    }
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('keydown', onKey)
    }
  })
</script>

{#snippet toggleRow(id: string, label: string, hint: string, value: boolean, ontoggle: () => void)}
  <div class="toggle-row">
    <span class="toggle-label" {id}>
      {label}
      {#if hint}<span class="toggle-hint">{hint}</span>{/if}
    </span>
    <span
      class="toggle"
      class:toggle--on={value}
      role="switch"
      tabindex="0"
      aria-checked={value}
      aria-labelledby={id}
      onclick={ontoggle}
      onkeydown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          ontoggle()
        }
      }}
    >
      <span class="toggle-knob"></span>
    </span>
  </div>
{/snippet}

<div class="settings-wrap">
  <button
    type="button"
    class="settings-btn"
    onclick={toggle}
    aria-label={t('settings')}
    aria-haspopup="dialog"
    aria-expanded={open}
  >
    <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
      <path
        d="M19.14 12.94c.04-.31.06-.62.06-.94s-.02-.63-.07-.94l2.03-1.58c.18-.14.23-.41.12-.61l-1.92-3.32c-.12-.22-.37-.29-.59-.22l-2.39.96c-.5-.38-1.03-.7-1.62-.94l-.36-2.54c-.04-.24-.24-.41-.48-.41h-3.84c-.24 0-.43.17-.47.41l-.36 2.54c-.59.24-1.13.57-1.62.94l-2.39-.96c-.22-.08-.47 0-.59.22L2.74 8.87c-.12.21-.08.47.12.61l2.03 1.58c-.05.31-.09.63-.09.94s.02.63.07.94l-2.03 1.58c-.18.14-.23.41-.12.61l1.92 3.32c.12.22.37.29.59.22l2.39-.96c.5.38 1.03.7 1.62.94l.36 2.54c.05.24.24.41.48.41h3.84c.24 0 .44-.17.47-.41l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.22.08.47 0 .59-.22l1.92-3.32c.12-.22.07-.47-.12-.61l-2.01-1.58zM12 15.6c-1.98 0-3.6-1.62-3.6-3.6s1.62-3.6 3.6-3.6 3.6 1.62 3.6 3.6-1.62 3.6-3.6 3.6z"
        fill="currentColor"
      />
    </svg>
  </button>

  {#if open}
    <div class="settings-backdrop" onclick={closePanel} role="presentation"></div>
    <div class="settings-modal settings-panel" role="dialog" aria-modal="true" aria-labelledby="settings-title">
      <div class="settings-head">
        <span id="settings-title" class="settings-title">{t('settings')}</span>
        <button type="button" class="settings-close" onclick={closePanel} aria-label={t('close')}>
          <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
            <path d="M3 3l10 10M13 3L3 13" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" />
          </svg>
        </button>
      </div>
      <div class="settings-frame">
        <nav class="settings-nav" aria-label={t('settings')}>
          <button
            type="button"
            class="settings-nav-item"
            class:settings-nav-item--active={section === 'general'}
            onclick={() => (section = 'general')}
            aria-current={section === 'general' ? 'true' : undefined}
          >
            <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
              <path
                d="M19.14 12.94c.04-.31.06-.62.06-.94s-.02-.63-.07-.94l2.03-1.58c.18-.14.23-.41.12-.61l-1.92-3.32c-.12-.22-.37-.29-.59-.22l-2.39.96c-.5-.38-1.03-.7-1.62-.94l-.36-2.54c-.04-.24-.24-.41-.48-.41h-3.84c-.24 0-.43.17-.47.41l-.36 2.54c-.59.24-1.13.57-1.62.94l-2.39-.96c-.22-.08-.47 0-.59.22L2.74 8.87c-.12.21-.08.47.12.61l2.03 1.58c-.05.31-.09.63-.09.94s.02.63.07.94l-2.03 1.58c-.18.14-.23.41-.12.61l1.92 3.32c.12.22.37.29.59.22l2.39-.96c.5.38 1.03.7 1.62.94l.36 2.54c.05.24.24.41.48.41h3.84c.24 0 .44-.17.47-.41l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.22.08.47 0 .59-.22l1.92-3.32c.12-.22.07-.47-.12-.61l-2.01-1.58zM12 15.6c-1.98 0-3.6-1.62-3.6-3.6s1.62-3.6 3.6-3.6 3.6 1.62 3.6 3.6-1.62 3.6-3.6 3.6z"
                fill="currentColor"
              />
            </svg>
            <span class="settings-nav-label">{t('settings_sectionGeneral')}</span>
          </button>
          <button
            type="button"
            class="settings-nav-item"
            class:settings-nav-item--active={section === 'appearance'}
            onclick={() => (section = 'appearance')}
            aria-current={section === 'appearance' ? 'true' : undefined}
          >
            <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
              <circle cx="12" cy="12" r="8.5" fill="none" stroke="currentColor" stroke-width="1.8" />
              <path d="M12 3.5a8.5 8.5 0 0 0 0 17z" fill="currentColor" />
            </svg>
            <span class="settings-nav-label">{t('settings_sectionAppearance')}</span>
          </button>
          <button
            type="button"
            class="settings-nav-item"
            class:settings-nav-item--active={section === 'chat'}
            onclick={() => (section = 'chat')}
            aria-current={section === 'chat' ? 'true' : undefined}
          >
            <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
              <path
                d="M5 3h14a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2h-8.6L6 21.5V17H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z"
                fill="currentColor"
              />
            </svg>
            <span class="settings-nav-label">{t('settings_chat')}</span>
          </button>
          <button
            type="button"
            class="settings-nav-item"
            class:settings-nav-item--active={section === 'playback'}
            onclick={() => (section = 'playback')}
            aria-current={section === 'playback' ? 'true' : undefined}
          >
            <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
              <path
                d="M8 5.3v13.4c0 .8.9 1.3 1.6.9l10.4-6.7c.6-.4.6-1.4 0-1.8L9.6 4.4c-.7-.4-1.6.1-1.6.9z"
                fill="currentColor"
              />
            </svg>
            <span class="settings-nav-label">{t('settings_sectionPlayback')}</span>
          </button>
          <button
            type="button"
            class="settings-nav-item"
            class:settings-nav-item--active={section === 'favorites'}
            onclick={() => (section = 'favorites')}
            aria-current={section === 'favorites' ? 'true' : undefined}
          >
            <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
              <path
                d="M12 20.1l-1.4-1.3C6.1 14.8 3.2 12.2 3.2 8.9c0-2.6 2-4.7 4.6-4.7 1.5 0 2.9.7 4.2 2.2 1.3-1.5 2.7-2.2 4.2-2.2 2.6 0 4.6 2.1 4.6 4.7 0 3.3-2.9 5.9-7.4 9.9z"
                fill="currentColor"
              />
            </svg>
            <span class="settings-nav-label">{t('settings_sectionFavorites')}</span>
          </button>
          <button
            type="button"
            class="settings-nav-item"
            class:settings-nav-item--active={section === 'changelog'}
            onclick={() => (section = 'changelog')}
            aria-current={section === 'changelog' ? 'true' : undefined}
          >
            <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
              <path
                d="M4 5.5h.01M4 12h.01M4 18.5h.01"
                stroke="currentColor"
                stroke-width="2.6"
                stroke-linecap="round"
              />
              <path
                d="M8.5 5.5H20M8.5 12H20M8.5 18.5H20"
                stroke="currentColor"
                stroke-width="1.8"
                stroke-linecap="round"
              />
            </svg>
            <span class="settings-nav-label">{t('settings_sectionChangelog')}</span>
          </button>
          <button
            type="button"
            class="settings-nav-item"
            class:settings-nav-item--active={section === 'shortcuts'}
            onclick={() => (section = 'shortcuts')}
            aria-current={section === 'shortcuts' ? 'true' : undefined}
          >
            <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
              <rect x="3" y="7" width="18" height="11" rx="2" fill="none" stroke="currentColor" stroke-width="1.8" />
              <path
                d="M6.5 10.5h1M10.5 10.5h1M14.5 10.5h1M18 10.5h.01M6.5 14h11"
                stroke="currentColor"
                stroke-width="1.8"
                stroke-linecap="round"
                fill="none"
              />
            </svg>
            <span class="settings-nav-label">{t('shortcuts_title')}</span>
          </button>
        </nav>

        <div class="settings-content">
          {#if section === 'appearance'}
            <h3 class="section-title">{t('settings_sectionAppearance')}</h3>
            <div class="scale-head">
              <div class="subgroup-label">{t('settings_uiScale')}</div>
              <span class="scale-value">{settings.uiScale}×</span>
            </div>
            <div
              class="scale-line"
              class:scale-line--drag={scaleDragging}
              role="slider"
              tabindex="0"
              aria-label={t('settings_uiScale')}
              aria-valuemin={UI_SCALE_MIN}
              aria-valuemax={UI_SCALE_MAX}
              aria-valuenow={settings.uiScale}
              aria-valuetext="{settings.uiScale}×"
              bind:this={scaleLineEl}
              onpointerdown={onScaleDown}
              onpointermove={onScaleMove}
              onpointerup={onScaleUp}
              onpointercancel={onScaleUp}
              onkeydown={onScaleKey}
            >
              <div class="scale-track"></div>
              <div class="scale-fill" style="width: {scalePct(scaleIndex)}%"></div>
              {#each UI_SCALE_PRESETS as preset, i (preset)}
                <div class="scale-tick" class:scale-tick--active={i === scaleIndex} style="left: {scalePct(i)}%"></div>
              {/each}
              <div class="scale-knob" style="left: {scalePct(scaleIndex)}%"></div>
            </div>
            <div class="scale-labels" aria-hidden="true">
              {#each UI_SCALE_PRESETS as preset, i (preset)}
                <span class="scale-label" class:scale-label--active={i === scaleIndex} style="left: {scalePct(i)}%"
                  >{preset}×</span
                >
              {/each}
            </div>
            <div class="scale-foot">
              <span class="scale-foot-label">{t('settings_uiScaleMin', { n: UI_SCALE_MIN })}</span>
              <button
                type="button"
                class="scale-reset"
                onclick={resetUiScale}
                disabled={settings.uiScale === UI_SCALE_DEFAULT}
                >{t('settings_resetTo', { n: UI_SCALE_DEFAULT })}</button
              >
              <span class="scale-foot-label">{t('settings_uiScaleMax', { n: UI_SCALE_MAX })}</span>
            </div>

            <div class="subgroup-label">{t('theme')}</div>
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

            <div class="subgroup-label">{t('settings_customThemes')}</div>
            <div class="seg" role="group" aria-label={t('settings_customThemes')}>
              <button
                type="button"
                class="seg-btn"
                onclick={() => {
                  openThemeEditor(null)
                }}
                aria-label={t('settings_ctNew')}
              >
                <svg viewBox="0 0 24 24" width="12" height="12" aria-hidden="true"
                  ><path d="M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z" fill="currentColor" /></svg
                >
                <span style="margin-left: 6px;">{t('settings_ctNew')}</span>
              </button>
              <button type="button" class="seg-btn" onclick={triggerThemeImport} aria-label={t('settings_ctImport')}>
                <svg viewBox="0 0 24 24" width="12" height="12" aria-hidden="true"
                  ><path d="M9 16h6v-6h4l-7-7-7 7h4zm-4 2h14v2H5z" fill="currentColor" /></svg
                >
                <span style="margin-left: 6px;">{t('settings_ctImport')}</span>
              </button>
            </div>
            <div class="ct-list">
              {#each listCustomThemes() as ct (ct.id)}
                <div class="ct-list-row" class:ct-list-row--active={settings.theme === ct.id}>
                  <button
                    type="button"
                    class="ct-list-apply"
                    onclick={() => pickTheme(ct.id)}
                    aria-pressed={settings.theme === ct.id}
                    title={ct.label}
                  >
                    <span class="swatch-color" style="background: {ct.values['--accent']}"></span>
                    <span class="ct-list-label">{ct.label}</span>
                  </button>
                  <button
                    type="button"
                    class="ct-list-edit"
                    onclick={() => {
                      openThemeEditor(ct)
                    }}
                    aria-label={t('settings_ctEdit') + ' — ' + ct.label}
                  >
                    <svg viewBox="0 0 24 24" width="12" height="12" aria-hidden="true"
                      ><path
                        d="M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zM20.71 7.04a1 1 0 0 0 0-1.41l-2.34-2.34a1 1 0 0 0-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z"
                        fill="currentColor"
                      /></svg
                    >
                  </button>
                </div>
              {/each}
              {#if listCustomThemes().length === 0}
                <p class="ct-empty-hint">{t('settings_ctEmpty')}</p>
              {/if}
            </div>
            <input
              type="file"
              accept="application/json,.json"
              bind:this={themeFileEl}
              onchange={onThemeFileSelected}
              style="display: none"
            />
            {#if themeImportStatus}
              <p class="import-status" class:import-status--error={themeImportError}>{themeImportStatus}</p>
            {/if}
          {:else if section === 'chat'}
            <h3 class="section-title">{t('settings_chat')}</h3>
            {@render toggleRow('show-chat-label', t('settings_showChat'), '', settings.chatVisible, () =>
              settings.toggleChatVisible(),
            )}
            {@render toggleRow('chat-timestamps-label', t('settings_chatTimestamps'), '', settings.chatTimestamps, () =>
              settings.toggleChatTimestamps(),
            )}
            <div class="subgroup-label">{t('settings_features')}</div>
            {@render toggleRow(
              'chat-notices-sub-label',
              t('settings_noticesSub'),
              t('settings_noticesSubHint'),
              settings.chatNoticesSub,
              () => settings.toggleChatNoticesSub(),
            )}
            {@render toggleRow(
              'chat-notices-gift-label',
              t('settings_noticesGift'),
              t('settings_noticesGiftHint'),
              settings.chatNoticesGift,
              () => settings.toggleChatNoticesGift(),
            )}
            {@render toggleRow(
              'chat-notices-raid-label',
              t('settings_noticesRaid'),
              t('settings_noticesRaidHint'),
              settings.chatNoticesRaid,
              () => settings.toggleChatNoticesRaid(),
            )}
            {@render toggleRow(
              'chat-notices-announcement-label',
              t('settings_noticesAnnouncement'),
              t('settings_noticesAnnouncementHint'),
              settings.chatNoticesAnnouncement,
              () => settings.toggleChatNoticesAnnouncement(),
            )}
            {@render toggleRow(
              'chat-notices-streak-label',
              t('settings_noticesStreak'),
              t('settings_noticesStreakHint'),
              settings.chatNoticesStreak,
              () => settings.toggleChatNoticesStreak(),
            )}
            {@render toggleRow(
              'chat-roomstate-label',
              t('settings_chatMode'),
              t('settings_chatModeHint'),
              settings.chatRoomstate,
              () => settings.toggleChatRoomstate(),
            )}
            {@render toggleRow(
              'chat-moderation-label',
              t('settings_moderation'),
              t('settings_moderationHint'),
              settings.chatModeration,
              () => settings.toggleChatModeration(),
            )}
            {@render toggleRow('chat-bits-label', t('settings_bits'), t('settings_bitsHint'), settings.chatBits, () =>
              settings.toggleChatBits(),
            )}
            {@render toggleRow(
              'chat-pinned-label',
              t('settings_chatPinned'),
              t('settings_chatPinnedHint'),
              settings.chatPinned,
              () => settings.toggleChatPinned(),
            )}
            <div class="subgroup-label">
              {t('settings_mutedUsers')} <span class="mute-count">{settings.mutedUsers.length || ''}</span>
            </div>
            <div class="mute-input-row">
              <span class="mention-prefix" aria-hidden="true">@</span>
              <input
                type="text"
                class="mention-input mute-input"
                placeholder={t('settings_mutePlaceholder')}
                value={muteInput}
                oninput={(e) => {
                  muteInput = (e.currentTarget as HTMLInputElement).value
                }}
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
                      aria-label={t('settings_unmute', { name })}>×</button
                    >
                  </li>
                {/each}
              </ul>
            {/if}
            <div class="subgroup-label">{t('settings_yourUsername')}</div>
            <div class="mention-row">
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
          {:else if section === 'playback'}
            <h3 class="section-title">{t('settings_sectionPlayback')}</h3>
            {@render toggleRow(
              'low-latency-label',
              t('settings_lowLatency'),
              t('settings_lowLatencyHint'),
              settings.lowLatency,
              () => settings.toggleLowLatency(),
            )}
            {#if mpvAvailable}
              {@render toggleRow(
                'mpv-engine-label',
                t('settings_mpvEngine'),
                t('settings_mpvEngineHint'),
                settings.mpvEngine,
                () => settings.toggleMpvEngine(),
              )}
              {#if settings.mpvEngine}
                <div class="hwdec-row">
                  <span class="toggle-label" id="mpv-hwdec-label">{t('settings_mpvHwdec')}</span>
                  <div class="lang-grid" role="radiogroup" aria-labelledby="mpv-hwdec-label">
                    {#each hwdecChoices as hw (hw)}
                      <button
                        type="button"
                        class="lang-btn"
                        class:lang-btn--active={settings.mpvHwdec === hw}
                        role="radio"
                        aria-checked={settings.mpvHwdec === hw}
                        onclick={() => settings.setMpvHwdec(hw)}>{hw}</button
                      >
                    {/each}
                  </div>
                </div>
              {/if}
            {:else if mpvUnavailableReason}
              <!-- Flagged build whose surface failed to init: show WHY instead of
                   hiding the row (a hidden row is indistinguishable from a default
                   build and gives the owner nothing to act on). -->
              <div class="toggle-row toggle-row--disabled">
                <span class="toggle-label" id="mpv-engine-label">
                  {t('settings_mpvEngine')}
                  <span class="toggle-hint">{mpvUnavailableReason}</span>
                </span>
                <span class="toggle" aria-disabled="true" aria-labelledby="mpv-engine-label">
                  <span class="toggle-knob"></span>
                </span>
              </div>
            {/if}
            <div class="subgroup-label">{t('settings_sleepTimer')}</div>
            <div class="seg" role="group" aria-label={t('settings_sleepDurationAria')}>
              <button
                type="button"
                class="seg-btn"
                class:seg-btn--active={!sleepTimer.armed}
                aria-pressed={!sleepTimer.armed}
                onclick={cancelSleep}>{t('off')}</button
              >
              {#each SLEEP_PRESETS as preset (preset)}
                <button
                  type="button"
                  class="seg-btn"
                  class:seg-btn--active={sleepTimer.armed && sleepTimer.armedMinutes === preset}
                  aria-pressed={sleepTimer.armed && sleepTimer.armedMinutes === preset}
                  onclick={() => armSleep(preset)}>{preset}m</button
                >
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
                oninput={(e) => {
                  sleepCustom = (e.currentTarget as HTMLInputElement).value
                  sleepCustomError = ''
                }}
                onkeydown={onSleepCustomKeydown}
                aria-label={t('settings_sleepCustomAria')}
              />
              <span class="sleep-custom-unit">{t('settings_sleepCustomUnit')}</span>
              <button type="button" class="mute-add" onclick={armCustomSleep} disabled={parsedCustomMinutes() === null}
                >{t('set')}</button
              >
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
          {:else if section === 'general'}
            <h3 class="section-title">{t('settings_sectionGeneral')}</h3>
            {@render toggleRow(
              'close-to-tray-label',
              t('settings_closeToTray'),
              t('settings_closeToTrayHint'),
              settings.closeToTray,
              () => settings.toggleCloseToTray(),
            )}
            {@render toggleRow(
              'check-updates-label',
              t('settings_checkUpdates'),
              t('settings_checkUpdatesHint'),
              settings.checkUpdates,
              () => settings.toggleCheckUpdates(),
            )}
            <div class="subgroup-label">{t('settings_language')}</div>
            <div class="lang-grid" role="radiogroup" aria-label={t('settings_language')}>
              {#each LOCALES as loc (loc.id)}
                <button
                  type="button"
                  class="lang-btn"
                  class:lang-btn--active={getLocale() === loc.id}
                  role="radio"
                  aria-checked={getLocale() === loc.id}
                  onclick={() => setLocale(loc.id)}>{loc.label}</button
                >
              {/each}
            </div>
          {:else if section === 'favorites'}
            <h3 class="section-title">{t('settings_sectionFavorites')}</h3>
            <div class="subgroup-label">{t('settings_favSort')}</div>
            <div class="seg" role="radiogroup" aria-label={t('settings_favSortMode')}>
              <button
                type="button"
                class="seg-btn"
                class:seg-btn--active={settings.sortMode === 'auto'}
                role="radio"
                aria-checked={settings.sortMode === 'auto'}
                onclick={() => settings.setSortMode('auto')}>{t('settings_sortAuto')}</button
              >
              <button
                type="button"
                class="seg-btn"
                class:seg-btn--active={settings.sortMode === 'manual'}
                role="radio"
                aria-checked={settings.sortMode === 'manual'}
                onclick={() => settings.setSortMode('manual')}>{t('settings_sortManual')}</button
              >
            </div>
            <div class="subgroup-label">{t('settings_favBackup')}</div>
            <div class="seg" role="group" aria-label={t('settings_backupGroup')}>
              <button type="button" class="seg-btn" onclick={triggerImport} aria-label={t('settings_importAria')}>
                <svg viewBox="0 0 24 24" width="12" height="12" aria-hidden="true">
                  <path d="M9 16h6v-6h4l-7-7-7 7h4zm-4 2h14v2H5z" fill="currentColor" />
                </svg>
                <span style="margin-left: 6px;">{t('import')}</span>
              </button>
              <button
                type="button"
                class="seg-btn"
                onclick={exportFavorites}
                disabled={favoritesCount === 0}
                aria-label={t(favoritesCount === 1 ? 'settings_exportAriaOne' : 'settings_exportAriaMany', {
                  n: favoritesCount,
                })}
              >
                <svg viewBox="0 0 24 24" width="12" height="12" aria-hidden="true">
                  <path d="M19 9h-4V3H9v6H5l7 7 7-7zM5 18v2h14v-2H5z" fill="currentColor" />
                </svg>
                <span style="margin-left: 6px;"
                  >{t('exportLabel')}{favoritesCount > 0 ? ` (${favoritesCount})` : ''}</span
                >
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
          {:else if section === 'changelog'}
            <h3 class="section-title">{t('settings_sectionChangelog')}</h3>
            <VersionLog />
          {:else if section === 'shortcuts'}
            <h3 class="section-title">{t('shortcuts_title')}</h3>
            <p class="shortcut-hint">
              {t('shortcuts_hintPrefix')} <kbd>Space</kbd>
              {t('shortcuts_hintPlay')}, <kbd>M</kbd>
              {t('shortcuts_hintMute')}, <kbd>F</kbd>
              {t('shortcuts_hintFullscreen')}, <kbd>T</kbd>
              {t('shortcuts_hintTheater')}, {t('shortcuts_hintArrows')}
              {t('shortcuts_hintPress')} <kbd>?</kbd>
              {t('shortcuts_hintFullList')}
            </p>
          {/if}
        </div>
      </div>
    </div>
  {/if}

  {#if themeEditorFor !== undefined}
    <CustomThemeEditor
      theme={themeEditorFor}
      onclose={() => {
        themeEditorFor = undefined
      }}
    />
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
    transition:
      background 150ms,
      color 150ms;
  }

  .settings-btn:hover {
    background: var(--bg-hover);
    color: var(--text-primary);
  }

  .settings-btn[aria-expanded='true'] {
    background: var(--bg-hover);
    color: var(--text-primary);
  }

  /* ---- modal shell (About-sized, centered, with backdrop) ---- */
  .settings-backdrop {
    position: fixed;
    inset: 0;
    background: var(--bg-overlay-strong);
    z-index: 1000;
  }

  .settings-modal {
    position: fixed;
    top: 50%;
    left: 50%;
    transform: translate(-50%, -50%);
    z-index: 1001;
    /* FIXED size for every section (owner request 2026-09-16): switching
       sections must not resize the window. The height matches the Playback
       pane's content (the tallest commonly-used section fits without
       scrolling; taller panes — e.g. Chat with a full mute list — scroll in
       place); the width grew a little past the old 480px. Still capped by
       the same viewport formula so short windows keep the modal on-screen. */
    /* --ui-zoom divides ONLY the viewport-unit term, never the px arms:
       on macOS a px length under documentElement zoom paints at zoom × its
       css size (same as Windows/Linux), so dividing px too would shrink the
       box to design size while its zoom-scaled content overflows it — the
       "Settings renders much smaller on macOS" bug (2026-09-18). Viewport
       units are the one thing WKWebView does NOT rescale with the zoom;
       only they need the divisor. With the var at its 1 fallback
       (Linux/Windows) the calc is identical to the bare form. */
    width: min(520px, calc(100vw / var(--ui-zoom, 1) - 32px));
    height: min(400px, calc(100vh / var(--ui-zoom, 1) - 64px));
    background: var(--bg-panel);
    border: 1px solid var(--border);
    border-radius: 8px;
    box-shadow: var(--shadow-menu);
    color: var(--text-primary);
    display: flex;
    flex-direction: column;
    overflow: hidden;
    animation: modal-in 150ms ease-out;
  }

  @keyframes modal-in {
    from {
      opacity: 0;
      transform: translate(-50%, -50%) scale(0.97);
    }
    to {
      opacity: 1;
      transform: translate(-50%, -50%) scale(1);
    }
  }

  .settings-head {
    flex: 0 0 auto;
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 12px 10px 10px 18px;
  }

  .settings-title {
    font-size: 15px;
    font-weight: 700;
    letter-spacing: -0.01em;
  }

  .settings-close {
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

  .settings-close:hover {
    background: var(--bg-hover);
    color: var(--text-primary);
  }

  /* ---- two-pane frame: section sidebar + scrollable content ---- */
  .settings-frame {
    flex: 1 1 auto;
    min-height: 0;
    display: flex;
  }

  .settings-nav {
    flex: 0 0 142px;
    display: flex;
    flex-direction: column;
    gap: 2px;
    padding: 2px 8px 12px 10px;
    border-right: 1px solid var(--border);
    overflow-y: auto;
    overscroll-behavior: contain;
  }

  .settings-nav-item {
    display: flex;
    align-items: center;
    gap: 9px;
    padding: 7px 9px;
    border: none;
    border-radius: 6px;
    background: transparent;
    color: var(--text-secondary);
    font-size: 12.5px;
    font-weight: 600;
    font-family: inherit;
    text-align: left;
    cursor: pointer;
    position: relative;
    transition:
      background 150ms,
      color 150ms;
  }

  .settings-nav-item:hover {
    background: var(--bg-hover);
    color: var(--text-primary);
  }

  .settings-nav-item--active {
    background: var(--bg-hover);
    color: var(--text-primary);
  }

  .settings-nav-item--active::before {
    content: '';
    position: absolute;
    left: 0;
    top: 6px;
    bottom: 6px;
    width: 3px;
    border-radius: 2px;
    background: var(--accent);
  }

  .settings-nav-label {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .settings-content {
    flex: 1 1 auto;
    min-width: 0;
    overflow-y: auto;
    overscroll-behavior: contain;
    padding: 2px 16px 16px;
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  /* Under the FIXED modal height the flex column would otherwise COMPRESS
     its children (flex-shrink defaults to 1) instead of overflowing — the
     "sleep timer / theme list / custom-themes button truncated and
     unreachable" regression. Children keep their natural height; the
     container then genuinely overflows and scrolls. */
  .settings-content > * {
    flex-shrink: 0;
  }

  .section-title {
    margin: 4px 0 2px;
    font-size: 13px;
    font-weight: 700;
    letter-spacing: 0.02em;
    text-transform: uppercase;
    color: var(--text-dim);
  }

  /* Label separating setting groups inside a section pane. */
  .subgroup-label {
    font-size: 10px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: var(--text-dim);
    margin-top: 6px;
    padding-top: 6px;
    border-top: 1px solid var(--border);
  }

  .swatches {
    display: grid;
    grid-template-columns: repeat(5, 1fr);
    grid-template-columns: repeat(auto-fit, minmax(40px, 1fr));
    gap: 6px;
    /* The 34 built-in themes would blow the modal past its cap — bound the
       grid so it scrolls IN PLACE instead (the modal stays compact and the
       groups below stay reachable). */
    max-height: 240px;
    overflow-y: auto;
    overscroll-behavior: contain;
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
    transition:
      border-color 150ms,
      background 150ms;
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

  /* Native-engine hwdec picker (shown only while the experimental mpv engine
     toggle is on and available): label above a wrapped pill radiogroup. */
  .hwdec-row {
    display: flex;
    flex-direction: column;
    gap: 6px;
    padding: 6px 0;
  }

  /* Flagged build whose mpv surface failed to init — the hint carries the
     Rust-side reason; the row is inert. */
  .toggle-row--disabled {
    opacity: 0.55;
    pointer-events: none;
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
    transition:
      border-color 150ms,
      background 150ms;
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
    transition:
      background 150ms,
      color 150ms,
      border-color 150ms;
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
    transition:
      background 150ms,
      color 150ms;
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
    transition:
      background 150ms,
      color 150ms,
      border-color 150ms;
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
    transition:
      border-color 150ms,
      background 150ms;
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
    font-size: 12px;
    line-height: 1.7;
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
    transition:
      background 150ms,
      color 150ms;
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

  .scale-head {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
  }

  .scale-value {
    font-size: 12px;
    font-weight: 700;
    color: var(--accent);
    font-variant-numeric: tabular-nums;
  }

  /* The draggable scale line: 20px hit strip, 3px track, a tick dot per
     preset stop and a knob that snaps between stops. The whole strip is the
     drag surface (pointer capture keeps moves flowing outside it). */
  .scale-line {
    position: relative;
    height: 20px;
    margin-top: 6px;
    cursor: pointer;
    touch-action: none;
    outline: none;
  }

  .scale-line:focus-visible {
    border-radius: 4px;
    box-shadow: 0 0 0 2px var(--accent);
  }

  .scale-track {
    position: absolute;
    left: 0;
    right: 0;
    top: 50%;
    height: 3px;
    transform: translateY(-50%);
    border-radius: 2px;
    background: var(--border);
  }

  .scale-fill {
    position: absolute;
    left: 0;
    top: 50%;
    height: 3px;
    transform: translateY(-50%);
    border-radius: 2px;
    background: var(--accent);
    pointer-events: none;
  }

  .scale-tick {
    position: absolute;
    top: 50%;
    width: 6px;
    height: 6px;
    transform: translate(-50%, -50%);
    border-radius: 50%;
    background: var(--text-dim);
    pointer-events: none;
    transition: background 150ms;
  }

  .scale-tick--active {
    background: var(--accent);
  }

  .scale-knob {
    position: absolute;
    top: 50%;
    width: 14px;
    height: 14px;
    transform: translate(-50%, -50%);
    border-radius: 50%;
    background: var(--bg-app);
    border: 2px solid var(--accent);
    box-shadow: 0 1px 3px rgb(0 0 0 / 0.35);
    pointer-events: none;
    transition: transform 120ms;
  }

  .scale-line:hover .scale-knob,
  .scale-line--drag .scale-knob {
    transform: translate(-50%, -50%) scale(1.15);
  }

  .scale-labels {
    position: relative;
    height: 14px;
    margin-top: 2px;
    pointer-events: none;
  }

  .scale-label {
    position: absolute;
    transform: translateX(-50%);
    font-size: 9px;
    color: var(--text-dim);
    font-variant-numeric: tabular-nums;
  }

  .scale-label--active {
    color: var(--text-primary);
    font-weight: 700;
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
    transition:
      background 150ms,
      color 150ms;
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

  /* EQUAL 3-column grid: every button is the same width (1fr), nothing can
     stretch, and a short last row (Português was the 5th language) keeps
     COLUMN width instead of growing across it — a lone flex item in a
     wrapped flex line filled the whole row (tried and rejected). 3 columns
     × ~160px fit the widest label (Português ≈ 100px) with room to spare;
     the hwdec picker (2–3 short choices) shares the classes on purpose. */
  .lang-grid {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: 4px;
  }

  .lang-btn {
    border: 1px solid var(--border);
    border-radius: 4px;
    background: transparent;
    color: var(--text-secondary);
    font-size: 12px;
    font-weight: 600;
    padding: 6px 8px;
    cursor: pointer;
    transition:
      background 150ms,
      color 150ms,
      border-color 150ms;
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

  /* ---- custom themes list ---- */
  /* Bounded like the swatch grid: many custom themes scroll in place. */
  .ct-list {
    display: flex;
    flex-direction: column;
    gap: 2px;
    max-height: 150px;
    overflow-y: auto;
    overscroll-behavior: contain;
  }
  .ct-list-row {
    display: flex;
    align-items: center;
    gap: 2px;
    border-radius: 5px;
  }
  .ct-list-row--active {
    background: var(--bg-hover);
    box-shadow: inset 0 0 0 1px var(--accent);
  }
  .ct-list-apply {
    flex: 1 1 auto;
    min-width: 0;
    display: flex;
    align-items: center;
    gap: 7px;
    border: none;
    background: transparent;
    color: var(--text-primary);
    font-size: 12px;
    font-family: inherit;
    padding: 5px 7px;
    cursor: pointer;
    text-align: left;
  }
  .ct-list-apply:hover {
    background: var(--bg-hover-faint);
  }
  .ct-list-label {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .ct-list-edit {
    flex: 0 0 auto;
    width: 22px;
    height: 22px;
    border: none;
    border-radius: 4px;
    background: transparent;
    color: var(--text-dim);
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 0;
  }
  .ct-list-edit:hover {
    background: var(--bg-hover);
    color: var(--text-primary);
  }
  .ct-empty-hint {
    margin: 0;
    font-size: 11px;
    color: var(--text-dim);
  }
</style>
