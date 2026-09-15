export type BuiltInThemeId =
  | 'ayu-mirage'
  | 'blacklight'
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
  | 'hazard'
  | 'cream'
  | 'kanagawa'
  | 'light-purple'
  | 'wine'
  | 'midnight'
  | 'monokai'
  | 'nord'
  | 'one-dark'
  | 'redline'
  | 'riptide'
  | 'rose-pine'
  | 'mint'
  | 'slate'
  | 'solarized'
  | 'solarized-light'
  | 'synthwave'
  | 'orange'
  | 'tokyo-night'
  | 'toxin'
  | 'amethyst'

/**
 * Runtime custom themes live in localStorage under `custom-…` ids (see
 * custom-themes.svelte.ts) — namespaced so they can never collide with a
 * built-in id, and applied by setting the 20 theme properties on the document
 * root instead of a compile-time CSS block.
 */
export type ThemeId = BuiltInThemeId | CustomThemeId

import {
  hasCustomTheme,
  getCustomTheme,
  applyThemeProperties,
  clearThemeProperties,
  type CustomThemeId,
} from './custom-themes.svelte'
import { STORAGE_KEYS } from './storage-keys'

export type SortMode = 'auto' | 'manual'

export interface ThemeMeta {
  id: BuiltInThemeId
  label: string
  swatch: string
}

export const THEMES: ReadonlyArray<ThemeMeta> = [
  { id: 'ayu-mirage', label: 'Ayu Mirage', swatch: '#FFCC66' },
  { id: 'blacklight', label: 'Blacklight', swatch: '#B388FF' },
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
  { id: 'hazard', label: 'Hazard', swatch: '#FF9A3C' },
  { id: 'cream', label: 'Honey', swatch: '#E5A50A' },
  { id: 'kanagawa', label: 'Kanagawa', swatch: '#7E9CD8' },
  { id: 'light-purple', label: 'Light Purple', swatch: '#C49BFF' },
  { id: 'wine', label: 'Merlot', swatch: '#B22D4A' },
  { id: 'midnight', label: 'Midnight', swatch: '#5B8CFF' },
  { id: 'monokai', label: 'Monokai', swatch: '#FD971F' },
  { id: 'nord', label: 'Nord', swatch: '#88C0D0' },
  { id: 'one-dark', label: 'One Dark', swatch: '#61AFEF' },
  { id: 'redline', label: 'Redline', swatch: '#FF6B7A' },
  { id: 'riptide', label: 'Riptide', swatch: '#38B6FF' },
  { id: 'rose-pine', label: 'Rosé Pine', swatch: '#C4A7E7' },
  { id: 'mint', label: 'Sage', swatch: '#3F8B43' },
  { id: 'slate', label: 'Slate', swatch: '#7A6B4B' },
  { id: 'solarized', label: 'Solarized', swatch: '#268BD2' },
  { id: 'solarized-light', label: 'Solarized Light', swatch: '#268BD2' },
  { id: 'synthwave', label: 'Synthwave', swatch: '#FF7ED4' },
  { id: 'orange', label: 'Tangerine', swatch: '#E07414' },
  { id: 'tokyo-night', label: 'Tokyo Night', swatch: '#7AA2F7' },
  { id: 'toxin', label: 'Toxin', swatch: '#46E08A' },
  { id: 'amethyst', label: 'Amethyst', swatch: '#6D5DD3' },
]

// Every persistence key lives in ./storage-keys — the single registry; see
// its header for the never-rename rule. Behavioral notes sit with the
// reader/writer functions below.
export const MAX_MUTED_USERS = 100

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
  const v = safeRead(STORAGE_KEYS.theme)
  if (v) {
    // Custom ids are validated against the runtime registry (they are stored
    // data, not compile-time CSS); an unknown id of either kind falls back.
    if (v.startsWith('custom-')) {
      if (hasCustomTheme(v)) return v as CustomThemeId
      return 'amethyst'
    }
    if (THEMES.some((t) => t.id === v)) return v as BuiltInThemeId
  }
  return 'amethyst'
}

function readChatVisible(): boolean {
  const v = safeRead(STORAGE_KEYS.chatVisible)
  if (v === 'false') return false
  return true
}

function readChatTimestamps(): boolean {
  return safeRead(STORAGE_KEYS.chatTimestamps) === 'true'
}

function readMentionUsername(): string {
  const v = safeRead(STORAGE_KEYS.mentionUsername)
  if (!v) return ''
  return v.toLowerCase().replace(/[^a-z0-9_]/g, '').slice(0, 25)
}

function readVolume(): number {
  const v = safeRead(STORAGE_KEYS.volume)
  if (!v) return 1
  const n = parseFloat(v)
  return Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : 1
}

function readMuted(): boolean {
  const v = safeRead(STORAGE_KEYS.muted)
  return v === 'true'
}

