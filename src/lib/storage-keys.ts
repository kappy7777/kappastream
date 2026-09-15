/*
 * Central registry of every localStorage key the app uses.
 *
 * Rules of engagement:
 *  - NEVER change a key's string value. localStorage has no migration layer:
 *    renaming a key silently wipes that slice of state for every existing
 *    user on their next launch. Three keys predate the `app-*-v1` convention
 *    (`twitch-favorites-v1`, `twitch-sidebar-visible-v3`,
 *    `fav-notif-channels-v1`) and keep their historical names on purpose;
 *    unifying them is a deliberate future migration, not a refactor.
 *  - Every read/write/remove anywhere under src/ goes through this registry
 *    (enforced by storage-keys.test.ts — no string literals at call sites).
 *    One feature, one key: a duplicate value would mean two features
 *    silently overwriting each other.
 *  - `qualityPrefix` is a namespace, not a full key — per-channel quality
 *    is stored as `qualityPrefix + channel`.
 *  - The `legacy*` entries are migration sources only. They are listed so a
 *    future reader does not reintroduce them as live keys by accident.
 *
 * Having every key enumerated in one place is also what would make a
 * settings export/import (favorites backup already exists) a matter of
 * choosing entries here rather than hunting call sites.
 */
export const STORAGE_KEYS = {
  // ---- Player & playback
  volume: 'app-volume-v1',
  muted: 'app-muted-v1',
  qualityPrefix: 'app-quality:',
  lowLatency: 'app-low-latency-v1',
  vodPositions: 'app-vod-positions-v1',
  pipWindowRect: 'pip-window-rect-v1',

  // ---- Appearance & layout
  theme: 'app-theme-v1',
  customThemes: 'app-custom-themes-v1',
  uiScale: 'app-ui-scale-v1',
  // Historical name (predates the app- prefix); see header note.
  sidebarVisible: 'twitch-sidebar-visible-v3',
  chatSize: 'app-chat-size-v1',

  // ---- Chat
  chatVisible: 'app-chat-visible-v1',
  chatTimestamps: 'app-chat-timestamps-v1',
  mentionUsername: 'app-mention-username-v1',
  // Tier 2 notice toggles (each falls back to legacyChatSubnotices while unset)
  chatNoticesSub: 'app-chat-notices-sub-v1',
  chatNoticesGift: 'app-chat-notices-gift-v1',
  chatNoticesRaid: 'app-chat-notices-raid-v1',
  chatNoticesAnnouncement: 'app-chat-notices-announcement-v1',
  chatRoomstate: 'app-chat-roomstate-v1',
  chatModeration: 'app-chat-moderation-v1',
  chatBits: 'app-chat-bits-v1',
  // Pinned chat messages (gates the fetch itself, unlike the toggles above)
  chatPinned: 'app-chat-pinned-v1',
  chatPinnedDismissed: 'app-chat-pinned-dismissed-v1',
  // Client-side chat mute list
  chatMutedUsers: 'app-chat-muted-v1',

  // ---- Favorites
  // Historical names (predate the app- prefix); see header note.
  favorites: 'twitch-favorites-v1',
  favNotifChannels: 'fav-notif-channels-v1',
  favSortMode: 'app-fav-sort-v1',

  // ---- App behaviour
  closeToTray: 'app-close-to-tray-v1',
  checkUpdates: 'app-check-updates-v1',
  mvStatusBarHidden: 'app-mv-statusbar-hidden-v1',

  // ---- Launch & language
  lastSeenVersion: 'app-last-seen-version-v1',
  locale: 'app-locale-v1',

  // ---- Chat badge art (weekly cache)
  badgeCache: 'app-badge-cache-v1',

  // ---- LEGACY — migration sources only, never write, do not reuse
  // Superseded by the four chatNotices* toggles above; read while unset.
  legacyChatSubnotices: 'app-chat-subnotices-v1',
  // Theater mode no longer persists; removed once on startup.
  legacyTheater: 'app-theater-v1',
} as const

export type StorageKey = (typeof STORAGE_KEYS)[keyof typeof STORAGE_KEYS]
