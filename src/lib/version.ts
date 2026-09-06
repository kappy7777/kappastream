// Minimal SemVer-core comparison for the in-app updater's downgrade guard.
//
// Compares the numeric major.minor.patch core only. Pre-release tails
// (`-rc1`, `-beta.2`) are intentionally NOT ordered: kappastream's prerelease
// tags are throwaway updater smoke-test builds (release.yml pins a specific tag
// manifest for them, never the /releases/latest alias), so an rc install not
// being offered the same-core stable is benign, not a bug. The guard's job is
// one-directional — refuse to offer an OLDER version — which the core
// comparison handles. Fails closed: anything unparseable is treated as "not
// newer" so a malformed manifest never produces a downgrade prompt.

/** Parse the leading `major.minor.patch` of a version string. */
function parseCore(v: string): [number, number, number] | null {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(v)
  if (!m) return null
  return [Number(m[1]), Number(m[2]), Number(m[3])]
}

/**
 * Is `candidate` strictly newer than `current`, by SemVer core?
 * Returns false on equal, older, or unparseable input (fail closed).
 */
export function isVersionNewer(candidate: string, current: string): boolean {
  const c = parseCore(candidate)
  const cur = parseCore(current)
  if (!c || !cur) return false
  return compareSemverCore(candidate, current) > 0
}

/**
 * Three-way SemVer-core compare of two version strings (negative / zero /
 * positive). Pre-release tails are ignored — an rc compares as its core, the
 * same rule `isVersionNewer` applies. An unparseable string compares LOWEST
 * (as 0.0.0) so a malformed value never wins a "newest first" sort; callers
 * that must fail closed on unparseable input keep their own parse check (as
 * `isVersionNewer` does).
 */
export function compareSemverCore(a: string, b: string): number {
  const x = parseCore(a) ?? [0, 0, 0]
  const y = parseCore(b) ?? [0, 0, 0]
  for (let i = 0; i < 3; i++) {
    if (x[i] !== y[i]) return x[i] - y[i]
  }
  return 0
}
