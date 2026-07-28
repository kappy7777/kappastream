/*
 * VOD resume positions — remember where the user got to in a past broadcast so a
 * long VOD is resumable. Keyed by VOD id, persisted to localStorage, and
 * STRICTLY BOUNDED (oldest-first eviction) so this can't grow unbounded.
 *
 * Two thresholds filter out useless/annoying resumes:
 *   - below VOD_RESUME_MIN_S (30s): nothing meaningful to resume from yet;
 *   - above VOD_RESUME_COMPLETE_FRACTION (95%): the VOD is effectively finished,
 *     and resuming near the credits is actively annoying — the entry is dropped.
 *
 * `position` is playlist-relative (the VOD runs through the ksvod proxy and
 * currentTime is relative to that playlist). The same player writes and reads
 * it, so it is self-consistent — but it does NOT match Twitch's own broadcast
 * offset. Clips are deliberately out of scope (too short to be worth resuming).
 */

export interface VodPosition {
  position: number
  duration: number
  updatedAt: number
}

const STORAGE_KEY = 'app-vod-positions-v1'
export const MAX_VOD_POSITIONS = 50
export const VOD_RESUME_MIN_S = 30
export const VOD_RESUME_COMPLETE_FRACTION = 0.95

// Pure decision: is this (position, duration) worth persisting? Exported so the
// threshold boundaries are unit-testable without touching localStorage.
export function shouldSavePosition(position: number, duration: number): boolean {
  if (!Number.isFinite(position) || position < VOD_RESUME_MIN_S) return false
  if (Number.isFinite(duration) && duration > 0 && position / duration > VOD_RESUME_COMPLETE_FRACTION) {
    return false
  }
  return true
}

function isVodPosition(v: unknown): v is VodPosition {
  return (
    !!v &&
    typeof v === 'object' &&
    typeof (v as VodPosition).position === 'number' &&
    typeof (v as VodPosition).duration === 'number' &&
    typeof (v as VodPosition).updatedAt === 'number'
  )
}

function loadMap(): Record<string, VodPosition> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    const out: Record<string, VodPosition> = {}
    for (const [id, val] of Object.entries(parsed as Record<string, unknown>)) {
      if (id && isVodPosition(val)) out[id] = val
    }
    return out
  } catch {
    return {}
  }
}

function persist(map: Record<string, VodPosition>): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(map))
  } catch {
    /* ignore quota / serialization errors */
  }
}

// Drop the oldest entries (lowest updatedAt) until the map is within the cap.
export function evictOldest(map: Record<string, VodPosition>, cap: number): Record<string, VodPosition> {
  const ids = Object.keys(map)
  if (ids.length <= cap) return map
  const out = { ...map }
  ids.sort((a, b) => map[a].updatedAt - map[b].updatedAt)
  const drop = ids.length - cap
  for (let i = 0; i < drop; i++) delete out[ids[i]]
  return out
}

export class VodPositionsStore {
  positions: Record<string, VodPosition> = $state(loadMap())

  get(vodId: string): VodPosition | null {
    return this.positions[vodId] ?? null
  }

  has(vodId: string): boolean {
    return vodId in this.positions
  }

  // Persist a resume point subject to the thresholds. Returns true if stored.
  // A position past the completion threshold DROPS any prior entry (finished).
  save(vodId: string, position: number, duration: number): boolean {
    if (!vodId) return false
    const finished =
      Number.isFinite(duration) && duration > 0 && position / duration > VOD_RESUME_COMPLETE_FRACTION
    if (!shouldSavePosition(position, duration)) {
      if (finished) this.clear(vodId)
      return false
    }
    const next: Record<string, VodPosition> = {
      ...this.positions,
      [vodId]: {
        position,
        duration: Number.isFinite(duration) ? duration : 0,
        updatedAt: Date.now(),
      },
    }
    this.positions = evictOldest(next, MAX_VOD_POSITIONS)
    persist(this.positions)
    return true
  }

  clear(vodId: string): void {
    if (!(vodId in this.positions)) return
    const next = { ...this.positions }
    delete next[vodId]
    this.positions = next
    persist(this.positions)
  }
}

export const vodPositions = new VodPositionsStore()
