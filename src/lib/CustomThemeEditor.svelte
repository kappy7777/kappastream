<script lang="ts">
  // Custom-theme editor overlay: "duplicate an existing theme, then adjust".
  // The draft is seeded from the chosen base (built-in or an existing custom
  // theme — readThemeValuesFor snapshots + NORMALIZES its 20 current values),
  // previewed LIVE on the document root while editing, and only persisted on
  // Save. Cancel (or Escape / backdrop) re-applies the saved theme, discarding
  // the preview.
  //
  // Editing is SLIDERS + SWATCHES ONLY — there is no free-text colour entry:
  //  - every property shows a human label (PROP_LABEL, i18n) with the detailed
  //    explanation as its hover tooltip (PROP_HELP);
  //  - expanding a property reveals a 90-swatch palette plus H/S/L sliders
  //    (an alpha slider for the translucent properties, a blur slider for
  //    --shadow-menu — its offsets are fixed 0/8px like every built-in);
  //  - every produced value is generated (palette/swatch/slider math), so it
  //    is VALID BY CONSTRUCTION — the only possible invalid values come from
  //    imports, which are validated at the boundary.
  //
  // Zoom: NO native <select>/<option> popup is used for the base picker —
  // WebKitGTK renders the native popup UNSCALED under documentElement zoom, so
  // at uiScale > 1 it appeared tiny. The base picker is a plain in-document
  // dropdown (button + menu), which scales like everything else.
  //
  // Properties that no surface consumes (UNUSED_THEME_PROPS: --bg-chat,
  // --bg-deep) are hidden from the editor but stay in the storage/import/
  // export contract for compatibility.

  import { onDestroy } from 'svelte'
  import {
    THEME_PROP_GROUPS,
    THEME_PALETTE,
    MAX_CUSTOM_THEMES,
    applyThemeProperties,
    colorToHsl,
    createCustomTheme,
    deleteCustomTheme,
    exportThemeJson,
    getCustomTheme,
    hslToHex,
    isValidThemeLabel,
    isValidThemeValue,
    parseColorToken,
    parsedColorToHsl,
    readThemeValuesFor,
    upsertCustomTheme,
    type CustomTheme,
    type ParsedColor,
    type ThemePropName,
    type ThemeValues,
  } from './custom-themes.svelte'
  import { settings, THEMES, type BuiltInThemeId } from './settings.svelte.ts'
  import { t, type TKey } from './i18n/index.svelte'
  import { tooltip } from './tooltip.ts'

  // Human-readable labels (translated); the detailed explanation stays as the
  // hover tooltip on the label.
  const PROP_LABEL: Partial<Record<ThemePropName, TKey>> = {
    '--bg-app': 'settings_ctN_bgApp',
    '--bg-panel': 'settings_ctN_bgPanel',
    '--bg-input': 'settings_ctN_bgInput',
    '--bg-hover': 'settings_ctN_bgHover',
    '--bg-overlay': 'settings_ctN_bgOverlay',
    '--bg-overlay-strong': 'settings_ctN_bgOverlayStrong',
    '--text-primary': 'settings_ctN_textPrimary',
    '--text-secondary': 'settings_ctN_textSecondary',
    '--text-dim': 'settings_ctN_textDim',
    '--accent': 'settings_ctN_accent',
    '--accent-hover': 'settings_ctN_accentHover',
    '--live': 'settings_ctN_live',
    '--border': 'settings_ctN_border',
    '--track': 'settings_ctN_track',
    '--track-hover': 'settings_ctN_trackHover',
    '--track-buffered': 'settings_ctN_trackBuffered',
    '--bg-hover-faint': 'settings_ctN_bgHoverFaint',
    '--shadow-menu': 'settings_ctN_shadowMenu',
  }

  const PROP_HELP: Partial<Record<ThemePropName, TKey>> = {
    '--bg-app': 'settings_ctP_bgApp',
    '--bg-panel': 'settings_ctP_bgPanel',
    '--bg-input': 'settings_ctP_bgInput',
    '--bg-hover': 'settings_ctP_bgHover',
    '--bg-overlay': 'settings_ctP_bgOverlay',
    '--bg-overlay-strong': 'settings_ctP_bgOverlayStrong',
    '--bg-hover-faint': 'settings_ctP_bgHoverFaint',
    '--text-primary': 'settings_ctP_textPrimary',
    '--text-secondary': 'settings_ctP_textSecondary',
    '--text-dim': 'settings_ctP_textDim',
    '--accent': 'settings_ctP_accent',
    '--accent-hover': 'settings_ctP_accentHover',
    '--live': 'settings_ctP_live',
    '--border': 'settings_ctP_border',
    '--track': 'settings_ctP_track',
    '--track-hover': 'settings_ctP_trackHover',
    '--track-buffered': 'settings_ctP_trackBuffered',
    '--shadow-menu': 'settings_ctP_shadowMenu',
  }

  const GROUP_HELP: Record<string, TKey> = {
    backgrounds: 'settings_ctInfoBackgrounds',
    text: 'settings_ctInfoText',
    accent: 'settings_ctInfoAccent',
    chrome: 'settings_ctInfoChrome',
  }

  /** Properties whose colour carries translucency (get an alpha slider). */
  const TRANSLUCENT_PROPS: ReadonlySet<ThemePropName> = new Set([
    '--bg-overlay', '--bg-overlay-strong', '--bg-hover-faint', '--track-buffered',
  ])

  let {
    theme,
    onclose,
    onimported,
  }: {
    /** null = create a new theme (duplicate-a-base flow). */
    theme: CustomTheme | null
    onclose: () => void
    /** Signals the host section that the list changed (cap messages, refresh). */
    onimported?: () => void
  } = $props()

  // The editor treats `theme` as a FIXED seed: Settings closes and reopens the
  // component for a different theme, it never swaps under a mounted editor.
  // Capture it once so no reactive context accidentally depends on the prop.
  // svelte-ignore state_referenced_locally
  const editing = theme
  const isNew = editing === null

  const initialBase: BuiltInThemeId = editing
    ? 'amethyst'
    : settings.theme.startsWith('custom-')
      ? 'amethyst'
      : (settings.theme as BuiltInThemeId)
  let baseId = $state<BuiltInThemeId>(initialBase)
  let baseOpen = $state(false)

  const seed = editing
    ? { ...editing.values }
    : readThemeValuesFor(initialBase) ?? readThemeValuesFor('amethyst') ?? fallbackValues()

  function fallbackValues(): ThemeValues {
    // Last-resort seed (no computed styles available): the app.css :root
    // defaults. Only reachable in exotic environments; values are validated
    // downstream exactly like any other seed.
    const out = {} as Record<string, string>
    const defaults: Record<string, string> = {
      '--bg-app': '#0E0E10', '--bg-panel': '#18181B', '--bg-chat': '#18181B',
      '--bg-input': '#1F1F23', '--bg-hover': '#26262C', '--bg-deep': '#050505',
      '--text-primary': '#EFEFF1', '--text-secondary': '#ADADB8', '--text-dim': '#848494',
      '--accent': '#6D5DD3', '--accent-hover': '#5A4AB8', '--live': '#EB0400',
      '--border': '#2A2A2D', '--track': '#3A3A3D', '--track-hover': '#4A4A4F',
      '--track-buffered': 'rgba(239, 239, 241, 0.25)',
      '--bg-overlay': 'rgba(14, 14, 16, 0.85)', '--bg-overlay-strong': 'rgba(14, 14, 16, 0.92)',
      '--bg-hover-faint': 'rgba(239, 239, 241, 0.12)',
      '--shadow-menu': '0 8px 24px rgba(0, 0, 0, 0.5)',
    }
    for (const p of Object.keys(defaults)) out[p] = defaults[p]
    return out as ThemeValues
  }

  let label = $state(editing ? editing.label : '')
  let values = $state<Record<ThemePropName, string>>({ ...seed })
  let lastValid: ThemeValues = { ...seed }
  let exportError = $state('')
  /** The one property whose picker is expanded (accordion). */
  let expanded: ThemePropName | null = $state(null)

  function valid(p: ThemePropName, v: string): boolean {
    return isValidThemeValue(p, v)
  }

  const invalidProps = $derived(
    THEME_PROP_GROUPS.flatMap((g) => g.props).filter((p) => !valid(p, values[p])),
  )
  const allValuesValid = $derived(invalidProps.length === 0)
  const labelValid = $derived(isValidThemeLabel(label))
  const canSave = $derived(allValuesValid && labelValid)

  // Live preview: apply the merged set — every currently-valid value, with
  // invalid ones falling back to their last valid value. Save requires ALL
  // values valid (only imports can produce invalid ones).
  $effect(() => {
    const merged: Record<string, string> = { ...lastValid }
    for (const p of Object.keys(values) as ThemePropName[]) {
      if (valid(p, values[p])) merged[p] = values[p]
    }
    if (allValuesValid) lastValid = { ...(values as ThemeValues) }
    applyThemeProperties(merged as ThemeValues)
  })

  // ---- colour plumbing (everything is generated — no typed input) ----------

  function setValue(p: ThemePropName, v: string): void {
    values = { ...values, [p]: v }
  }

  function shadowParts(v: string): { color: ParsedColor; blur: number } | null {
    const m = /^(\S+)\s+(\S+)\s+(\S+)\s+(.*)$/.exec(v.trim())
    if (!m) return null
    const blur = Number.parseFloat(m[3]!)
    if (!Number.isFinite(blur)) return null
    const color = parseColorToken(m[4]!)
    if (!color) return null
    return { color, blur }
  }

  /** The colour of a property (the rgba inside --shadow-menu for shadows). */
  function colorOf(p: ThemePropName): ParsedColor | null {
    if (p === '--shadow-menu') return shadowParts(values[p])?.color ?? null
    return parseColorToken(values[p])
  }

  function alphaOf(p: ThemePropName): number {
    return colorOf(p)?.a ?? 1
  }

  function fmtA(a: number): string {
    return String(Math.round(Math.min(1, Math.max(0, a)) * 100) / 100)
  }

  /** Set RGB (keeps any existing alpha; handles the shadow's fixed offsets). */
  function setRgb(p: ThemePropName, hex: string): void {
    const a = alphaOf(p)
    const r = parseInt(hex.slice(1, 3), 16), g = parseInt(hex.slice(3, 5), 16), b = parseInt(hex.slice(5, 7), 16)
    if (p === '--shadow-menu') {
      const blur = shadowParts(values[p])?.blur ?? 24
      setValue(p, `0 8px ${Math.round(blur)}px rgba(${r}, ${g}, ${b}, ${fmtA(a)})`)
      return
    }
    if (a >= 1) setValue(p, hex.toUpperCase())
    else setValue(p, `rgba(${r}, ${g}, ${b}, ${fmtA(a)})`)
  }

  function setAlpha(p: ThemePropName, a: number): void {
    const c = colorOf(p)
    if (!c) return
    const rgb = `${Math.round(c.r)}, ${Math.round(c.g)}, ${Math.round(c.b)}`
    if (p === '--shadow-menu') {
      const blur = shadowParts(values[p])?.blur ?? 24
      setValue(p, `0 8px ${Math.round(blur)}px rgba(${rgb}, ${fmtA(a)})`)
      return
    }
    if (a >= 1) setValue(p, hslToHex(colorToHsl(values[p])?.h ?? 0, colorToHsl(values[p])?.s ?? 0, colorToHsl(values[p])?.l ?? 0))
    else setValue(p, `rgba(${rgb}, ${fmtA(a)})`)
  }

  function setBlur(px: number): void {
    const parts = shadowParts(values['--shadow-menu'])
    if (!parts) return
    const c = parts.color
    setValue('--shadow-menu', `0 8px ${Math.round(px)}px rgba(${Math.round(c.r)}, ${Math.round(c.g)}, ${Math.round(c.b)}, ${fmtA(c.a)})`)
  }

  function hslOf(p: ThemePropName): { h: number; s: number; l: number } | null {
    if (p === '--shadow-menu') {
      const parts = shadowParts(values[p])
      return parts ? parsedColorToHsl(parts.color) : null
    }
    return colorToHsl(values[p])
  }

  function hexOfShadow(v: string): string {
    const c = shadowParts(v)?.color
    if (!c) return 'transparent'
    const f = (n: number) => Math.round(n).toString(16).padStart(2, '0').toUpperCase()
    return `#${f(c.r)}${f(c.g)}${f(c.b)}`
  }

  function hslGradient(kind: 'h' | 's' | 'l', hsl: { h: number; s: number; l: number }): string {
    const hslCss = (h: number, s: number, l: number) => `hsl(${h}, ${s}%, ${l}%)`
    if (kind === 'h') {
      const stops = [0, 60, 120, 180, 240, 300, 360].map((h) => hslCss(h, hsl.s, hsl.l)).join(', ')
      return `linear-gradient(to right, ${stops})`
    }
    if (kind === 's') {
      const stops = [0, 50, 100].map((s) => hslCss(hsl.h, s, hsl.l)).join(', ')
      return `linear-gradient(to right, ${stops})`
    }
    const stops = [0, 50, 100].map((l) => hslCss(hsl.h, hsl.s, l)).join(', ')
    return `linear-gradient(to right, ${stops})`
  }

  function onBaseChange(id: BuiltInThemeId): void {
    baseId = id
    const next = readThemeValuesFor(id)
    if (next) {
      values = { ...next }
      lastValid = { ...next }
    }
  }

  function close(): void {
    settings.reapplyTheme()
    onclose()
  }

  function save(): void {
    if (!canSave) return
    if (isNew) {
      const created = createCustomTheme(label, values as ThemeValues)
      if (!created) {
        exportError = t('settings_ctImportFull', { n: MAX_CUSTOM_THEMES })
        return
      }
      settings.setTheme(created.id)
      onimported?.()
    } else {
      upsertCustomTheme({ id: editing.id, label: label.trim(), values: values as ThemeValues })
      settings.setTheme(editing.id)
    }
    onclose()
  }

  function remove(): void {
    if (isNew) return
    deleteCustomTheme(editing.id)
    if (settings.theme === editing.id) settings.setTheme('amethyst')
    onclose()
  }

  async function exportTheme(): Promise<void> {
    if (isNew) return
    exportError = ''
    const json = exportThemeJson(getCustomTheme(editing.id) ?? { ...editing, label: label.trim(), values: values as ThemeValues })
    const slug = label.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'theme'
    try {
      await (window as unknown as {
        __TAURI_INTERNALS__: { invoke(cmd: string, args?: unknown): Promise<unknown> }
      }).__TAURI_INTERNALS__.invoke('save_theme_export', {
        content: json,
        suggestedFilename: 'kappastream-theme-' + slug + '.json',
      })
    } catch (err) {
      if (import.meta.env.DEV) console.error('theme export failed', err)
      exportError = t('settings_ctExportFailed')
    }
  }

  function onKeydown(e: KeyboardEvent): void {
    if (e.key === 'Escape') {
      e.preventDefault()
      if (baseOpen) baseOpen = false
      else if (expanded) expanded = null
      else close()
    }
  }

  $effect(() => {
    document.addEventListener('keydown', onKeydown)
    return () => document.removeEventListener('keydown', onKeydown)
  })

  // Close the base dropdown on any outside pointer press.
  function onDocPointerDown(e: PointerEvent): void {
    const el = e.target as HTMLElement | null
    if (baseOpen && el && !el.closest('.ct-base-wrap')) baseOpen = false
  }
  $effect(() => {
    document.addEventListener('pointerdown', onDocPointerDown)
    return () => document.removeEventListener('pointerdown', onDocPointerDown)
  })

  onDestroy(() => {
    // Safety net: never leave a preview applied after teardown.
    settings.reapplyTheme()
  })