function readLowLatency(): boolean {
  return safeRead(STORAGE_KEYS.lowLatency) === 'true'
}

function readCloseToTray(): boolean {
  // Default ON: the whole point of the tray is background notifications,
  // so close-to-tray is the expected behavior out of the box. Users who
  // want close-to-quit disable it in Settings.
  return safeRead(STORAGE_KEYS.closeToTray) !== 'false'
}

function readCheckUpdates(): boolean {
  // Default ON: the updater check has run on every launch since v0.2.6. Only
  // an explicit 'false' opts out — this is the one outbound request that is
  // not a direct consequence of a user action, so it's the one worth gating.
  // On an AUR build the updater plugins are unregistered, so `check()` is a
  // no-op regardless of this setting — the toggle is simply inert there.
  return safeRead(STORAGE_KEYS.checkUpdates) !== 'false'
}

// Tier 2 chat-feature toggles — all default ON (flipped from opt-in after the
// experiment settled). Opt-outs survive: only an explicit 'false' counts, the
// same convention as every other default-on reader (junk → default). The old
// single sub/raid toggle was SPLIT into four individually togglable notice
// groups; each new key falls back to the legacy key while unset (a legacy
// 'false' keeps that user's notices off), and only when both keys are unset
// does the ON default apply.
function readChatNoticeGroup(key: string): boolean {
  const own = safeRead(key)
  if (own !== null) return own !== 'false'
  const legacy = safeRead(STORAGE_KEYS.legacyChatSubnotices)
  if (legacy !== null) return legacy !== 'false'
  return true
}
function readChatNoticesSub(): boolean {
  return readChatNoticeGroup(STORAGE_KEYS.chatNoticesSub)
}
function readChatNoticesGift(): boolean {
  return readChatNoticeGroup(STORAGE_KEYS.chatNoticesGift)
}
function readChatNoticesRaid(): boolean {
  return readChatNoticeGroup(STORAGE_KEYS.chatNoticesRaid)
}
function readChatNoticesAnnouncement(): boolean {
  return readChatNoticeGroup(STORAGE_KEYS.chatNoticesAnnouncement)
}
function readChatRoomstate(): boolean {
  return safeRead(STORAGE_KEYS.chatRoomstate) !== 'false'
}
function readChatModeration(): boolean {
  return safeRead(STORAGE_KEYS.chatModeration) !== 'false'
}
function readChatBits(): boolean {
  return safeRead(STORAGE_KEYS.chatBits) !== 'false'
}
function readChatPinned(): boolean {
  // Unlike the Tier 2 toggles above (parse always, gate only rendering), this
  // one gates the FETCH itself: with it off, no pinned-message GQL query is
  // issued at all.
  return safeRead(STORAGE_KEYS.chatPinned) === 'true'
}

function readMvStatusBarHidden(): boolean {
  return safeRead(STORAGE_KEYS.mvStatusBarHidden) === 'true'
}

// Normalize a user-entered mute entry to a lowercase login, or null if it has
// no usable characters (empty / whitespace / punctuation). Mirrors the lenient
// cleaning used for the mention username so pasting "@Troll!" yields "troll".
function normalizeMutedName(raw: string): string | null {
  const cleaned = raw.toLowerCase().replace(/[^a-z0-9_]/g, '').slice(0, 25)
  return cleaned.length >= 1 ? cleaned : null
}

function readMutedUsers(): string[] {
  // Client-side chat mute list. Matching is done on the STABLE `login` field
  // (never display-name — user-settable capitalization, the same trap
  // CLEARCHAT avoids — and never userId, which would need a network call the
  // read-only posture forbids). Cap keeps localStorage bounded.
  try {
    const raw = localStorage.getItem(STORAGE_KEYS.chatMutedUsers)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    const out: string[] = []
    const seen = new Set<string>()
    for (const item of parsed) {
      if (typeof item !== 'string') continue
      const n = normalizeMutedName(item)
      if (!n || seen.has(n)) continue
      seen.add(n)
      out.push(n)
      if (out.length >= MAX_MUTED_USERS) break
    }
    return out
  } catch {
    return []
  }
}

function readSortMode(): SortMode {
  const v = safeRead(STORAGE_KEYS.favSortMode)
  return v === 'manual' ? 'manual' : 'auto'
}

function clampUiScale(n: number): number {
  if (!Number.isFinite(n)) return UI_SCALE_DEFAULT
  return Math.max(UI_SCALE_MIN, Math.min(UI_SCALE_MAX, Math.round(n / UI_SCALE_STEP) * UI_SCALE_STEP))
}

