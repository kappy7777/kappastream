// In-app self-update store (tauri-plugin-updater).
//
// Behaviour contract (see the updater task):
//   • Checks for an update on startup, non-blocking.
//   • A FAILED check is ALWAYS silent — a network hiccup, a 404 on
//     latest.json, or the plugin being unregistered (AUR build, where the
//     `updater` Cargo feature is off) must never surface any UI. Errors are
//     logged to the console only.
//   • When an update exists, the banner shows the new version and waits for an
//     explicit click. Nothing auto-downloads; nothing auto-installs.
//
// On an AUR build the updater + process plugins are not registered, so
// `check()` rejects with "plugin ... not found" immediately — caught here and
// swallowed. No AUR user ever sees a prompt (pacman owns updates there).
import { check, type Update } from '@tauri-apps/plugin-updater'
import { relaunch } from '@tauri-apps/plugin-process'
import { isTauri } from '@tauri-apps/api/core'
import { isVersionNewer } from './version'

export type UpdateStatus =
  | 'idle' // no update / not yet checked / check failed silently
  | 'available' // an update is waiting for an explicit click
  | 'downloading'
  | 'installing'
  | 'restart' // installed, but the automatic relaunch failed — manual restart needed
  | 'error' // download/install/verify failed (only after a user click)

interface UpdateState {
  status: UpdateStatus
  version: string | null
  currentVersion: string | null
  notes: string | null
  pubDate: string | null
  downloaded: number
  contentLength: number
  errorMsg: string | null
  dismissed: boolean
}

class UpdateStore {
  status = $state<UpdateStatus>('idle')
  version = $state<string | null>(null)
  currentVersion = $state<string | null>(null)
  notes = $state<string | null>(null)
  pubDate = $state<string | null>(null)
  downloaded = $state(0)
  contentLength = $state(0)
  errorMsg = $state<string | null>(null)
  dismissed = $state(false)
  /** Held between check() and apply() — the resolved Update handle. */
  private pending: Update | null = null

  get visible(): boolean {
    return (
      !this.dismissed &&
      (this.status === 'available' ||
        this.status === 'downloading' ||
        this.status === 'installing' ||
        this.status === 'restart' ||
        this.status === 'error')
    )
  }

  /** Whether the busy states should hide the dismiss (×) control. */
  get busy(): boolean {
    return this.status === 'downloading' || this.status === 'installing'
  }

  /** Fraction downloaded in [0,1], or null while unknown. */
  get fraction(): number | null {
    if (this.contentLength > 0) return Math.min(1, this.downloaded / this.contentLength)
    return null
  }

  /** Check for an update. Silent on every failure path (see file header). */
  async check(): Promise<void> {
    if (!isTauri()) return
    try {
      const update = await check({ timeout: 20000 })
      if (update && isVersionNewer(update.version, update.currentVersion)) {
        this.pending = update
        this.version = update.version
        this.currentVersion = update.currentVersion
        this.notes = update.body ?? null
        this.pubDate = update.date ?? null
        this.status = 'available'
        this.dismissed = false
        this.errorMsg = null
      } else if (update) {
        // Downgrade guard: the plugin normally returns null for an equal/older
        // version, but treat a non-null older/equal result as "no update" too.
        // A malformed or retagged latest.json must never walk an install back to
        // an older legitimately-signed build — signature verification would not
        // catch that, since every archived release is signed by the same key.
        console.warn(`[update] ignoring non-newer version ${update.version} (current ${update.currentVersion})`)
      }
      // else: no update available — stay idle, no UI.
    } catch (err) {
      // Silent. Network error, endpoint 404, or AUR (plugin unregistered).
      console.warn('[update] check failed (silent):', err)
    }
  }

  /** User clicked "Update". Downloads, verifies, installs, then relaunches. */
  async apply(): Promise<void> {
    const update = this.pending
    if (!update || this.busy) return
    this.status = 'downloading'
    this.downloaded = 0
    this.contentLength = 0
    this.errorMsg = null
    try {
      await update.downloadAndInstall((event) => {
        switch (event.event) {
          case 'Started':
            this.contentLength = event.data.contentLength ?? 0
            this.status = 'downloading'
            break
          case 'Progress':
            this.downloaded += event.data.chunkLength
            break
          case 'Finished':
            this.status = 'installing'
            break
        }
      })
      // On Windows the NSIS installer exits the app during install, so this
      // line is reached only on Linux (AppImage/.deb/.rpm). Relaunch there;
      // if it fails the update IS installed but the old process is still
      // running — switch to the restart state so the banner says so instead
      // of spinning on "Installing" for the rest of the session.
      this.status = 'installing'
      try {
        await relaunch()
      } catch (err) {
        console.warn('[update] relaunch failed (manual restart needed):', err)
        this.status = 'restart'
      }
    } catch (err) {
      console.error('[update] download/install failed:', err)
      this.status = 'error'
      this.errorMsg = err instanceof Error ? err.message : String(err)
    }
  }

