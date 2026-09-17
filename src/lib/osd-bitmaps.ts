/*
 * OSD bitmap decode — the mpv OSD can only draw vectors, so the images it
 * shows (the channel avatar circle + storyboard hover thumbnails) are decoded
 * HERE in the webview, from what the app already has: avatars load with
 * crossOrigin=anonymous (static-cdn.jtvnw.net sends ACAO:*, verified against
 * the live CDN), storyboard strips through the ksvod proxy (the VOD CDN sends
 * no CORS; the proxy adds it). Raw BGRA + base64 go to the Rust engine via
 * mpv_set_bitmap; Rust resamples/crops and composites with mpv's overlay-add.
 * No new hosts, no fetches the page doesn't already make.
 */

export interface OsdBitmap {
  b64: string
  w: number
  h: number
}

function toBgraBase64(data: Uint8ClampedArray): string {
  // RGBA → BGRA in place, then base64 in chunks (btoa takes strings, and
  // spreading megabytes at once would blow the argument limit).
  for (let i = 0; i < data.length; i += 4) {
    const r = data[i]
    data[i] = data[i + 2]
    data[i + 2] = r
  }
  let bin = ''
  const CHUNK = 0x8000
  for (let i = 0; i < data.length; i += CHUNK) {
    bin += String.fromCharCode(...data.subarray(i, i + CHUNK))
  }
  return btoa(bin)
}

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.crossOrigin = 'anonymous'
    img.onload = () => resolve(img)
    img.onerror = () => reject(new Error('image load failed'))
    img.src = url
  })
}

/** One storyboard strip, resampled onto a cols × rows grid of tileW × tileH
 *  cells (160px tiles keep the payload reasonable while staying sharp at the
 *  ~160·s display size). `url` must already be ksvod-proxied. */
export async function stripBitmap(
  url: string,
  cols: number,
  rows: number,
  tileW: number,
  tileH: number,
): Promise<OsdBitmap | null> {
  try {
    const res = await fetch(url)
    if (!res.ok) return null
    const bmp = await createImageBitmap(await res.blob())
    const w = cols * tileW
    const h = rows * tileH
    const canvas = document.createElement('canvas')
    canvas.width = w
    canvas.height = h
    const ctx = canvas.getContext('2d', { willReadFrequently: true })
    if (!ctx) return null
    ctx.drawImage(bmp, 0, 0, w, h)
    bmp.close()
    return { b64: toBgraBase64(ctx.getImageData(0, 0, w, h).data), w, h }
  } catch {
    return null // storyboard is the most optional of the VOD extras
  }
}

/** Inputs for the top-left info block, at the OSD's DEVICE-px metrics (the
 *  sizes mirror ks-osc.lua's layout math exactly so the bitmap can replace
 *  its text rendering 1:1 — see the App.svelte effect that calls this). */
export interface InfoBlockInput {
  title: string
  extra: string
  avatarUrl?: string
  /** CSS colors (any canvas-parseable form). */
  text: string
  dim: string
  /** ks-osc.lua's s: clamp(osdH / 720 * uiScale, 0.6, 3.0), osdH in device px. */
  s: number
  uiScale: number
  dpr: number
  /** Device-px cap for the whole block (player width minus its margins). */
  maxWidth: number
}

/** The top-left stream info (avatar circle + bold title + "game · N
 *  viewers") as ONE bitmap, rendered by the webview's own font stack.
 *  Why not libass: it cannot SELECT bitmap-only emoji fonts, so titles
 *  with emoji lose their color — the webview renders color emoji
 *  natively (chat already relies on it), and the whole block composites
 *  over the video through the same overlay-add path as the storyboard
 *  thumbnails. Sizes mirror the Lua layout: title 16·s, extra
 *  13·s, avatar 32css·uiScale·dpr, 10·s gap. */
export async function renderInfoBlock(input: InfoBlockInput): Promise<OsdBitmap | null> {
  const { title, extra, text, dim, s, uiScale, dpr, maxWidth } = input
  if (!title && !extra) return null
  try {
    const fs1 = Math.max(6, Math.round(16 * s))
    const fs2 = Math.max(5, Math.round(13 * s))
    const gap = Math.max(2, Math.round(10 * s))
    const avatar = input.avatarUrl ? Math.max(8, Math.round(32 * uiScale * dpr)) : 0
    const canvas = document.createElement('canvas')
    const ctx = canvas.getContext('2d', { willReadFrequently: true })
    if (!ctx) return null

    const font1 = `bold ${fs1}px sans-serif`
    const font2 = `${fs2}px sans-serif`
    // Measure first, then size the canvas to the content.
    ctx.font = font1
    const maxTextW = Math.max(40, maxWidth - (avatar ? avatar + gap : 0))
    const ellipsize = (str: string, font: string): string => {
      ctx.font = font
      if (!str || ctx.measureText(str).width <= maxTextW) return str
      let lo = 0
      let hi = str.length
      while (lo < hi) {
        const mid = (lo + hi + 1) >> 1
        if (ctx.measureText(`${str.slice(0, mid)}…`).width <= maxTextW) lo = mid
        else hi = mid - 1
      }
      return `${str.slice(0, lo)}…`
    }
    const t1 = ellipsize(title, font1)
    const t2 = ellipsize(extra, font2)
    ctx.font = font1
    const w1 = t1 ? ctx.measureText(t1).width : 0
    ctx.font = font2
    const w2 = t2 ? ctx.measureText(t2).width : 0
    const textW = Math.ceil(Math.max(w1, w2))
    // Extra line sits fs1·1.5 below the top (mirroring the Lua layout);
    // give it full ascent+descender room (×1.4) plus a small pad so
    // descenders of the game/viewers line are never clipped.
    const textH = t1 && t2 ? Math.ceil(fs1 * 1.5 + fs2 * 1.45) : Math.ceil(Math.max(fs1, fs2) * 1.35)
    const w = (avatar ? avatar + gap : 0) + Math.max(1, Math.min(textW, maxTextW))
    const h = Math.max(avatar, textH)
    if (w < 2 || h < 2) return null
    canvas.width = w
    canvas.height = h

    if (avatar && input.avatarUrl) {
      try {
        const img = await loadImage(input.avatarUrl)
        const iw = img.naturalWidth || avatar
        const ih = img.naturalHeight || avatar
        const side = Math.min(iw, ih)
        ctx.drawImage(img, (iw - side) / 2, (ih - side) / 2, side, side, 0, 0, avatar, avatar)
        ctx.globalCompositeOperation = 'destination-in'
        ctx.beginPath()
        ctx.arc(avatar / 2, avatar / 2, avatar / 2, 0, Math.PI * 2)
        ctx.fill()
        ctx.globalCompositeOperation = 'source-over'
      } catch {
        /* avatar optional — leave the slot empty and shift text is fine */
      }
    }
    const tx = avatar ? avatar + gap : 0
    ctx.font = font1
    ctx.fillStyle = text
    ctx.textBaseline = 'top'
    if (t1) ctx.fillText(t1, tx, 0)
    ctx.font = font2
    ctx.fillStyle = dim
    if (t2) ctx.fillText(t2, tx, t1 ? Math.round(fs1 * 1.5) : 0)
    return { b64: toBgraBase64(ctx.getImageData(0, 0, w, h).data), w, h }
  } catch {
    return null // text-only OSD path stays as the fallback
  }
}