</script>

<div class="ct-backdrop" role="presentation" onpointerdown={(e) => { if (e.target === e.currentTarget) close() }}>
  <div class="ct-panel" role="dialog" aria-modal="true" aria-label={t('settings_customThemes')}>
    <header class="ct-head">
      <h2 class="ct-title">{isNew ? t('settings_ctNew') : t('settings_ctEdit') + ' — ' + editing.label}</h2>
      <button type="button" class="ct-x" onclick={close} aria-label={t('settings_ctClose')}>×</button>
    </header>

    <div class="ct-body">
      {#if isNew}
        <div class="ct-field">
          <span class="ct-field-label">{t('settings_ctDuplicateFrom')}</span>
          <div class="ct-base-wrap">
            <button type="button" class="ct-base-btn" aria-haspopup="listbox" aria-expanded={baseOpen} onclick={() => { baseOpen = !baseOpen }}>
              <span class="ct-base-dot" style="background: {THEMES.find((tm) => tm.id === baseId)?.swatch}"></span>
              <span class="ct-base-label">{THEMES.find((tm) => tm.id === baseId)?.label}</span>
              <svg viewBox="0 0 12 12" width="10" height="10" aria-hidden="true" class="ct-base-chevron" class:ct-base-chevron--open={baseOpen}><path d="M3 5 L6 8 L9 5" stroke="currentColor" stroke-width="1.5" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>
            </button>
            {#if baseOpen}
              <div class="ct-base-menu" role="listbox">
                {#each THEMES as tm (tm.id)}
                  <button type="button" class="ct-base-item" role="option" aria-selected={tm.id === baseId} class:ct-base-item--active={tm.id === baseId} onclick={() => { baseOpen = false; onBaseChange(tm.id) }}>
                    <span class="ct-base-dot" style="background: {tm.swatch}"></span>
                    <span>{tm.label}</span>
                  </button>
                {/each}
              </div>
            {/if}
          </div>
        </div>
      {/if}

      <label class="ct-field">
        <span class="ct-field-label">{t('settings_ctName')}</span>
        <input
          class="ct-name"
          type="text"
          maxlength="40"
          value={label}
          oninput={(e) => { label = (e.currentTarget as HTMLInputElement).value }}
          aria-invalid={!labelValid}
        />
      </label>

      {#each THEME_PROP_GROUPS as group (group.id)}
        <section class="ct-group">
          <h3 class="ct-group-label">
            <span class="ct-group-name">
              {group.id === 'backgrounds' ? t('settings_ctGroupBackgrounds')
                : group.id === 'text' ? t('settings_ctGroupText')
                : group.id === 'accent' ? t('settings_ctGroupAccent')
                : t('settings_ctGroupChrome')}
            </span>
            <button
              type="button"
              class="ct-info"
              use:tooltip={t(GROUP_HELP[group.id])}
              aria-label={t(GROUP_HELP[group.id])}
            >
              <svg viewBox="0 0 24 24" width="11" height="11" aria-hidden="true"><path d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zm0 7a1.25 1.25 0 1 1 0 2.5 1.25 1.25 0 0 1 0-2.5zM10.8 13h2.4v5h-2.4z" fill="currentColor"/></svg>
            </button>
          </h3>
          {#each group.props as p (p)}
            {@const hsl = hslOf(p)}
            {@const help = PROP_HELP[p] ? t(PROP_HELP[p]!) : p}
            <div class="ct-item" class:ct-item--invalid={!valid(p, values[p])}>
              <button
                type="button"
                class="ct-row"
                aria-expanded={expanded === p}
                onclick={() => { expanded = expanded === p ? null : p }}
              >
                <span class="ct-prop" use:tooltip={help}>{PROP_LABEL[p] ? t(PROP_LABEL[p]!) : p}</span>
                <span class="ct-chip" style="background: {p === '--shadow-menu' ? (shadowParts(values[p]) ? hexOfShadow(values[p]) : 'transparent') : values[p]}"></span>
                <span class="ct-value">{values[p]}</span>
                <svg viewBox="0 0 12 12" width="9" height="9" aria-hidden="true" class="ct-row-chevron" class:ct-row-chevron--open={expanded === p}><path d="M3 5 L6 8 L9 5" stroke="currentColor" stroke-width="1.5" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>
              </button>
              {#if expanded === p && hsl}
                <div class="ct-picker">
                  <div class="ct-palette" role="listbox" aria-label={PROP_LABEL[p] ? t(PROP_LABEL[p]!) : p}>
                    {#each THEME_PALETTE as swatch (swatch)}
                      <button
                        type="button"
                        class="ct-swatch"
                        class:ct-swatch--active={hslToHex(hsl.h, hsl.s, hsl.l) === swatch}
                        style="background: {swatch}"
                        onclick={() => setRgb(p, swatch)}
                        aria-label={swatch}
                      ></button>
                    {/each}
                  </div>
                  <div class="ct-sliders">
                    <label class="ct-slider">
                      <span class="ct-slider-tag" style="background: {hslGradient('h', hsl)}">H</span>
                      <input type="range" min="0" max="360" step="1" value={hsl.h}
                        oninput={(e) => setRgb(p, hslToHex(Number((e.currentTarget as HTMLInputElement).value), hsl.s, hsl.l))} />
                    </label>
                    <label class="ct-slider">
                      <span class="ct-slider-tag" style="background: {hslGradient('s', hsl)}">S</span>
                      <input type="range" min="0" max="100" step="1" value={hsl.s}
                        oninput={(e) => setRgb(p, hslToHex(hsl.h, Number((e.currentTarget as HTMLInputElement).value), hsl.l))} />
                    </label>
                    <label class="ct-slider">
                      <span class="ct-slider-tag" style="background: {hslGradient('l', hsl)}">L</span>
                      <input type="range" min="0" max="100" step="1" value={hsl.l}
                        oninput={(e) => setRgb(p, hslToHex(hsl.h, hsl.s, Number((e.currentTarget as HTMLInputElement).value)))} />
                    </label>
                    {#if p === '--shadow-menu' || TRANSLUCENT_PROPS.has(p)}
                      <label class="ct-slider">
                        <span class="ct-slider-tag ct-slider-tag--alpha">A</span>
                        <input type="range" min="0" max="1" step="0.01" value={alphaOf(p)}
                          oninput={(e) => setAlpha(p, Number((e.currentTarget as HTMLInputElement).value))} />
                      </label>
                    {/if}
                    {#if p === '--shadow-menu'}
                      <label class="ct-slider">
                        <span class="ct-slider-tag ct-slider-tag--blur">B {Math.round(shadowParts(values[p])?.blur ?? 24)}px</span>
                        <input type="range" min="0" max="64" step="1" value={shadowParts(values[p])?.blur ?? 24}
                          oninput={(e) => setBlur(Number((e.currentTarget as HTMLInputElement).value))} />
                      </label>
                    {/if}
                  </div>
                </div>
              {/if}
            </div>
          {/each}
        </section>
      {/each}
    </div>

    <footer class="ct-foot">
      <span class="ct-note">{t('settings_ctPreviewNote')}</span>
      {#if exportError}<span class="ct-error" role="status">{exportError}</span>{/if}
      {#if !labelValid && label.length > 0}<span class="ct-error">{t('settings_ctNameMissing')}</span>{/if}
      {#if invalidProps.length > 0}
        <span class="ct-error">{t('settings_ctInvalid')} ({invalidProps.join(', ')})</span>
      {/if}
      <span class="ct-spacer"></span>
      {#if !isNew}
        <button type="button" class="ct-btn" onclick={exportTheme}>{t('settings_ctExport')}</button>
        <button type="button" class="ct-btn ct-btn--danger" onclick={remove}>{t('settings_ctDelete')}</button>
      {/if}
      <button type="button" class="ct-btn" onclick={close}>{t('cancel')}</button>
      <button type="button" class="ct-btn ct-btn--primary" onclick={save} disabled={!canSave}>{t('settings_ctSave')}</button>
    </footer>
  </div>
</div>



<style>
  .ct-backdrop {
    position: fixed;
    inset: 0;
    z-index: 60;
    background: rgba(0, 0, 0, 0.45);
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 16px;
  }
  .ct-panel {
    display: flex;
    flex-direction: column;
    width: min(560px, calc(100vw - 24px));
    max-height: calc(88vh / var(--ui-zoom, 1));
    background: var(--bg-panel);
    border: 1px solid var(--border);
    border-radius: 8px;
    box-shadow: var(--shadow-menu);
    overflow: hidden;
  }
  .ct-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 10px 14px;
    border-bottom: 1px solid var(--border);
  }
  .ct-title {
    margin: 0;
    font-size: 13px;
    font-weight: 700;
    color: var(--text-primary);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .ct-x {
    border: none;
    background: transparent;
    color: var(--text-secondary);
    font-size: 16px;
    line-height: 1;
    cursor: pointer;
    padding: 2px 6px;
    border-radius: 4px;
  }
  .ct-x:hover { background: var(--bg-hover); color: var(--text-primary); }
  .ct-body {
    flex: 1 1 auto;
    overflow-y: auto;
    padding: 10px 14px;
    display: flex;
    flex-direction: column;
    gap: 10px;
  }
  .ct-field {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  .ct-field-label {
    font-size: 11px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: var(--text-secondary);
  }
  .ct-name {
    border: 1px solid var(--border);
    border-radius: 4px;
    background: var(--bg-input);
    color: var(--text-primary);
    font-size: 12px;
    font-family: inherit;
    padding: 6px 8px;
  }
  .ct-name:focus { outline: none; border-color: var(--accent); }
  .ct-name[aria-invalid='true'] { border-color: var(--live); }

  /* Base picker — a plain in-document dropdown (zoom-safe; NO native select,
     whose popup WebKitGTK renders unscaled under documentElement zoom). */
  .ct-base-wrap { position: relative; }
  .ct-base-btn {
    display: flex;
    align-items: center;
    gap: 7px;
    width: 100%;
    border: 1px solid var(--border);
    border-radius: 4px;
    background: var(--bg-input);
    color: var(--text-primary);
    font-size: 12px;
    font-family: inherit;
    padding: 6px 8px;
    cursor: pointer;
    text-align: left;
  }
  .ct-base-btn:hover { border-color: var(--accent); }
  .ct-base-label { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .ct-base-chevron { flex: 0 0 auto; color: var(--text-secondary); transition: transform 150ms; }
  .ct-base-chevron--open { transform: rotate(180deg); }
  .ct-base-menu {
    position: absolute;
    top: calc(100% + 4px);
    left: 0;
    right: 0;
    z-index: 5;
    max-height: 220px;
    overflow-y: auto;
    overscroll-behavior: contain;
    background: var(--bg-panel);
    border: 1px solid var(--border);
    border-radius: 6px;
    box-shadow: var(--shadow-menu);
    padding: 4px 0;
  }
  .ct-base-item {
    display: flex;
    align-items: center;
    gap: 7px;
    width: 100%;
    border: none;
    background: transparent;
    color: var(--text-primary);
    font-size: 12px;
    font-family: inherit;
    padding: 5px 10px;
    cursor: pointer;
    text-align: left;
  }
  .ct-base-item:hover { background: var(--bg-hover); }
  .ct-base-item--active { color: var(--accent); font-weight: 700; }
  .ct-base-dot {
    flex: 0 0 auto;
    width: 14px;
    height: 14px;
    border-radius: 50%;
    border: 1px solid var(--border);
  }

  .ct-group { display: flex; flex-direction: column; gap: 3px; }
  .ct-group-label {
    margin: 4px 0 2px;
    font-size: 10px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: var(--text-dim);
    border-bottom: 1px solid var(--border);
    padding-bottom: 3px;
    display: flex;
    align-items: center;
    gap: 5px;
  }
  .ct-group-name { flex: 0 0 auto; }
  .ct-info {
    flex: 0 0 auto;
    width: 16px;
    height: 16px;
    padding: 0;
    border: none;
    border-radius: 50%;
    background: transparent;
    color: var(--text-dim);
    cursor: help;
    display: inline-flex;
    align-items: center;
    justify-content: center;
  }
  .ct-info:hover { color: var(--text-primary); background: var(--bg-hover-faint); }

  .ct-item {
    border-radius: 5px;
    display: flex;
    flex-direction: column;
  }
  .ct-item--invalid { box-shadow: inset 2px 0 0 var(--live); }
  .ct-row {
    display: flex;
    align-items: center;
    gap: 8px;
    width: 100%;
    border: none;
    background: transparent;
    color: var(--text-primary);
    font-size: 12px;
    font-family: inherit;
    padding: 5px 7px;
    cursor: pointer;
    text-align: left;
    border-radius: 5px;
  }
  .ct-row:hover { background: var(--bg-hover-faint); }
  .ct-prop {
    flex: 0 0 auto;
    max-width: 46%;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-weight: 600;
  }
  .ct-chip {
    flex: 0 0 auto;
    width: 16px;
    height: 16px;
    border-radius: 4px;
    border: 1px solid var(--border);
  }
  .ct-value {
    flex: 1 1 auto;
    min-width: 0;
    font-size: 10px;
    color: var(--text-dim);
    font-family: 'Menlo', 'Consolas', monospace;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    text-align: right;
  }
  .ct-row-chevron { flex: 0 0 auto; color: var(--text-dim); transition: transform 150ms; }
  .ct-row-chevron--open { transform: rotate(180deg); }

  /* Picker: swatch grid + sliders. */
  .ct-picker {
    display: flex;
    flex-direction: column;
    gap: 7px;
    padding: 7px 8px;
    background: var(--bg-input);
    border-radius: 5px;
    margin: 0 4px 4px;
  }
  .ct-palette {
    display: grid;
    grid-template-columns: repeat(15, 1fr);
    gap: 3px;
  }
  .ct-swatch {
    width: 100%;
    aspect-ratio: 1;
    border: 1px solid var(--border);
    border-radius: 3px;
    padding: 0;
    cursor: pointer;
  }
  .ct-swatch:hover { transform: scale(1.15); border-color: var(--text-primary); }
  .ct-swatch--active { border: 2px solid var(--accent); }
  .ct-sliders { display: flex; flex-direction: column; gap: 5px; }
  .ct-slider { display: flex; align-items: center; gap: 7px; }
  .ct-slider-tag {
    flex: 0 0 auto;
    width: 34px;
    height: 14px;
    border-radius: 3px;
    color: #fff;
    font-size: 9px;
    font-weight: 800;
    text-align: center;
    line-height: 14px;
    text-shadow: 0 1px 2px rgba(0, 0, 0, 0.6);
    border: 1px solid var(--border);
    overflow: hidden;
    white-space: nowrap;
  }
  .ct-slider-tag--alpha { width: 34px; background: linear-gradient(to right, #000, var(--text-secondary)); }
  .ct-slider-tag--blur { width: 52px; background: var(--track); text-shadow: none; color: var(--text-primary); }
  .ct-slider input[type='range'] {
    flex: 1 1 auto;
    height: 4px;
    appearance: none;
    -webkit-appearance: none;
    background: var(--track);
    border-radius: 2px;
    cursor: pointer;
  }
  .ct-slider input[type='range']::-webkit-slider-thumb {
    appearance: none;
    -webkit-appearance: none;
    width: 12px;
    height: 12px;
    border-radius: 50%;
    background: var(--text-primary);
    border: 1px solid var(--bg-panel);
  }
  .ct-slider input[type='range']::-moz-range-thumb {
    width: 12px;
    height: 12px;
    border-radius: 50%;
    background: var(--text-primary);
    border: 1px solid var(--bg-panel);
  }

  .ct-foot {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 6px;
    padding: 10px 14px;
    border-top: 1px solid var(--border);
  }
  .ct-note {
    font-size: 10px;
    color: var(--text-dim);
    max-width: 180px;
  }
  .ct-error {
    font-size: 10px;
    color: var(--live);
    max-width: 100%;
    word-break: break-word;
  }
  .ct-spacer { flex: 1 1 auto; }
  .ct-btn {
    border: 1px solid var(--border);
    border-radius: 4px;
    background: transparent;
    color: var(--text-secondary);
    font-size: 11px;
    font-weight: 700;
    font-family: inherit;
    padding: 6px 10px;
    cursor: pointer;
    transition: background 150ms, color 150ms, border-color 150ms;
  }
  .ct-btn:hover:not(:disabled) {
    background: var(--bg-hover);
    color: var(--text-primary);
    border-color: var(--accent);
  }
  .ct-btn:disabled {
    color: var(--text-dim);
    cursor: not-allowed;
    opacity: 0.6;
  }
  .ct-btn--primary {
    background: var(--accent);
    border-color: var(--accent);
    color: var(--text-primary);
  }
  .ct-btn--danger:hover:not(:disabled) {
    color: var(--live);
    border-color: var(--live);
  }
</style>
