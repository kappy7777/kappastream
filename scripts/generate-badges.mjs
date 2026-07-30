#!/usr/bin/env node
// Regenerates src/lib/badges.generated.ts — the SHIPPED BASELINE of global
// Twitch chat-badge image UUIDs, compiled into the binary.
//
// WHEN TO RUN: manually, by a developer, when refreshing the baseline
// (e.g. before a release). Output is committed; the script itself is never
// run at build time or in CI — CI must not depend on gql.twitch.tv being
// reachable. On a cold first run or a GQL failure the app still renders every
// badge via this baseline; the weekly in-app refresh (src/lib/badges.svelte.ts)
// only updates UUIDs on top of it.
//
// SOURCE: Twitch GQL `Query.badges` (anonymous, pinned public Client-ID — the
// same endpoint + Client-ID the app already uses for favorites polling). The
// per-version image UUID is parsed out of `imageURL(size: NORMAL)`, which is
// `https://static-cdn.jtvnw.net/badges/v1/<uuid>/1` (trailing segment = image
// SIZE index, NOT the IRC version — see badgeUrl in irc.ts).
//
// Every UUID emitted below was verified to return a real PNG at generation
// time; any that did not are dropped. DO NOT HAND-EDIT the output — re-run:
//   node scripts/generate-badges.mjs

import { writeFileSync } from 'node:fs'

const GQL_URL = 'https://gql.twitch.tv/gql'
const CLIENT_ID = 'kimne78kx3ncx6brgo4mv6wki5h1ko'
const CDN_HOST = 'https://static-cdn.jtvnw.net'
const OUT_PATH = new URL('../src/lib/badges.generated.ts', import.meta.url)

const QUERY =
  'query { badges { setID version title imageURL(size: NORMAL) } }'

// Hand-curated setID labels where a short label beats Twitch's raw title (shown
// in tooltips). Everything not listed takes Twitch's `title` (or a prettified
// setID as a last resort). Add sparingly — this is the ONLY place baseline
// labels are curated.
const LABEL_OVERRIDES = {
  broadcaster: 'Host',
  moderator: 'Mod',
  vip: 'VIP',
  subscriber: 'Sub',
  founder: 'Founder',
  staff: 'Staff',
  admin: 'Admin',
  partner: 'Verified',
  premium: 'Prime',
  turbo: 'Turbo',
  artist: 'Artist',
  'artist-badge': 'Artist',
  bits: 'Bits',
  'bits-leader': 'Bits leader',
  'sub-gift-leader': 'Gifter',
  'sub-gifter': 'Gifter',
  hype: 'Hype Train',
  'hype-train': 'Hype Train',
  'clips-leader': 'Clips leader',
  'clip-champ': 'Power Clipper',
  'anonymous-cheerer': 'Anon',
  'anonymous-gifter': 'Anon gifter',
  'bot-badge': 'Bot',
  twitchbot: 'TwitchBot',
  no_audio: 'No audio',
  no_video: 'No video',
  'glhf-': 'GLHF',
  moments: 'Moments',
  predictions: 'Predictions',
  'social-sharing': 'Social',
}

// Legacy IRC setIDs NOT present in Query.badges today, kept as aliases of a
// canonical setID that IS in GQL so an IRC tag Twitch still emits (on some
// clients / for older badge types) keeps resolving. alias -> canonical.
const LEGACY_ALIASES = {
  artist: 'artist-badge',
  hype: 'hype-train',
  'anonymous-gifter': 'anonymous-cheerer',
  'bits-tier': 'bits',
}

// Standalone legacy badge with its own UUID (no canonical counterpart in GQL).
// Its image is verified like every other; if it no longer resolves it is
// dropped from the baseline.
const LEGACY_STANDALONE = {
  'glhf-': { label: 'GLHF', uuid: '30884d24-6a8b-4c45-89a6-1c20e5a5b9ed' },
}

// Per-version label derivation for families whose Twitch titles are noisy
// ('cheer 1000', '25 Gift Subs'). A clean uniform form reads better in a
// tooltip and covers high tiers Twitch added after the original hand-curated
// map. Everything else takes Twitch's own title.
function deriveVersionLabel(setID, version, title) {
  if (setID === 'bits' || setID === 'bits-leader') return formatBits(version)
  if (setID === 'sub-gifter' || setID === 'sub-gift-leader') {
    return `${version} subs gifted`
  }
  return title
}

function formatBits(v) {
  const n = Number(v)
  if (!Number.isFinite(n)) return `${v} bits`
  if (n < 1000) return `${n} bit${n === 1 ? '' : 's'}`
  for (const [suf, div] of [
    ['M', 1_000_000],
    ['K', 1000],
  ]) {
    if (n >= div) {
      const r = n / div
      const out = Number.isInteger(r) ? String(r) : (Math.round(r * 10) / 10).toString()
      return `${out}${suf} bits`
    }
  }
  return `${n} bits`
}