  dismiss(): void {
    if (this.busy) return
    this.dismissed = true
  }
}

export const updateStore = new UpdateStore()

/**
 * The banner's one-line rendering of an update's notes: plain text, trimmed,
 * whitespace collapsed (the banner is a single line), capped at ~300 chars
 * with an ellipsis, and hidden (null) when empty or when it is only the
 * workflow's default "kappastream <version>" placeholder. The value comes
 * from latest.json on the network, so it must never be rendered as HTML.
 */
export function displayUpdateNotes(raw: string | null, version: string | null): string | null {
  const s = (raw ?? '').replace(/\s+/g, ' ').trim()
  if (!s) return null
  if (version && s === `kappastream ${version}`) return null
  if (s.length > 300) return s.slice(0, 300).trimEnd() + '…'
  return s
}

// Re-export for tests / typing only.
export type { UpdateState }

/**
 * The banner's plain-language classification of a raw updater error: the i18n
 * key carrying the friendly one-line reason, or null when there is nothing to
 * explain. The raw string is already logged to the console (apply()'s catch),
 * so the banner surfaces only the friendly reason — a non-technical user
 * should not see "invalid encoding in minisign data" or a bare HTTP status.
 *
 * The matched strings are the messages tauri-plugin-updater 2.11 and reqwest
 * 0.13 actually emit: transport failures ("error sending request for url …")
 * and a download stream dying mid-body ("request or response body error")
 * mention no network words of their own; "Failed to install package" /
 * "Failed to install .deb package" is the pkexec/zenity/sudo install of the
 * downloaded deb/rpm failing; "Authentication failed or was cancelled" means
 * every password prompt for that install was dismissed or unavailable.
 * Unknown failures fall back to the generic message; the detail stays in the
 * console.
 */
export type UpdateErrorReason =
  | 'update_sigError'
  | 'update_pkgDeps'
  | 'update_pkgInstall'
  | 'update_authCancelled'
  | 'update_timeout'
  | 'update_network'
  | 'update_downloadFailed'
  | 'update_diskSpace'
  | 'update_permissions'
  | 'update_installFailed'

export function updateErrorReason(raw: string | null): UpdateErrorReason | null {
  if (!raw) return null
  const s = raw.toLowerCase()
  if (s.includes('minisign') || s.includes('signature') || s.includes('verif')) {
    return 'update_sigError'
  }
  // Package-manager install failures (deb/rpm): the updater replaced the
  // package out from under dpkg/rpm and a dependency changed — the user
  // must let the package manager perform this one. Matched before the
  // generic HTTP-status arm, whose bare-number regex would otherwise eat
  // dpkg/apt-style suffixes like "dependency problems (exit 1)".
  if (s.includes('failed dependencies') || s.includes('dependency problems') || s.includes('depends on ')) {
    return 'update_pkgDeps'
  }
  // The package install itself failed (not a dependency change) — same
  // advice: let the package manager run this update.
  if (s.includes('failed to install')) {
    return 'update_pkgInstall'
  }
  if (s.includes('authentication failed')) {
    return 'update_authCancelled'
  }
  if (s.includes('timeout') || s.includes('timed out')) {
    return 'update_timeout'
  }
  // The reqwest transport strings carry none of the classic network words,
  // so match them explicitly alongside those.
  if (
    s.includes('network') ||
    s.includes('connect') ||
    s.includes('dns') ||
    s.includes('resolve') ||
    s.includes('error sending request') ||
    s.includes('request or response body error')
  ) {
    return 'update_network'
  }
  if (s.includes('status') || /\b[45]\d\d\b/.test(s)) {
    return 'update_downloadFailed'
  }
  if (s.includes('enospc') || s.includes('disk') || s.includes('no space') || s.includes('space')) {
    return 'update_diskSpace'
  }
  if (s.includes('permission') || s.includes('denied') || s.includes('eacces') || s.includes('eperm')) {
    return 'update_permissions'
  }
  return 'update_installFailed'
}
