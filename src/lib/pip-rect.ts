// PiP window-rect helpers, shared by PipWindow.svelte (the floating window)
// and pip-controller.svelte.ts (the main-window side). The conversion math is
// pure on purpose: the component cannot import the controller module without
// the module-level singleton registering a SECOND controller inside the
// floating window, so the shared code lives here where both sides and the
// tests can reach it. The persistence helpers read/write the one localStorage
// key both webviews share (same origin).

export interface PipRectShape {
  x: number
  y: number
  width: number
  height: number
}

export const PIP_RECT_MIN_WIDTH = 160
export const PIP_RECT_MIN_HEIGHT = 90

/** The saved rect, read and validated. localStorage is shared between the
 *  main and PiP webviews (same origin); null when absent, malformed, or
 *  smaller than the restore floor. */
export function readSavedPipRect(storageKey: string): PipRectShape | null {
  try {
    const raw = localStorage.getItem(storageKey)
    if (!raw) return null
    const v = JSON.parse(raw) as Partial<PipRectShape>
    if (
      typeof v.x !== 'number' ||
      typeof v.y !== 'number' ||
      typeof v.width !== 'number' ||
      typeof v.height !== 'number'
    ) {
      return null
    }
    if (v.width < PIP_RECT_MIN_WIDTH || v.height < PIP_RECT_MIN_HEIGHT) return null
    return { x: v.x, y: v.y, width: v.width, height: v.height }
  } catch {
    return null
  }
}

export function writeSavedPipRect(storageKey: string, rect: PipRectShape): void {
  try {
    localStorage.setItem(storageKey, JSON.stringify(rect))
  } catch {
    /* ignore — a failed save just means the next open uses the default */
  }
}

/** A monitor's rect in the same RAW PHYSICAL pixels the saved rect carries
 *  (Tauri's Monitor.position/size are physical). */
export interface MonitorRect {
  x: number
  y: number
  width: number
  height: number
}

/**
 * Whether the CENTRE of a saved rect lands on any connected monitor. The
 * PiP window is undecorated and skips the taskbar, so a rect saved on a
 * since-unplugged monitor would otherwise reopen with no visible chrome to
 * drag it back by — the caller drops the position and centres instead.
 * Edge-inclusive: a centre exactly on a monitor edge still counts.
 */
export function rectCentreOnAnyMonitor(rect: PipRectShape, monitors: readonly MonitorRect[]): boolean {
  const cx = rect.x + rect.width / 2
  const cy = rect.y + rect.height / 2
  return monitors.some((m) => cx >= m.x && cx <= m.x + m.width && cy >= m.y && cy <= m.y + m.height)
}

/**
 * Clamp a restore rect to a fraction of the monitor's size, in the SAME
 * units both are carried in — RAW PHYSICAL pixels (the stored rect relays
 * resize-event values verbatim, and Monitor.size is physical). A rect grown
 * by older builds, or saved on a since-unplugged larger monitor, heals on
 * the first open instead of restoring nearly fullscreen. Width/height never
 * drop below the restore floor; position is passed through untouched.
 */
export function clampRectToMonitor(
  rect: PipRectShape,
  monitorLogicalWidth: number,
  monitorLogicalHeight: number,
  fraction = 0.6,
): PipRectShape {
  const capW = Math.max(PIP_RECT_MIN_WIDTH, Math.floor(monitorLogicalWidth * fraction))
  const capH = Math.max(PIP_RECT_MIN_HEIGHT, Math.floor(monitorLogicalHeight * fraction))
  return {
    x: rect.x,
    y: rect.y,
    width: Math.min(Math.max(rect.width, PIP_RECT_MIN_WIDTH), capW),
    height: Math.min(Math.max(rect.height, PIP_RECT_MIN_HEIGHT), capH),
  }
}
