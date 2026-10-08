// The ONE frontend path for handing a link to the OS browser. The Rust
// command open_url_robust RESOLVES {ok:false} when every opener method
// failed (and for a URL that failed validation) — it does not throw — so a
// caller that only catches rejections reports nothing: chat and
// pinned-message links used to fail exactly that silently while the
// open-on-Twitch pill, which checked `ok`, toasted properly. Every open now
// funnels through here and surfaces the same toast on failure.

import { invoke, isTauri } from '@tauri-apps/api/core'
import { toast } from './toast.svelte'
import { t } from './i18n/index.svelte'

interface OpenUrlRobustResult {
  ok: boolean
  method: string
  path: string | null
  exit_code: number | null
  stderr: string
  url: string
  inherited_path: string | null
}

/** Open a validated twitch link externally; toast when no opener works. */
export function openExternal(url: string): void {
  if (!isTauri()) return
  void (async () => {
    try {
      const r = (await invoke('open_url_robust', { url })) as OpenUrlRobustResult
      if (r.ok) return
      if (import.meta.env.DEV) {
        console.error('open-url: all openers failed', {
          method: r.method,
          path: r.path,
          inherited_path: r.inherited_path,
          exit_code: r.exit_code,
          stderr: r.stderr,
        })
      }
      toast(t('toast_openLinkFailed'))
    } catch (err) {
      if (import.meta.env.DEV) console.error('open-url: open_url_robust threw', err)
      toast(t('toast_openLinkFailed'))
    }
  })()
}
