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
  if (c[0] !== cur[0]) return c[0] > cur[0]
  if (c[1] !== cur[1]) return c[1] > cur[1]
  return c[2] > cur[2]
}
