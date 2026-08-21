// Per-version release highlights for the "what's new" screen.
//
// MUST STAY IN SYNC WITH CHANGELOG.md. The highlights below are the short-form
// companion to the CHANGELOG's long-form entry for each version: the sections
// mirror the CHANGELOG's Added / Changed / Fixed headings, every user-facing
// bullet for the version appears in exactly one section, and nothing appears
// here that isn't in the CHANGELOG. A version with a CHANGELOG section but no
// entry here falls back to a generic line; a version with an entry here but no
// CHANGELOG section is drift to fix.
//
// OWNER CONVENTIONS (see the Release-notes rule in AGENTS.md): this file is
// owner-controlled prose — entries are drafted and approved by the owner
// alongside the CHANGELOG in each release cycle, and every bullet starts with
// a fitting emoji (pinned by release-notes.test.ts).
//
// WHY CURATED (not generated from CHANGELOG.md): the CHANGELOG is owner-
// controlled prose, its format doesn't map cleanly to short bullets, and a
// build-time markdown parser would add complexity for no gain. A curated map
// ships in the bundle (offline — the what's-new screen adds NO network
// request) and is a one-line edit per release. The CHANGELOG remains the
// long-form record; this is the short-form companion a user sees once after
// updating.
//
// i18n DECISION: the per-version highlight TEXT stays English. The recurring
// per-release translation cost across the five locales (en/de/es/fr/pt) is
// not justified on this project's deliberately low release cadence, and
// highlights are often technical feature names. The surrounding chrome —
// title, buttons, the section headers, the streamlink hint — IS translated
// (see the i18n catalogue). Revisit if release cadence rises.

export interface VersionNotes {
  /** New features (mirrors the CHANGELOG's ### Added bullets). */
  added?: string[]
  /** Behaviour changes (mirrors ### Changed). */
  changed?: string[]
  /** Bug fixes (mirrors ### Fixed). */
  fixed?: string[]
}

export const RELEASE_NOTES: Record<string, VersionNotes> = {
  '1.0.2': {
    added: [
      '🤝 Stream Together: favorites in a shared session show a +N chip, co-streamer avatars, and the combined viewership.',
      '📺 New "Watch together" button opens the whole Stream Together session in the multi-view grid.',
      '🎬 The VOD scrub bar gains chapter ticks, muted-segment stripes, and storyboard thumbnails on hover.',
      '👥 The status bar now shows the channel\'s follower count.',
    ],
    fixed: [
      '📐 The status bar no longer leaves an empty band below itself on tall windows.',
    ],
  },
  '1.0.1': {
    added: [
      '🎨 Custom theme editor — duplicate any of the 34 built-ins, tune it with sliders and a swatch palette, and share themes as JSON files.',
      '🌈 Five new built-in themes: Riptide, Toxin, Redline, Hazard, and Blacklight.',
      '🎚️ Every tile in multi-view now has its own volume slider.',
    ],
    changed: [
      "💬 Multi-view: chat tabs switch only the chat — audio stays with the stream you're listening to.",
      "📊 Multi-view: the hidden status bar's show button is always visible.",
    ],
    fixed: [
      '🔊 Multi-view: unmuting a tile always works now, even under a global mute.',
      '🖱️ Multi-view: the chat tab strip scrolls when it overflows.',
    ],
  },
  '1.0.0': {
    added: [
      '👋 First-run welcome screen — intro, feature list, privacy summary, and a streamlink check with the right install command for your platform.',
      '✨ A "what\'s new" screen now appears once after each update, then never again until the next one.',
    ],
  },
  '0.3.1': {
    added: [
      '📺 Multi-stream split view — watch up to four live streams side by side, each with its own chat tab, quality, and volume.',
      '🔀 Reorder tiles by dragging; resize them with the splitters between tiles (double-click to reset).',
      '🔊 The focused tile is the audio authority; unmute any other tile to listen along.',
    ],
  },
  '0.3.0': {
    added: [
      '🍎 macOS support (Apple Silicon) — a .dmg alongside the Linux and Windows builds.',
    ],
    fixed: [
      '🔍 Fixed UI scaling at non-1× zoom on macOS.',
    ],
  },
  '0.2.9': {
    added: [
      '💬 VOD chat replay, synced to the playhead.',
      '🌍 UI localization — English, Deutsch, Español, Français, Português.',
      '🏷️ VOD and clip titles in the status bar.',
    ],
    changed: [
      '▶️ A less intrusive "Back to live" banner while watching VODs or clips.',
    ],
    fixed: [
      '🔄 The live status bar no longer goes stale — title, game, and viewers refresh with each poll.',
    ],
  },
}

// No sections when a version has no curated notes — the component renders a
// generic translated line in that case (never an empty screen).
const FALLBACK_NOTES: VersionNotes = {}

/** The curated highlights for `version`, or empty sections if none are recorded. */
export function releaseNotesFor(version: string): VersionNotes {
  return RELEASE_NOTES[version] ?? FALLBACK_NOTES
}
