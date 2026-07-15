export type ThemeId =
  | 'ayu-mirage'
  | 'catppuccin'
  | 'catppuccin-latte'
  | 'azure'
  | 'crimson'
  | 'pearl'
  | 'dark-purple'
  | 'dracula'
  | 'blush'
  | 'forest'
  | 'gruvbox'
  | 'gruvbox-light'
  | 'cream'
  | 'kanagawa'
  | 'light-purple'
  | 'wine'
  | 'midnight'
  | 'monokai'
  | 'nord'
  | 'one-dark'
  | 'rose-pine'
  | 'mint'
  | 'slate'
  | 'solarized'
  | 'solarized-light'
  | 'synthwave'
  | 'orange'
  | 'tokyo-night'
  | 'twitch'

export type SortMode = 'auto' | 'manual'

export interface ThemeMeta {
  id: ThemeId
  label: string
  swatch: string
}

export const THEMES: ReadonlyArray<ThemeMeta> = [
  { id: 'ayu-mirage', label: 'Ayu Mirage', swatch: '#FFCC66' },
  { id: 'catppuccin', label: 'Catppuccin', swatch: '#CBA6F7' },
  { id: 'catppuccin-latte', label: 'Catppuccin Latte', swatch: '#8839EF' },
  { id: 'azure', label: 'Cornflower', swatch: '#2E70C7' },
  { id: 'crimson', label: 'Crimson', swatch: '#E5484D' },
  { id: 'pearl', label: 'Copper', swatch: '#B85E2F' },
  { id: 'dark-purple', label: 'Dark Purple', swatch: '#8A3FE0' },
  { id: 'dracula', label: 'Dracula', swatch: '#BD93F9' },
  { id: 'blush', label: 'Dusty Rose', swatch: '#CC4858' },
  { id: 'forest', label: 'Forest', swatch: '#3FB27F' },
  { id: 'gruvbox', label: 'Gruvbox', swatch: '#FABD2F' },
  { id: 'gruvbox-light', label: 'Gruvbox Light', swatch: '#D65D0E' },
  { id: 'cream', label: 'Honey', swatch: '#E5A50A' },
  { id: 'kanagawa', label: 'Kanagawa', swatch: '#7E9CD8' },
  { id: 'light-purple', label: 'Light Purple', swatch: '#C49BFF' },
  { id: 'wine', label: 'Merlot', swatch: '#B22D4A' },
  { id: 'midnight', label: 'Midnight', swatch: '#5B8CFF' },
  { id: 'monokai', label: 'Monokai', swatch: '#FD971F' },
  { id: 'nord', label: 'Nord', swatch: '#88C0D0' },
  { id: 'one-dark', label: 'One Dark', swatch: '#61AFEF' },
  { id: 'rose-pine', label: 'Rosé Pine', swatch: '#C4A7E7' },
  { id: 'mint', label: 'Sage', swatch: '#3F8B43' },
  { id: 'slate', label: 'Slate', swatch: '#7A6B4B' },
  { id: 'solarized', label: 'Solarized', swatch: '#268BD2' },
  { id: 'solarized-light', label: 'Solarized Light', swatch: '#268BD2' },
  { id: 'synthwave', label: 'Synthwave', swatch: '#FF7ED4' },
  { id: 'orange', label: 'Tangerine', swatch: '#E07414' },
  { id: 'tokyo-night', label: 'Tokyo Night', swatch: '#7AA2F7' },
  { id: 'twitch', label: 'Twitch', swatch: '#9147FF' },
]

const THEME_KEY = 'app-theme-v1'
const CHAT_VISIBLE_KEY = 'app-chat-visible-v1'
const CHAT_TIMESTAMPS_KEY = 'app-chat-timestamps-v1'
const MENTION_USERNAME_KEY = 'app-mention-username-v1'
const VOLUME_KEY = 'app-volume-v1'
const MUTED_KEY = 'app-muted-v1'
const QUALITY_PREFIX = 'app-quality:'
const UI_SCALE_KEY = 'app-ui-scale-v1'
const LOW_LATENCY_KEY = 'app-low-latency-v1'
const CLOSE_TO_TRAY_KEY = 'app-close-to-tray-v1'

export const UI_SCALE_MIN = 0.5
export const UI_SCALE_MAX = 4
export const UI_SCALE_STEP = 0.05
export const UI_SCALE_DEFAULT = 1
export const UI_SCALE_PRESETS: ReadonlyArray<number> = [
  0.5, 0.75, 1, 1.25, 1.5, 2, 2.5, 3, 4,
] as const

