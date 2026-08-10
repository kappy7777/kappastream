// Per-version release highlights for the "what's new" screen.
//
// MUST STAY IN SYNC WITH CHANGELOG.md. The highlights below are the short-form
// companion to the CHANGELOG's long-form entry for each version — they must
// faithfully reflect the Added/Changed/Fixed bullets in CHANGELOG.md for that
// version (no feature listed here that isn't in the CHANGELOG, and nothing
// user-facing in the CHANGELOG dropped here). When you add a CHANGELOG section
// for a new release, add the matching entry here in the SAME edit and verify
// the two agree. A version with a CHANGELOG section but no entry here falls
// back to a generic line; a version with an entry here but no CHANGELOG section
// is drift to fix.
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
// title, buttons, the "Highlights" label, the streamlink hint — IS translated
// (see the i18n catalogue). Revisit if release cadence rises.

export interface VersionNotes {
  highlights: string[]
}

const RELEASE_NOTES: Record<string, VersionNotes> = {
  '1.0.0': {
    highlights: [
      'First-run welcome screen — intro, feature list, privacy summary, and a streamlink check with the right install command for your platform.',
      'A "what\'s new" screen now appears once after each update, then never again until the next one.',
    ],
  },
  '0.3.1': {
    highlights: [
      'Multi-stream split view — watch up to four live streams side by side, each with its own chat tab, quality, and volume.',
      'Reorder tiles by dragging; resize them with the splitters between tiles (double-click to reset).',
      'The focused tile is the audio authority; unmute any other tile to listen along.',
    ],
  },
  '0.3.0': {
    highlights: [
      'macOS support (Apple Silicon) — a .dmg alongside the Linux and Windows builds.',
      'Fixed UI scaling at non-1× zoom on macOS.',
    ],
  },
  '0.2.9': {
    highlights: [
      'VOD chat replay, synced to the playhead.',
      'UI localization — English, Deutsch, Español, Français, Português.',
      'VOD and clip titles in the status bar.',
    ],
  },
}

// Empty list when a version has no curated notes — the component renders a
// generic translated line in that case (never an empty screen).
const FALLBACK_NOTES: VersionNotes = {
  highlights: [],
}

/** The curated highlights for `version`, or an empty list if none are recorded. */
export function releaseNotesFor(version: string): VersionNotes {
  return RELEASE_NOTES[version] ?? FALLBACK_NOTES
}
