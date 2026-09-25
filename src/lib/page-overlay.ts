// Page-UI overlay management for the native (embedded-libmpv) video surfaces.
//
// Page UI that must appear ABOVE the video renders in the webview — UNDER
// the native video window. WebKitGTK can't punch a transparency hole, GDK
// visual shapes are a no-op on Wayland, and the rasterize-and-composite
// fallback (webkit snapshots re-drawn as mpv overlays) is too laggy —
// WebKit's own full-page composite per snapshot dominates and can't be
// avoided through that API. So overlapping UI is handled in two grades:
//
//  - Full-window modals (About/shortcuts, Browse, welcome/what's-new,
//    Settings, theme editor — the backdrop families): they cover the whole
//    player anyway, so the surfaces HIDE entirely (mpv_set_surface_visible
//    broadcasts). The live webview shows through at full frame rate; mpv
//    keeps playing audio; the video returns when the modal stops
//    overlapping.
//
//  - Small STRIPS (update banner, tooltips, toasts, the notification
//    menu, the search dropdown): must not duck a playing video for a
//    sliver of UI — they keep the snapshot overlay (positioned against the
//    surface rect), one-shot per geometry change plus interaction
//    refreshes (typing/scrolling inside the overlaid element). The bitmap
//    is MASKED to the element rects (keep rects), so the union crop
//    carries no dark empty-player padding between/around elements. Their
//    reveal animations are disabled in native mode (the
//    .app--native-video rules), so the first snapshot is already the final
//    frame — no settle burst needed.
//
// This manager owns WHEN: it polls the surface rects against the classes
// (DOM changes, resizes, a short tick for moving tooltips). New dialogs
// must be classified explicitly into one of the two lists below.
//
// ONE implementation serves both callers: App passes its single player
// surface (the FITTED CONTENT rect, engine 0), MultiView passes one
// surface per native tile area (the grid cell rect). The geometry sources
// stay with the callers — `getSurfaces` is re-read on every recheck, so
// the caller's reactive reads (player element, aspect, area map) keep
// working as effect dependencies through the initial synchronous recheck.
import { invoke } from '@tauri-apps/api/core'

/** A window-space rect in visual px (a DOMRect satisfies this). */
export interface OverlayBox {
  left: number
  top: number
  right: number
  bottom: number
  width: number
  height: number
}

/** Min spacing between interaction-driven re-snapshots (the trailing-edge
 *  timer lands one more this long after the LAST gated event). Kept just
 *  above the engine's 70 ms snapshot coalesce window (SNAPSHOT_COALESCE_MS
 *  in linux.rs) so this limiter only smooths event bursts — the engine
 *  already thins the snapshots themselves — and hover updates feel as
 *  immediate as the geometry-driven tooltip refreshes. */
const INTERACT_SNAP_MS = 80

/** One native surface to manage page UI over. `box` null = unmeasurable
 * this pass (element gone / degenerate box); the surface is skipped. */
export interface OverlaySurface {
  /** mpv engine id (0 = the single-view player). */
  id: number
  box: OverlayBox | null
  /** Fraction of the surface's FULL (unrolled) composition hidden above the
   *  scroll fold — the single-view player under a partial scroll; absent/0
   *  for unfolded surfaces (multi-view tiles). `box` is the VISIBLE
   *  (clipped) rect, but the engine composites in full-composition space
   *  (osd-size = the offscreen render target = visible + folded rows), so
   *  the OSD fractions must be remapped or the bitmap lands shifted up and
   *  stretched by the fold. */
  hiddenTop?: number
}

/** Full-window modals: hide every surface entirely while one overlaps. */
export const FULL_OVERLAY_SELECTOR =
  '.about-modal, .about-backdrop, .browse-modal, .browse-backdrop, .welcome-modal, .welcome-backdrop, .ct-panel, .ct-backdrop, .settings-modal, .settings-backdrop'

/** Snapshotted strips: small/static/transient UI — a one-shot bitmap with
 *  interaction + drop-retry refreshes, never a duck. */
export const SNAP_OVERLAY_SELECTOR =
  '.update-banner, .global-tooltip, .notif-toast, .fav-tooltip, .notify-panel, .search-dropdown'

/** Overlap test against a surface: elements smaller than 2px don't count;
 *  the overlap must reach a full pixel on both axes. */
export function rectsOverlap(el: OverlayBox, box: OverlayBox): boolean {
  if (el.width < 2 || el.height < 2) return false
  return (
    Math.min(el.right, box.right) - Math.max(el.left, box.left) >= 1 &&
    Math.min(el.bottom, box.bottom) - Math.max(el.top, box.top) >= 1
  )
}

