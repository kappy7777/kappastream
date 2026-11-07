#!/usr/bin/env node
// Fails when the committed flatpak offline sources
// (packaging/flatpak/sources/*.json) drift from the lockfiles they were
// generated from. flatpak-builder disables networking in every build step,
// so the manifest consumes those generated files instead of fetching; a
// stale set only surfaces as a broken release build (or worse, a stale
// dependency shipping). Regenerate with scripts/flatpak-gen-sources.sh
// after every lockfile bump.
//
// Checks, in both directions:
//   - src-tauri/Cargo.lock registry packages (name, version, checksum)
//     vs cargo-sources.json archive entries
//     (dest cargo/vendor/<name>-<version>, matching sha256)
//   - package-lock.json resolved URLs (workspace links skipped) vs
//     node-sources.json url entries, with the lock's integrity hash
//     (base64) equal to the entry's hex digest
//
// No dependencies: plain Node (>=20), run from anywhere in the repo.
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const repo = join(dirname(fileURLToPath(import.meta.url)), '..')
const problems = []

// --- cargo: a line-oriented Cargo.lock scanner (registry packages only) --
const lockText = readFileSync(join(repo, 'src-tauri/Cargo.lock'), 'utf8')
/** @type {Map<string, string>} `<name>-<version>` -> hex checksum ('' when absent) */
const lockPackages = new Map()
/** Every `<name>-<version>` in the lock, whatever the source — git/path
 *  packages are vendored too, so the reverse direction must not flag them. */
const lockKeysAll = new Set()
{
  let pkg = null
  const flush = () => {
    if (pkg?.name) {
      lockKeysAll.add(`${pkg.name}-${pkg.version}`)
      if (pkg.source?.startsWith('registry+')) {
        lockPackages.set(`${pkg.name}-${pkg.version}`, pkg.checksum ?? '')
      }
    }
    pkg = null
  }
  for (const line of lockText.split('\n')) {
    if (line === '[[package]]') {
      flush()
      pkg = {}
      continue
    }
    // Any other section header ([patch...], [metadata], ...) ends the
    // current package: its fields must not be absorbed into it.
    if (line.startsWith('[')) {
      flush()
      continue
    }
    if (pkg === null) continue
    const m = /^(name|version|source|checksum) = "(.*)"$/.exec(line)
    if (m) pkg[m[1]] = JSON.parse(`"${m[2]}"`)
  }
  flush()
}

/** @type {Map<string, string>} vendor dir -> hex sha256 (archive entries only) */
const vendorDirs = new Map()
for (const entry of loadJson('packaging/flatpak/sources/cargo-sources.json')) {
  const m = /^cargo\/vendor\/(.+)$/.exec(entry.dest ?? '')
  if (m && entry.type === 'archive' && typeof entry.sha256 === 'string') {
    vendorDirs.set(m[1], entry.sha256)
  }
}

for (const [key, checksum] of lockPackages) {
  const sha = vendorDirs.get(key)
  if (sha === undefined) {
    problems.push(`cargo: ${key} is in Cargo.lock but missing from cargo-sources.json`)
  } else if (sha !== checksum) {
    problems.push(`cargo: ${key} checksum mismatch (Cargo.lock ${checksum || '(none)'} vs sources ${sha})`)
  }
}
for (const key of vendorDirs.keys()) {
  if (!lockKeysAll.has(key)) {
    problems.push(`cargo: ${key} is in cargo-sources.json but not in Cargo.lock`)
  }
}

// --- npm: lock resolved URLs vs node-sources url entries -------------
const packageLock = loadJson('package-lock.json')
/** @type {Map<string, string>} resolved URL -> `alg-base64` integrity */
const lockUrls = new Map()
for (const [path, meta] of Object.entries(packageLock.packages ?? {})) {
  if (!path) continue // the root package
  if (meta.link) continue // workspace link: no tarball
  if (typeof meta.resolved === 'string') {
    // Registry tarballs only: a future git/file dependency resolves to a
    // non-http URL the node generator would vendor differently.
    if (!/^https?:\/\//.test(meta.resolved)) continue
    lockUrls.set(meta.resolved, typeof meta.integrity === 'string' ? meta.integrity : '')
  }
}

/** @type {Map<string, object>} url -> source entry */
const nodeUrls = new Map()
for (const entry of loadJson('packaging/flatpak/sources/node-sources.json')) {
  if (typeof entry.url === 'string') nodeUrls.set(entry.url, entry)
}

for (const [url, integrity] of lockUrls) {
  const entry = nodeUrls.get(url)
  if (entry === undefined) {
    problems.push(`npm: ${url} is in package-lock.json but missing from node-sources.json`)
    continue
  }
  if (!integrity) continue // lock entry without integrity: nothing to compare
  const [algo, b64] = integrity.split('-', 2)
  const expectedHex = Buffer.from(b64, 'base64').toString('hex')
  if (entry[algo] !== expectedHex) {
    problems.push(`npm: ${url} ${algo} mismatch (lock ${expectedHex} vs sources ${entry[algo]})`)
  }
}
for (const url of nodeUrls.keys()) {
  if (!lockUrls.has(url)) {
    problems.push(`npm: ${url} is in node-sources.json but not in package-lock.json`)
  }
}

if (problems.length > 0) {
  console.error(
    `flatpak offline sources are stale (${problems.length} problem(s)); regenerate with: sh scripts/flatpak-gen-sources.sh`,
  )
  for (const problem of problems) console.error(`  - ${problem}`)
  process.exit(1)
}

console.log(`flatpak offline sources OK: ${lockPackages.size} cargo crates, ${lockUrls.size} npm tarballs`)

/** Parse a JSON file relative to the repo root. */
function loadJson(rel) {
  return JSON.parse(readFileSync(join(repo, rel), 'utf8'))
}