function safeRead(key: string): string | null {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

function safeWrite(key: string, value: string): void {
  try {
    localStorage.setItem(key, value)
  } catch {
    /* ignore */
  }
}

function readTheme(): ThemeId {
  const v = safeRead(THEME_KEY)
  if (v && THEMES.some((t) => t.id === v)) return v as ThemeId
  return 'twitch'
}

function readChatVisible(): boolean {
  const v = safeRead(CHAT_VISIBLE_KEY)
  if (v === 'false') return false
  return true
}

function readChatTimestamps(): boolean {
  return safeRead(CHAT_TIMESTAMPS_KEY) === 'true'
}

function readMentionUsername(): string {
  const v = safeRead(MENTION_USERNAME_KEY)
  if (!v) return ''
  return v.toLowerCase().replace(/[^a-z0-9_]/g, '').slice(0, 25)
}

function readVolume(): number {
  const v = safeRead(VOLUME_KEY)
  if (!v) return 1
  const n = parseFloat(v)
  return Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : 1
}

function readMuted(): boolean {
  const v = safeRead(MUTED_KEY)
  return v === 'true'
}

function readLowLatency(): boolean {
  return safeRead(LOW_LATENCY_KEY) === 'true'
}

function readCloseToTray(): boolean {
  // Default ON: the whole point of the tray is background notifications,
  // so close-to-tray is the expected behavior out of the box. Users who
  // want close-to-quit disable it in Settings.
  return safeRead(CLOSE_TO_TRAY_KEY) !== 'false'
}

const SORT_MODE_KEY = 'app-fav-sort-v1'

function readSortMode(): SortMode {
  const v = safeRead(SORT_MODE_KEY)
  return v === 'manual' ? 'manual' : 'auto'
}

function clampUiScale(n: number): number {
  if (!Number.isFinite(n)) return UI_SCALE_DEFAULT
  return Math.max(UI_SCALE_MIN, Math.min(UI_SCALE_MAX, Math.round(n / UI_SCALE_STEP) * UI_SCALE_STEP))
}

function readUiScale(): number {
  const v = safeRead(UI_SCALE_KEY)
  if (!v) return UI_SCALE_DEFAULT
  return clampUiScale(parseFloat(v))
}

class SettingsStore {
  theme: ThemeId = $state(readTheme())
  chatVisible: boolean = $state(readChatVisible())
  chatTimestamps: boolean = $state(readChatTimestamps())
  mentionUsername: string = $state(readMentionUsername())
  volume: number = $state(readVolume())
  muted: boolean = $state(readMuted())
  sortMode: SortMode = $state(readSortMode())
  uiScale: number = $state(readUiScale())
  lowLatency: boolean = $state(readLowLatency())
  closeToTray: boolean = $state(readCloseToTray())
  theaterMode: boolean = $state(false)

  constructor() {
    this.applyThemeAttr(this.theme)
    this.applyUiScale(this.uiScale)
    try { localStorage.removeItem('app-theater-v1') } catch { /* ignore */ }
  }

  private applyThemeAttr(id: ThemeId): void {
    if (typeof document !== 'undefined') {
      document.documentElement.dataset.theme = id
    }
  }

  private applyUiScale(v: number): void {
    if (typeof document !== 'undefined') {
      document.documentElement.style.zoom = String(v)
    }
  }

  setTheme(id: ThemeId): void {
    this.theme = id
    safeWrite(THEME_KEY, id)
    this.applyThemeAttr(id)
  }

  setChatVisible(v: boolean): void {
    this.chatVisible = v
    safeWrite(CHAT_VISIBLE_KEY, v ? 'true' : 'false')
  }

  toggleChatVisible(): void {
    this.setChatVisible(!this.chatVisible)
  }

  setChatTimestamps(v: boolean): void {
    this.chatTimestamps = v
    safeWrite(CHAT_TIMESTAMPS_KEY, v ? 'true' : 'false')
  }

  toggleChatTimestamps(): void {
    this.setChatTimestamps(!this.chatTimestamps)
  }

  setMentionUsername(v: string): void {
    const cleaned = v.toLowerCase().replace(/[^a-z0-9_]/g, '').slice(0, 25)
    if (cleaned === this.mentionUsername) return
    this.mentionUsername = cleaned
    safeWrite(MENTION_USERNAME_KEY, cleaned)
  }

  setVolume(v: number): void {
    const clamped = Math.max(0, Math.min(1, v))
    this.volume = clamped
    safeWrite(VOLUME_KEY, String(clamped))
    if (clamped > 0 && this.muted) {
      this.muted = false
      safeWrite(MUTED_KEY, 'false')
    }
  }

  setMuted(m: boolean): void {
    this.muted = m
    safeWrite(MUTED_KEY, m ? 'true' : 'false')
  }

  toggleMuted(): void {
    this.setMuted(!this.muted)
  }

  setLowLatency(v: boolean): void {
    this.lowLatency = v
    safeWrite(LOW_LATENCY_KEY, v ? 'true' : 'false')
  }

  toggleLowLatency(): void {
    this.setLowLatency(!this.lowLatency)
  }

  setCloseToTray(v: boolean): void {
    this.closeToTray = v
    safeWrite(CLOSE_TO_TRAY_KEY, v ? 'true' : 'false')
  }

  toggleCloseToTray(): void {
    this.setCloseToTray(!this.closeToTray)
  }

  setSortMode(m: SortMode): void {
    this.sortMode = m
    safeWrite(SORT_MODE_KEY, m)
  }

  toggleSortMode(): void {
    this.setSortMode(this.sortMode === 'auto' ? 'manual' : 'auto')
  }

  setTheaterMode(v: boolean): void {
    this.theaterMode = v
  }

  setUiScale(v: number): void {
    const clamped = clampUiScale(v)
    if (clamped === this.uiScale) return
    this.uiScale = clamped
    safeWrite(UI_SCALE_KEY, String(clamped))
    this.applyUiScale(clamped)
  }

  resetUiScale(): void {
    this.setUiScale(UI_SCALE_DEFAULT)
  }

  toggleTheaterMode(): void {
    this.setTheaterMode(!this.theaterMode)
  }

  getQualityFor(channel: string): string | null {
    const v = safeRead(QUALITY_PREFIX + channel.toLowerCase())
    return v
  }

  setQualityFor(channel: string, quality: string): void {
    safeWrite(QUALITY_PREFIX + channel.toLowerCase(), quality)
  }
}

export const settings = new SettingsStore()