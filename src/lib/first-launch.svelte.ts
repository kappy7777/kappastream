// First-launch detection: decide whether to show the welcome (first install)
// or what's-new (updated) screen, or nothing at all.
//
// The stored `lastSeenVersion` is written ONLY when the screen is DISMISSED —
// never when it is shown — so a crash or force-quit before dismissal re-shows
// the screen on the next launch instead of silently skipping it.
//
// Decision table:
//   no stored version / corrupt → FIRST INSTALL → welcome
//   stored  < current           → UPDATED       → what's new
//   stored === current          → normal        → nothing
//   stored  > current           → DOWNGRADE     → nothing (never nag backwards)
//
// Reuses `isVersionNewer` from version.ts (the same core-only semver compare
// the updater's downgrade guard uses) rather than forking the comparison. Its
// core-only prerelease handling means an rc→stable transition of the SAME
// core is treated as "equal" (no what's-new screen) — see the note on
// `classifyLaunch` below. This is benign for kappastream: rc tags are
// throwaway updater smoke-test builds and an rc user has already seen those
// features; the owner is the only rc audience.

import { isVersionNewer } from './version'

declare const __APP_VERSION__: string

// Follows the settings-store `app-*-v1` key convention (settings.svelte.ts).
const LAST_SEEN_VERSION_KEY = 'app-last-seen-version-v1'

export type LaunchScreen = 'welcome' | 'whats-new' | null

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

/** Read the last version the user dismissed a launch screen for (or null). */
export function readLastSeenVersion(): string | null {
  return safeRead(LAST_SEEN_VERSION_KEY)
}

/** Record `version` as seen. Called on dismissal, never on show. */
export function writeLastSeenVersion(version: string): void {
  safeWrite(LAST_SEEN_VERSION_KEY, version)
}

// A parseable SemVer-core prefix — mirrors `parseCore` in version.ts so the
// corrupt-version check stays in lockstep with the comparator's parser.
const CORE_RE = /^\d+\.\d+\.\d+/

/**
 * Pure decision function: which launch screen (if any) qualifies for this run.
 *
 *   no stored / corrupt → 'welcome' (first install)
 *   stored === current  → null        (normal launch)
 *   current > stored    → 'whats-new' (updated)
 *   current < stored    → null        (downgrade — show nothing)
 *
 * Corrupt / non-parseable stored data degrades to first install rather than
 * throwing, so a hand-edited garbage value in localStorage never breaks startup.
 *
 * Prerelease note: `isVersionNewer` is core-only, so a stored `1.2.3-rc1`
 * against a current `1.2.3` reads as equal → null (no what's-new). That is
 * intentional and reported: rc→stable of the same core does not re-show notes.
 */
export function classifyLaunch(currentVersion: string, stored: string | null): LaunchScreen {
  // No stored version → first install.
  if (stored === null) return 'welcome'
  // Corrupt / non-parseable stored value → degrade to first install.
  if (!CORE_RE.test(stored)) return 'welcome'
  // Same version → normal launch.
  if (stored === currentVersion) return null
  // Build is newer than last seen → updated → what's new.
  if (isVersionNewer(currentVersion, stored)) return 'whats-new'
  // Build is older than last seen (downgrade). Never nag backwards.
  return null
}

class FirstLaunchStore {
  // What THIS launch qualifies as. Fixed for the process — computed once from
  // localStorage + __APP_VERSION__ and never mutated. null on a normal launch
  // (stored === current), so the overlay renders nothing and startup is
  // byte-identical for a user who has already seen this version's screen.
  screen: LaunchScreen = $state(classifyLaunch(__APP_VERSION__, readLastSeenVersion()))
  // Whether the screen is currently shown (true until dismissed this session).
  shown = $state(true)

  get visible(): boolean {
    return this.screen !== null && this.shown
  }

  // Dismiss the screen and record the current version as seen. Writing on
  // dismissal — not on show — means a crash before dismissal re-shows next
  // launch (the version is only persisted once the user actually interacts).
  dismiss(): void {
    writeLastSeenVersion(__APP_VERSION__)
    this.shown = false
  }
}

export const firstLaunch = new FirstLaunchStore()

// ---- Streamlink presence probe (welcome screen only) ----------------------
//
// The welcome screen asks the Rust `streamlink_status` command whether
// streamlink is installed and WHICH platform it's running on, so it can show
// the platform-appropriate install command (pacman/apt/dnf on Linux, brew on
// macOS, pip on Windows) ONLY when streamlink is actually missing. The
// response → UI-state mapping is pure so the "present ⇒ never show install
// commands" guarantee is unit-testable without mounting the component (the
// probe's checking/unknown lifecycle states are owned by the component; this
// handles only the resolved result).

export type StreamlinkProbeState = 'present' | 'missing'

export interface StreamlinkProbeResult {
  state: StreamlinkProbeState
  platform: string
}

/**
 * Map a `streamlink_status` response to the welcome screen's resolved state.
 * A present install ALWAYS resolves to 'present' — the install-commands block
 * is only ever rendered for 'missing', so a working setup is never nagged. The
 * platform is passed through so the component can pick the right command.
 */
export function streamlinkProbeFromResult(r: {
  present: boolean
  platform: string
}): StreamlinkProbeResult {
  return { state: r.present ? 'present' : 'missing', platform: r.platform }
}