function readUiScale(): number {
  const v = safeRead(STORAGE_KEYS.uiScale)
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
  checkUpdates: boolean = $state(readCheckUpdates())
  chatNoticesSub: boolean = $state(readChatNoticesSub())
  chatNoticesGift: boolean = $state(readChatNoticesGift())
  chatNoticesRaid: boolean = $state(readChatNoticesRaid())
  chatNoticesAnnouncement: boolean = $state(readChatNoticesAnnouncement())
  chatRoomstate: boolean = $state(readChatRoomstate())
  chatModeration: boolean = $state(readChatModeration())
  chatBits: boolean = $state(readChatBits())
  chatPinned: boolean = $state(readChatPinned())
  mvStatusBarHidden: boolean = $state(readMvStatusBarHidden())
  // Client-side chat mute list (logins). Reactive so adding/removing an entry
  // re-renders messages already in the buffer — same "gate presentation, not
  // parsing" architecture as the Tier 2 toggles.
  mutedUsers: string[] = $state(readMutedUsers())
  theaterMode: boolean = $state(false)

  constructor() {
    this.applyTheme(this.theme)
    this.applyUiScale(this.uiScale)
    try { localStorage.removeItem(STORAGE_KEYS.legacyTheater) } catch { /* ignore */ }
  }

  /**
   * Apply a theme id: sets data-theme (built-ins match their compile-time CSS
   * block; a custom id matches none, so the `:root` defaults hold underneath)
   * and — for a custom theme ONLY — writes the 20 validated properties onto
   * the document root as inline style. Switching to any built-in removes
   * every inline property again, so built-in themes stay byte-identical.
   */
  private applyTheme(id: ThemeId): void {
    if (typeof document === 'undefined') return
    document.documentElement.dataset.theme = id
    if (id.startsWith('custom-')) {
      const theme = getCustomTheme(id)
      if (theme) applyThemeProperties(theme.values)
      else clearThemeProperties()
    } else {
      clearThemeProperties()
    }
  }

  /** Re-apply the current theme (used after a live-preview editor closes). */
  reapplyTheme(): void {
    this.applyTheme(this.theme)
  }

  private applyUiScale(v: number): void {
    if (typeof document !== 'undefined') {
      document.documentElement.style.zoom = String(v)
    }
  }

  setTheme(id: ThemeId): void {
    this.theme = id
    safeWrite(STORAGE_KEYS.theme, id)
    this.applyTheme(id)
  }

  setChatVisible(v: boolean): void {
    this.chatVisible = v
    safeWrite(STORAGE_KEYS.chatVisible, v ? 'true' : 'false')
  }

  toggleChatVisible(): void {
    this.setChatVisible(!this.chatVisible)
  }

  setChatTimestamps(v: boolean): void {
    this.chatTimestamps = v
    safeWrite(STORAGE_KEYS.chatTimestamps, v ? 'true' : 'false')
  }

  toggleChatTimestamps(): void {
    this.setChatTimestamps(!this.chatTimestamps)
  }

  setMentionUsername(v: string): void {
    const cleaned = v.toLowerCase().replace(/[^a-z0-9_]/g, '').slice(0, 25)
    if (cleaned === this.mentionUsername) return
    this.mentionUsername = cleaned
    safeWrite(STORAGE_KEYS.mentionUsername, cleaned)
  }

  setVolume(v: number): void {
    const clamped = Math.max(0, Math.min(1, v))
    this.volume = clamped
    safeWrite(STORAGE_KEYS.volume, String(clamped))
    if (clamped > 0 && this.muted) {
      this.muted = false
      safeWrite(STORAGE_KEYS.muted, 'false')
    }
  }

  setMuted(m: boolean): void {
    this.muted = m
    safeWrite(STORAGE_KEYS.muted, m ? 'true' : 'false')
  }

  toggleMuted(): void {
    this.setMuted(!this.muted)
  }

  setLowLatency(v: boolean): void {
    this.lowLatency = v
    safeWrite(STORAGE_KEYS.lowLatency, v ? 'true' : 'false')
  }

  toggleLowLatency(): void {
    this.setLowLatency(!this.lowLatency)
  }

  setCloseToTray(v: boolean): void {
    this.closeToTray = v
    safeWrite(STORAGE_KEYS.closeToTray, v ? 'true' : 'false')
  }

  toggleCloseToTray(): void {
    this.setCloseToTray(!this.closeToTray)
  }

  setCheckUpdates(v: boolean): void {
    this.checkUpdates = v
    safeWrite(STORAGE_KEYS.checkUpdates, v ? 'true' : 'false')
  }

  toggleCheckUpdates(): void {
    this.setCheckUpdates(!this.checkUpdates)
  }

  setChatNoticesSub(v: boolean): void {
    this.chatNoticesSub = v
    safeWrite(STORAGE_KEYS.chatNoticesSub, v ? 'true' : 'false')
  }

  toggleChatNoticesSub(): void {
    this.setChatNoticesSub(!this.chatNoticesSub)
  }

  setChatNoticesGift(v: boolean): void {
    this.chatNoticesGift = v
    safeWrite(STORAGE_KEYS.chatNoticesGift, v ? 'true' : 'false')
  }

  toggleChatNoticesGift(): void {
    this.setChatNoticesGift(!this.chatNoticesGift)
  }

  setChatNoticesRaid(v: boolean): void {
    this.chatNoticesRaid = v
    safeWrite(STORAGE_KEYS.chatNoticesRaid, v ? 'true' : 'false')
  }

  toggleChatNoticesRaid(): void {
    this.setChatNoticesRaid(!this.chatNoticesRaid)
  }

  setChatNoticesAnnouncement(v: boolean): void {
    this.chatNoticesAnnouncement = v
    safeWrite(STORAGE_KEYS.chatNoticesAnnouncement, v ? 'true' : 'false')
  }

  toggleChatNoticesAnnouncement(): void {
    this.setChatNoticesAnnouncement(!this.chatNoticesAnnouncement)
  }

  setChatRoomstate(v: boolean): void {
    this.chatRoomstate = v
    safeWrite(STORAGE_KEYS.chatRoomstate, v ? 'true' : 'false')
  }

  toggleChatRoomstate(): void {
    this.setChatRoomstate(!this.chatRoomstate)
  }

  setChatModeration(v: boolean): void {
    this.chatModeration = v
    safeWrite(STORAGE_KEYS.chatModeration, v ? 'true' : 'false')
  }

  toggleChatModeration(): void {
    this.setChatModeration(!this.chatModeration)
  }

  setChatBits(v: boolean): void {
    this.chatBits = v
    safeWrite(STORAGE_KEYS.chatBits, v ? 'true' : 'false')
  }

  toggleChatBits(): void {
    this.setChatBits(!this.chatBits)
  }

  setChatPinned(v: boolean): void {
    this.chatPinned = v
    safeWrite(STORAGE_KEYS.chatPinned, v ? 'true' : 'false')
  }

  toggleChatPinned(): void {
    this.setChatPinned(!this.chatPinned)
  }

  setMvStatusBarHidden(v: boolean): void {
    this.mvStatusBarHidden = v
    safeWrite(STORAGE_KEYS.mvStatusBarHidden, v ? 'true' : 'false')
  }

  toggleMvStatusBarHidden(): void {
    this.setMvStatusBarHidden(!this.mvStatusBarHidden)
  }

  // ---- Chat mute list -----------------------------------------------------
  // Add a login to the mute list. Returns the normalized login actually added
  // (null if the input was empty/whitespace or already present). A login past
  // the cap is rejected with the list unchanged so the caller can surface it.
  addMutedUser(raw: string): string | null {
    const n = normalizeMutedName(raw)
    if (!n) return null
    if (this.mutedUsers.includes(n)) return null
    if (this.mutedUsers.length >= MAX_MUTED_USERS) return null
    this.mutedUsers = [...this.mutedUsers, n]
    safeWrite(STORAGE_KEYS.chatMutedUsers, JSON.stringify(this.mutedUsers))
    return n
  }

  removeMutedUser(raw: string): void {
    const n = normalizeMutedName(raw)
    if (!n) return
    if (!this.mutedUsers.includes(n)) return
    this.mutedUsers = this.mutedUsers.filter((u) => u !== n)
    safeWrite(STORAGE_KEYS.chatMutedUsers, JSON.stringify(this.mutedUsers))
  }

  // True if `login` is in the mute list. `login` is the PRIVMSG sender's login
  // (lowercased IRC nick) — the stable identity. An empty/null login (e.g. an
  // anon USERNOTICE) never matches, so it is shown (safe fallback: we cannot
  // identify it to hide it).
  isMuted(login: string | null | undefined): boolean {
    if (!login) return false
    const n = normalizeMutedName(login)
    if (!n) return false
    return this.mutedUsers.includes(n)
  }

  setSortMode(m: SortMode): void {
    this.sortMode = m
    safeWrite(STORAGE_KEYS.favSortMode, m)
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
    safeWrite(STORAGE_KEYS.uiScale, String(clamped))
    this.applyUiScale(clamped)
  }

  resetUiScale(): void {
    this.setUiScale(UI_SCALE_DEFAULT)
  }

  toggleTheaterMode(): void {
    this.setTheaterMode(!this.theaterMode)
  }

  getQualityFor(channel: string): string | null {
    const v = safeRead(STORAGE_KEYS.qualityPrefix + channel.toLowerCase())
    return v
  }

  setQualityFor(channel: string, quality: string): void {
    safeWrite(STORAGE_KEYS.qualityPrefix + channel.toLowerCase(), quality)
  }
}

export const settings = new SettingsStore()