/** The keep rect for one strip element clamped to the surface: the bitmap
 *  is masked to exactly these, so the union crop carries no dark
 *  empty-player padding between or around elements. Flat [x, y, w, h]. */
export function keepRect(r: OverlayBox, box: OverlayBox): [number, number, number, number] {
  const ax = Math.max(r.left, box.left)
  const ay = Math.max(r.top, box.top)
  const bx = Math.min(r.right, box.right)
  const by = Math.min(r.bottom, box.bottom)
  return [Math.round(ax), Math.round(ay), Math.round(bx - ax), Math.round(by - ay)]
}

/** The window-space union box as fractions of the surface's OSD space —
 * the values the engine's ks-page handler multiplies by the (full,
 * unrolled) osd size. With a fold (`hiddenTop` > 0) the visible band is the
 * bottom (1 - hiddenTop) slice of the full composition, so a y fraction of
 * the VISIBLE rect maps to hiddenTop + fy·(1 - hiddenTop) of the full one
 * and heights shrink by (1 - hiddenTop); x is never folded. The native
 * pointer forwarding sends positions in this same full-composition space
 * (pointerFractions in video-fit.ts). Zero fold is the identity — unfolded
 * surfaces get their historical fractions. */
export function osdFractions(
  box: OverlayBox,
  hiddenTop: number,
  x: number,
  y: number,
  w: number,
  h: number,
): [string, string, string, string] {
  const k = Math.min(1, Math.max(0, hiddenTop))
  return [
    ((x - box.left) / box.width).toFixed(4),
    (k + ((y - box.top) / box.height) * (1 - k)).toFixed(4),
    (w / box.width).toFixed(4),
    ((h / box.height) * (1 - k)).toFixed(4),
  ]
}

/** The dedupe/geometry key for one surface's pushed overlay: the
 * window-space union box plus the surface size (a surface resize with an
 * unchanged union box must still re-push the OSD fractions) plus the fold
 * fraction (a simultaneous resize+scroll can change the fold while leaving
 * box and union identical). Only the FIRST four fields are ever parsed
 * back (the drop-retry crop) — extra fields are metadata. */
export function overlayKey(x1: number, y1: number, x2: number, y2: number, box: OverlayBox, hiddenTop = 0): string {
  const k = Math.min(1, Math.max(0, hiddenTop))
  return `${Math.round(x1)},${Math.round(y1)},${Math.round(x2)},${Math.round(y2)},${Math.round(box.width)}x${Math.round(box.height)},${Math.round(k * 1e4)}`
}

/** Run the overlay manager until the returned stop function is called
 *  (call it from the owning $effect's teardown). */
