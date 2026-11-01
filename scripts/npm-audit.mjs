#!/usr/bin/env node
// Supply-chain gate over package-lock.json — a drop-in replacement for a bare
// `npm audit` in CI, adding the one thing npm audit lacks: an ignore list that
// cannot be forgotten. Mirrors src-tauri/.cargo/audit.toml on the Rust side:
//
//   - every advisory, any severity, prod or dev, still fails the build unless
//     its GHSA id is explicitly allowlisted below;
//   - every allowlist entry carries a hard expiry date. Approaching expiry
//     prints a warning; past expiry the entry itself fails the build, so a
//     stale exception turns back into a red build instead of silently
//     suppressing a real advisory. Remove the entry once its fix shipped, or
//     consciously re-date it if upstream still has not moved.
//
// Exit codes: 0 = clean or only validly-allowlisted advisories, 1 = new
// advisory, expired allowlist entry, or an audit run that itself failed (the
// gate is never silently green).

import { spawnSync } from 'node:child_process'

// id: GHSA id exactly as npm audit reports it (via[].url).
// expires: last UTC day the entry is valid (inclusive).
const ALLOWLIST = [
  {
    id: 'GHSA-gcqx-w48m-w2h4',
    expires: '2027-01-30',
    reason:
      'deepmerge prototype poisoning — every release >= 4.2.0 affected, no patched version exists. ' +
      'Reached only through @sveltejs/vite-plugin-svelte, which merges this vite config at build time; ' +
      'no attacker-controlled input. Delete once deepmerge ships a fix the plugin picks up, ' +
      'or the plugin drops deepmerge entirely.',
  },
]

const WARN_DAYS = 14
const DAY_MS = 24 * 60 * 60 * 1000

const run = spawnSync('npm', ['audit', '--json'], { encoding: 'utf8' })
if (run.error || run.status === null || !run.stdout) {
  console.error(`npm audit failed to run: ${run.error ?? run.stderr}`)
  process.exit(1)
}

let report
try {
  report = JSON.parse(run.stdout)
} catch {
  console.error('npm audit produced unparseable output:')
  console.error(run.stdout)
  process.exit(1)
}
if (report.error) {
  // The tool itself failed (missing lockfile, registry error, ...) — block.
  console.error(`npm audit error (${report.error.code ?? 'unknown'}): ${report.error.summary}`)
  process.exit(1)
}

// ghsa id -> findings carrying it. `via` entries are either advisory objects
// (the package itself is vulnerable) or bare package-name strings pointing at
// the dependency that dragged the vulnerable package in — only the objects
// carry the advisory URL.
const findings = new Map()
for (const [pkg, vuln] of Object.entries(report.vulnerabilities ?? {})) {
  for (const via of vuln.via ?? []) {
    if (typeof via === 'string') continue
    const id = via.url?.match(/GHSA-[a-z0-9-]+/i)?.[0]
    if (!id) continue
    if (!findings.has(id)) findings.set(id, [])
    findings.get(id).push({ package: pkg, severity: via.severity, title: via.title })
  }
}

const total = report.metadata?.vulnerabilities?.total ?? 0
if (total > 0 && findings.size === 0) {
  // Safety net: findings exist but none carried an extractable advisory id —
  // block rather than risk a silent pass on an unknown report shape.
  console.error(`npm audit reports ${total} vulnerabilities but no GHSA ids could be extracted`)
  process.exit(1)
}

const today = new Date(new Date().toISOString().slice(0, 10)) // UTC midnight
let failed = false

for (const entry of ALLOWLIST) {
  const daysLeft = Math.round((new Date(entry.expires) - today) / DAY_MS)
  const matched = findings.get(entry.id)
  if (daysLeft < 0) {
    console.error(`ALLOWLIST EXPIRED: ${entry.id} (was valid through ${entry.expires}) — fix it or re-date it`)
    failed = true
  } else if (matched) {
    const suffix = daysLeft <= WARN_DAYS ? ` — EXPIRES IN ${daysLeft} DAY(S), remove or re-date soon` : ''
    console.log(`allowed: ${entry.id} (${matched[0].title}, ${matched.length} finding(s))${suffix}`)
  } else {
    console.log(`allowlist entry ${entry.id} matched nothing — advisory cleared upstream? remove the entry`)
  }
}

for (const [id, hits] of findings) {
  if (ALLOWLIST.some((e) => e.id === id)) continue
  console.error(`BLOCKED: ${id} — ${hits[0].title}`)
  for (const hit of hits) console.error(`  ${hit.package} (${hit.severity})`)
  failed = true
}

if (failed) process.exit(1)
console.log(`npm audit gate: ${total} finding(s), all allowlisted and valid`)
