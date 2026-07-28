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
        console.warn(
          `[update] ignoring non-newer version ${update.version} (current ${update.currentVersion})`,
        )
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
      // if it fails, leave the app running so the user can restart manually.
      this.status = 'installing'
      try {
        await relaunch()
      } catch (err) {
        console.warn('[update] relaunch failed (manual restart needed):', err)
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

// Re-export for tests / typing only.
export type { UpdateState }