export function startPageOverlayManager(getSurfaces: () => OverlaySurface[]): () => void {
  const selector = `${FULL_OVERLAY_SELECTOR}, ${SNAP_OVERLAY_SELECTOR}`
  let suppressed = false
  // engine id -> pushed geometry key (absent = nothing shown for that engine)
  const pushed = new Map<number, string>()
  const pushedKeeps = new Map<number, number[]>()
  const seenIds = new Set<number>()
  let lastInteractSnap = 0
  let interactTail: ReturnType<typeof setTimeout> | null = null
  const retryTimers: ReturnType<typeof setTimeout>[] = []
  const setVisible = (visible: boolean): void => {
    void invoke('mpv_set_surface_visible', { visible }).catch(() => {})
  }
  const sendPage = (id: number, action: 'show' | 'hide', ...fracs: string[]): void => {
    const args = action === 'show' ? ['ks-page', 'show', ...fracs] : ['ks-page', 'hide']
    void invoke('mpv_script_msg', { id, args }).catch(() => {})
    if (action === 'hide') pushed.delete(id)
  }
  // Drop-retry: the command resolves false when the per-engine coalesce
  // guard DROPPED the request (the guard thins, it doesn't queue —
  // measured 34% of requests during pointer movement). Retry once the
  // 70 ms window has comfortably expired: a dropped FINAL request of a
  // move must not strand the overlay on stale geometry (the backstop
  // poll dedupes on an unchanged key and never resends). A redundant
  // retry is cheap — identical pixels dedupe in the Rust store.
  const snapshot = (id: number, x: number, y: number, w: number, h: number, keeps: number[]): void => {
    void invoke<boolean>('mpv_page_snapshot', {
      id,
      x: Math.round(x),
      y: Math.round(y),
      w: Math.round(w),
      h: Math.round(h),
      keep: keeps,
    })
      .then((accepted) => {
        if (accepted === false) onSnapshotDropped(id)
      })
      .catch(() => {})
  }
  const onSnapshotDropped = (id: number): void => {
    retryTimers.push(
      setTimeout(() => {
        const key = pushed.get(id)
        if (key === undefined) return
        const [x, y, x2, y2] = key.split(',').slice(0, 4).map(Number)
        snapshot(id, x, y, x2 - x, y2 - y, pushedKeeps.get(id) ?? [])
      }, 140),
    )
  }
  const recheck = (): void => {
    const surfaces = getSurfaces().flatMap((s): { id: number; box: OverlayBox; hiddenTop?: number }[] =>
      s.box === null ? [] : [{ id: s.id, box: s.box, hiddenTop: s.hiddenTop }],
    )
    if (surfaces.length === 0) return
    for (const s of surfaces) seenIds.add(s.id)
    // Full-window modals: hide the surfaces for as long as one overlaps
    // any of them. While hidden everything is live — no bitmap overlay,
    // no snapshots (a stale composited dialog must not survive the duck).
    const hide = Array.from(document.querySelectorAll<HTMLElement>(FULL_OVERLAY_SELECTOR)).some((el) =>
      surfaces.some((s) => rectsOverlap(el.getBoundingClientRect(), s.box)),
    )
    if (hide !== suppressed) {
      suppressed = hide
      setVisible(!suppressed)
      if (suppressed) {
        for (const s of surfaces) sendPage(s.id, 'hide')
      }
    }
    if (suppressed) return
    // Snapshotted strips: union of their overlap with each surface rect.
    for (const s of surfaces) {
      const pr = s.box
      let x1 = Infinity
      let y1 = Infinity
      let x2 = -Infinity
      let y2 = -Infinity
      const keeps: number[] = []
      for (const el of document.querySelectorAll<HTMLElement>(SNAP_OVERLAY_SELECTOR)) {
        if (!rectsOverlap(el.getBoundingClientRect(), pr)) continue
        const r = el.getBoundingClientRect()
        keeps.push(...keepRect(r, pr))
        x1 = Math.min(x1, Math.max(r.left, pr.left))
        y1 = Math.min(y1, Math.max(r.top, pr.top))
        x2 = Math.max(x2, Math.min(r.right, pr.right))
        y2 = Math.max(y2, Math.min(r.bottom, pr.bottom))
      }
      if (x2 <= x1) {
        sendPage(s.id, 'hide')
        continue
      }
      // Window-space box drives the snapshot crop + the dedupe key;
      // fractions of the FULL composition (fold-remapped) drive the OSD
      // geometry.
      const hidden = Math.min(1, Math.max(0, s.hiddenTop ?? 0))
      const key = overlayKey(x1, y1, x2, y2, pr, hidden)
      if (key === (pushed.get(s.id) ?? '')) continue
      pushed.set(s.id, key)
      pushedKeeps.set(s.id, keeps)
      const [fx, fy, fw, fh] = osdFractions(pr, hidden, x1, y1, x2 - x1, y2 - y1)
      sendPage(s.id, 'show', fx, fy, fw, fh)
      snapshot(s.id, x1, y1, x2 - x1, y2 - y1, keeps)
    }
  }
  recheck()
  // Coalesce bursts (chat floods, tooltip drag) to one recheck per
  // animation frame; the recheck itself is querySelectorAll + rects —
  // cheap, but not free at mutation-storm rates.
  let raf = 0
  const schedule = (): void => {
    if (raf) return
    raf = requestAnimationFrame(() => {
      raf = 0
      recheck()
    })
  }
  const isOverlayNode = (n: Node): boolean =>
    n instanceof HTMLElement && (n.matches(selector) || n.querySelector(selector) !== null)
  const mo = new MutationObserver((muts) => {
    // Cheap relevance gate — chat mutates constantly. childList counts
    // only added/removed overlay subtrees (a removal needs the full
    // re-check: another overlay may still be open). attributes count
    // the strips' own class/style flips (the tooltip moves via
    // style:left/top; the fav-tooltip reveal is a class flip), plus any
    // class flip anywhere (sidebar/theater/theme toggles can resize the
    // player or restyle a strip; the tile grid's splitters and reorders
    // flip classes too), plus documentElement style (the UI-scale zoom
    // repaints everything). characterData counts text changes inside a
    // strip (tooltip text swap).
    const relevant = muts.some((m) => {
      if (m.type === 'childList') {
        for (const n of m.addedNodes) if (isOverlayNode(n)) return true
        for (const n of m.removedNodes) if (isOverlayNode(n)) return true
        return false
      }
      if (m.type === 'attributes') {
        const el = m.target
        if (!(el instanceof Element)) return false
        if (el === document.documentElement) return true
        if (m.attributeName === 'class') return true
        return el.matches(selector)
      }
      if (m.type === 'characterData') {
        const p = m.target.parentElement
        return p instanceof Element && p.matches(selector)
      }
      return false
    })
    if (relevant) schedule()
  })
  mo.observe(document.body, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['class', 'style'],
    characterData: true,
  })
  window.addEventListener('resize', recheck)
  // Transition/animation completion inside an overlay schedules a
  // recheck. In native mode the strips' reveal animations are disabled
  // (the .app--native-video rules), so what is left are content
  // transitions (update-banner progress width, hover states); recheck's
  // geometry dedupe turns these into no-ops when nothing moved.
  const onSettle = (ev: Event): void => {
    if (ev.target instanceof Element && ev.target.closest(selector)) schedule()
  }
  document.addEventListener('transitionend', onSettle, { capture: true })
  document.addEventListener('animationend', onSettle, { capture: true })
  // Interaction refresh: clicks/keys/scrolls INSIDE a snapshotted strip
  // (notification-menu toggles, banner buttons, the menu's list scroll) and
  // the pointer CROSSING between a strip's rows (the search dropdown's
  // highlight follows the hovered row) change pixels without moving
  // geometry — one-shot re-snapshots, rate limited with a trailing edge so
  // a burst still lands its final state, gated on the event target actually
  // being in the strip.
  const snapPushedSurfaces = (): void => {
    for (const [id, key] of pushed) {
      const [x, y, x2, y2] = key.split(',').slice(0, 4).map(Number)
      snapshot(id, x, y, x2 - x, y2 - y, pushedKeeps.get(id) ?? [])
    }
  }
  const onSnapInteract = (ev: Event): void => {
    if (pushed.size === 0) return
    if (!(ev.target instanceof Element) || !ev.target.closest(SNAP_OVERLAY_SELECTOR)) return
    const now = performance.now()
    const since = now - lastInteractSnap
    if (since < INTERACT_SNAP_MS) {
      if (interactTail) clearTimeout(interactTail)
      interactTail = setTimeout(() => {
        interactTail = null
        if (pushed.size === 0) return
        lastInteractSnap = performance.now()
        snapPushedSurfaces()
      }, INTERACT_SNAP_MS - since)
      return
    }
    lastInteractSnap = now
    snapPushedSurfaces()
  }
  const interactTypes = ['pointerdown', 'pointerover', 'keyup', 'scroll', 'wheel'] as const
  for (const ty of interactTypes) document.addEventListener(ty, onSnapInteract, { capture: true, passive: true })
  // Low-frequency safety poll — the BACKSTOP only. Covered by events:
  // {#if}-driven show/hide of every strip (childList), the tooltip's
  // show/hide/move (childList + style attributes + text), class-flip
  // reveals (fav-tooltip) and any UI-toggle class change, window resize
  // (explicit listener), transition/animation ends inside overlays. NOT
  // proven to emit an event: surface-rect geometry changes from layout
  // toggles (sidebar collapse, theater mode, chat resize, tile splitters)
  // when no strip attribute changes — those land here within 400 ms.
  // Deliberately kept absent: a raw scroll GEOMETRY listener (every
  // selector element is position:fixed, page scrolling never moves them,
  // and chat autoscroll would storm the recheck) and a periodic PIXEL
  // refresh (recheck re-snapshots only when the union geometry key
  // changes — idle strips dedupe to no-ops).
  const geoIv = setInterval(recheck, 400)
  return () => {
    mo.disconnect()
    window.removeEventListener('resize', recheck)
    for (const ty of interactTypes) document.removeEventListener(ty, onSnapInteract, { capture: true })
    document.removeEventListener('transitionend', onSettle, { capture: true })
    document.removeEventListener('animationend', onSettle, { capture: true })
    if (raf) cancelAnimationFrame(raf)
    clearInterval(geoIv)
    if (interactTail) clearTimeout(interactTail)
    for (const tm of retryTimers) clearTimeout(tm)
    // Leaving native mode must not leave a hidden surface or a stale
    // overlay composited.
    if (suppressed) setVisible(true)
    for (const id of seenIds) sendPage(id, 'hide')
  }
}