function prettify(setID) {
  return setID
    .replace(/[_-]+/g, ' ')
    .replace(/[^a-zA-Z0-9 ]/g, '')
    .trim()
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .replace(/\s+/g, ' ')
}

function uuidFromImageURL(url) {
  if (!url) return null
  const m = url.match(/\/badges\/v1\/([0-9a-fA-F-]{36})\//)
  return m ? m[1] : null
}

async function gqlFetchBadges() {
  const body = JSON.stringify({ query: QUERY })
  let lastErr
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const resp = await fetch(GQL_URL, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json',
          'client-id': CLIENT_ID,
        },
        body,
        signal: AbortSignal.timeout(20000),
      })
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`)
      const json = await resp.json()
      if (json.errors) throw new Error(`gql: ${JSON.stringify(json.errors)}`)
      const badges = json?.data?.badges
      if (!Array.isArray(badges)) throw new Error('no data.badges array')
      return badges
    } catch (e) {
      lastErr = e
      await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)))
    }
  }
  throw new Error(`GQL fetch failed after retries: ${lastErr}`)
}

// Verify a UUID returns a real image at size 1. Returns true if it resolves to
// a PNG, false otherwise. Used to guarantee no shipped UUID 404s.
async function uuidResolves(uuid) {
  const url = `${CDN_HOST}/badges/v1/${uuid}/1`
  try {
    const resp = await fetch(url, {
      method: 'GET',
      signal: AbortSignal.timeout(15000),
      headers: { range: 'bytes=0-7' },
    })
    if (!resp.ok) return false
    // CDN serves image/png OR binary/octet-stream (same PNG bytes); sniff the
    // PNG magic rather than trusting the content-type label. Request a small
    // range so we don't download every full image (the CDN honours range and
    // returns 206 + the first bytes; if it ignored range we'd get the whole
    // image, whose first bytes are still the PNG magic).
    const buf = new Uint8Array(await resp.arrayBuffer())
    return buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47
  } catch {
    return false
  }
}

async function mapLimited(items, limit, fn) {
  const ret = new Array(items.length)
  let i = 0
  const workers = new Array(Math.min(limit, items.length)).fill(0).map(async () => {
    while (i < items.length) {
      const idx = i++
      ret[idx] = await fn(items[idx], idx)
    }
  })
  await Promise.all(workers)
  return ret
}

// Group the GQL badges by setID -> [{version, uuid, title}] (deduped).
function groupBySetID(badges) {
  const map = new Map()
  for (const b of badges) {
    const setID = b.setID
    const version = String(b.version ?? '')
    const uuid = uuidFromImageURL(b.imageURL)
    if (!setID || !version || !uuid) continue
    if (!map.has(setID)) map.set(setID, new Map())
    map.get(setID).set(version, { version, uuid, title: b.title ?? '' })
  }
  return map
}

function buildEntry(setID, versionMap) {
  const versions = [...versionMap.values()].sort(cmpVersion)
  const label = LABEL_OVERRIDES[setID] ?? commonTitle(versions) ?? prettify(setID)
  const defaultUuid = versionMap.get('1')?.uuid ?? versions[0].uuid
  const entry = { label, uuid: defaultUuid }
  if (versions.length > 1) {
    entry.perVersion = {}
    for (const v of versions) entry.perVersion[v.version] = v.uuid
    const vLabels = versions.map((v) => deriveVersionLabel(setID, v.version, v.title))
    if (new Set(vLabels).size > 1) {
      entry.perVersionLabel = {}
      for (let i = 0; i < versions.length; i++) {
        entry.perVersionLabel[versions[i].version] = vLabels[i]
      }
    }
  }
  return entry
}

function commonTitle(versions) {
  const titles = new Set(versions.map((v) => v.title))
  if (titles.size === 1) return [...titles][0]
  return null
}

function cmpVersion(a, b) {
  // Numeric where possible, else lexical; stable for mixed keys like 'blue-10'.
  const an = Number(a.version)
  const bn = Number(b.version)
  if (Number.isFinite(an) && Number.isFinite(bn)) return an - bn
  return a.version < b.version ? -1 : a.version > b.version ? 1 : 0
}

function emitKey(k) {
  return /^[A-Za-z_$][\w$]*$/.test(k) ? k : `'${k}'`
}

function emitStr(s) {
  return `'${String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`
}

