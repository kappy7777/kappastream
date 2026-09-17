// Quality menu vocabulary, shared by PlayerControls (the hls.js overlay
// menu) and App's native-OSD feed (the labels are sent to the mpv OSD
// script, see src-tauri/src/mpv/ks-osc.lua). The resolution IDs are
// technical streamlink args and are NOT translated; only the two display
// words ('Source', 'Audio only') are, resolved reactively via t() so a
// language switch updates the open menu and the OSD feed live.

import { t } from './i18n/index.svelte'

export const QUALITY_IDS = ['best', '1080p60', '720p60', '720p', '480p', '360p', '160p', 'audio_only'] as const

export function qualityLabel(id: string): string {
  if (id === 'best') return t('pc_sourceQuality')
  if (id === 'audio_only') return t('pc_audioOnly')
  return id
}

/** Resolution height encoded in a rung id ("936p60" → 936). Non-rung ids
 *  (audio_only) are 0 and sort last. */
function rungHeight(id: string): number {
  const m = /^(\d+)p/.exec(id)
  return m ? Number(m[1]) : 0
}

/** The menu list for a channel: `best` (Source) followed by the variants it
 *  ACTUALLY offers (the `stream_qualities` streamlink probe), tallest rung
 *  first. Twitch's transcode ladder is DYNAMIC — rungs are named after
 *  whatever the channel transcodes right now ("936p60", "480p60", …), so
 *  unknown rung ids are expected and ordered by their encoded height, with
 *  vocabulary rungs breaking height ties. `null`/empty = unknown (probe
 *  failed or hasn't answered yet) → the full vocabulary, which is the
 *  pre-probe behavior — the probe can only sharpen the menu, never empty it
 *  beyond `best` (streamlink guarantees a `best` whenever any stream
 *  exists). */
export function effectiveQualities(available: readonly string[] | null | undefined): string[] {
  if (!available || available.length === 0) return [...QUALITY_IDS]
  // Mirror of the alias filter in parse_available_qualities (defense in
  // depth): streamlink's best/worst (+ *_unfiltered) entries duplicate
  // rungs; the menu always shows its own Source row instead.
  const aliases = new Set(['best', 'worst', 'best_unfiltered', 'worst_unfiltered'])
  const rank = (id: string): number => (QUALITY_IDS as readonly string[]).indexOf(id) // -1 = unknown rung
  const tiebreak = (id: string): number => {
    const r = rank(id)
    return r === -1 ? QUALITY_IDS.length : r
  }
  const rungs = [...new Set(available)].filter((id) => !aliases.has(id))
  rungs.sort((a, b) => rungHeight(b) - rungHeight(a) || tiebreak(a) - tiebreak(b))
  return ['best', ...rungs]
}

/** The quality list for the EMBEDDED mpv engine: audio_only is deliberately
 *  absent. mpv plays it, but with no video track there is no OSD canvas
 *  (mpv reports a 0x0 OSD size), so the in-video controller — the only way
 *  to switch quality away — renders nothing and the engine looks dead.
 *  The hls.js path keeps audio_only (its HTML controls are unaffected). A
 *  list that offered ONLY audio_only degrades to Source alone. */
export function mpvQualities(available: readonly string[] | null | undefined): string[] {
  return effectiveQualities(available).filter((qid) => qid !== 'audio_only')
}