function emitEntry(setID, entry) {
  if (!entry.perVersion) {
    return `  ${emitKey(setID)}: { label: ${emitStr(entry.label)}, uuid: ${emitStr(entry.uuid)} },`
  }
  const lines = [`  ${emitKey(setID)}: {`]
  lines.push(`    label: ${emitStr(entry.label)},`)
  lines.push(`    uuid: ${emitStr(entry.uuid)},`)
  lines.push(`    perVersion: {`)
  for (const v of Object.keys(entry.perVersion).sort((x, y) => cmpVersion({ version: x }, { version: y }))) {
    lines.push(`      ${emitKey(v)}: ${emitStr(entry.perVersion[v])},`)
  }
  lines.push(`    },`)
  if (entry.perVersionLabel) {
    lines.push(`    perVersionLabel: {`)
    for (const v of Object.keys(entry.perVersionLabel).sort((x, y) => cmpVersion({ version: x }, { version: y }))) {
      lines.push(`      ${emitKey(v)}: ${emitStr(entry.perVersionLabel[v])},`)
    }
    lines.push(`    },`)
  }
  lines.push(`  },`)
  return lines.join('\n')
}

function emitFile(entries, dateStr, setCount, versionCount) {
  const header = `// AUTO-GENERATED by \`node scripts/generate-badges.mjs\` on ${dateStr}.
// Source: Twitch GQL \`Query.badges\` (anonymous, pinned Client-ID). Every UUID
// was verified to return a real PNG at generation time; unresolved ones were
// dropped. DO NOT HAND-EDIT — re-run the script.
//
// This is the SHIPPED BASELINE of global chat-badge image UUIDs, compiled into
// the binary. Runtime resolution order (see src/lib/irc.ts +
// src/lib/badges.svelte.ts): per-channel override -> cached global map (weekly
// refresh) -> THIS baseline -> drop. A GQL failure or cold first run still
// renders every known badge via this map; the weekly refresh only updates
// UUIDs / adds new sets on top of it.
//
// ${setCount} badge sets, ${versionCount} versions.
import type { BadgeMeta } from './irc'

// Date this baseline was generated (YYYY-MM-DD). Stored in the badge cache so
// an app update that ships a newer baseline invalidates an older cache (the
// cached map may otherwise predate newly added badges until the weekly refresh).
export const BASELINE_GENERATED_AT = '${dateStr}'

export const BASELINE_BADGES: Record<string, BadgeMeta> = {
`
  const body = entries.map(([k, v]) => emitEntry(k, v)).join('\n')
  return `${header}${body}\n}\n`
}

async function main() {
  console.log('Fetching global badges via GQL...')
  const badges = await gqlFetchBadges()
  console.log(`  GQL returned ${badges.length} (setID,version) rows`)

  const bySet = groupBySetID(badges)

  // Add legacy aliases (alias -> canonical entry, built from GQL data).
  for (const [alias, canonical] of Object.entries(LEGACY_ALIASES)) {
    const canon = bySet.get(canonical)
    if (canon) bySet.set(alias, canon)
  }
  // Add standalone legacy badges as single-version entries.
  for (const [setID, meta] of Object.entries(LEGACY_STANDALONE)) {
    if (!bySet.has(setID)) {
      bySet.set(setID, new Map([['1', { version: '1', uuid: meta.uuid, title: meta.label }]]))
    }
  }

  // Verify EVERY uuid resolves to a real PNG; drop versions that don't.
  const allVersions = []
  for (const [setID, versions] of bySet) {
    for (const v of versions.values()) allVersions.push({ setID, ...v })
  }
  console.log(`Verifying ${allVersions.length} image URLs resolve...`)
  const results = await mapLimited(allVersions, 16, async (rec) => [
    rec,
    await uuidResolves(rec.uuid),
  ])
  const failed = results.filter(([, ok]) => !ok).map(([r]) => r)
  if (failed.length) {
    console.log(`  DROPPING ${failed.length} unresolved version(s):`)
    for (const f of failed) console.log(`    ${f.setID}/${f.version} ${f.uuid}`)
  }
  for (const f of failed) bySet.get(f.setID)?.delete(f.version)
  // Remove sets left with no versions.
  for (const [setID, versions] of [...bySet]) {
    if (versions.size === 0) {
      console.log(`  DROPPING empty set: ${setID}`)
      bySet.delete(setID)
    }
  }

  // Build entries, sorted by setID for diff stability.
  const entries = [...bySet.entries()]
    .filter(([, v]) => v.size > 0)
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map(([setID, versions]) => [setID, buildEntry(setID, versions)])

  const versionCount = entries.reduce(
    (n, [, e]) => n + (e.perVersion ? Object.keys(e.perVersion).length : 1),
    0,
  )
  const dateStr = new Date().toISOString().slice(0, 10)
  const file = emitFile(entries, dateStr, entries.length, versionCount)

  writeFileSync(OUT_PATH, file)
  console.log(
    `Wrote ${OUT_PATH.pathname}: ${entries.length} sets, ${versionCount} versions` +
      ` (${failed.length} unresolved dropped).`,
  )
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
