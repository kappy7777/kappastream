-- ks-osc — Kappastream's in-video control OSD (replaces mpv's stock osc).
--
-- The webview sits UNDER the native video surface, so in-video UI can only
-- be drawn by mpv itself. This script draws a control bar that mirrors the
-- app's hls.js overlay: bottom bar (seek bar + play/pause/stop/mute/volume/
-- time … quality/PiP/mpv/theater/fullscreen) and a stream-info block in the
-- top-left. The Rust host embeds it (the `scripts` option) with osc=no.
--
-- Data comes IN via script messages (all from the app):
--   ks-theme <overlay> <accent> <text> <dim> <border> <live>   RRGGBB hex, no '#'
--   ks-qualities <header> <current> <q1> [q2 ...]  gear menu; empty list hides it
--   ks-pip <0|1>  ks-theater <0|1>  ks-fullscreen <0|1>        toggle highlights
--   ks-chapters <n> <sec> <label> ...      VOD chapter marks (labels keep spaces)
--   ks-muted <n> <start> <end> ...         VOD muted segments (seconds)
--   ks-storyboard <interval> <count> <cols> <rows> <strips> <tileW> <tileH>
--     seek-hover thumbnails (interval 0 = none); the pixels ride mpv_set_bitmap
--   ks-page <show xfrac yfrac wfrac hfrac | hide>
--     page-UI snapshot overlay (dialogs/tooltips over the video); fractions
--     of the video rect, converted to OSD units here (see the handler)
--   ks-infoblock <1 w h | 0>
--     top-left info block (avatar + title + "game · N viewers"), rendered
--     by the WEBVIEW as one bitmap — its font stack handles COLOR emoji,
--     which libass structurally cannot
--   ks-disable <0|1>
--     1 = this core never shows the OSD bar at all (kept for optional use;
--     multi-view tiles use ks-mode instead — the bar stays on, trimmed).
--     The ks-page overlay handler stays live while disabled.
--   ks-mode <tile|live|vod>
--     tile: multi-view engines — minimal bar (play/mute/volume/◀▶/gear/X),
--     channel label top-left (ks-label), never a seek strip.
--     live: single-view live — never a seek strip (mpv's HLS demuxer
--     reports a playlist pseudo-duration even on live).
--     vod:  single-view VOD/clip — full bar with seek strip + time.
--   ks-label <name>
--     The tile chrome label (the channel name).
-- Actions go OUT as script messages the Rust event thread relays:
--   ks-action <stop|pip|mpv|theater|fullscreen|quality:<label>>
--   ks-overlay <thumb|page|infoblock> <show x y w h strip tile | show x y w h | hide>
--     image-overlay geometry (hover thumbnails + the page-UI snapshot + the
--     info block) — Rust resamples the uploaded BGRA and composites
--     it via overlay-add; this side owns WHEN and WHERE (layout truth
--     lives in render(), except ks-page which replies immediately so a
--     dialog stays overlaid while the OSD itself is hidden).
-- Transport (play/pause/volume/mute/seek) is applied locally on the mpv
-- core via mp.set_property_native — mpv 0.40's Lua mp.set_property takes
-- STRING values only (numbers silently coerce, booleans throw a Lua error,
-- and ONE error inside a callback bricks the script's input dispatch for
-- the whole session — observed + probed against the bundled libmpv).
--
-- Pointer input arrives through the app's forwarded mpv_pointer commands
-- (mouse <x,y> / keypress WHEEL_*), which drive mouse-pos and the
-- mouse_move / mbtn_left / wheel_up / wheel_down bindings below.

local mp = require 'mp'
local assdraw = require 'mp.assdraw'

-- ---------------------------------------------------------------------------
-- state

local osd = mp.create_osd_overlay("ass-events")
osd.z = 3

local state = {
    loaded = false,
    visible = false,
    -- Never show the bar (multi-view tile engines — see ks-disable). The
    -- ks-page overlay handler deliberately STAYS live while disabled.
    disabled = false,
    -- Multi-view TILE mode (ks-mode tile): hides the app-global buttons
    -- (pip / mpv handoff / theater) — the tile bar keeps play/stop/mute/
    -- volume/LIVE + quality gear + fullscreen — and draws the tile chrome
    -- (channel label top-left, move button top-right).
    tile = false,
    -- LIVE playback (tile mode implies it): no seek strip — mpv's HLS
    -- demuxer reports a playlist pseudo-duration even on live streams,
    -- which would otherwise draw a jumpable seek bar. VODs/clips keep it.
    live = false,
    label = "",
    last_activity = 0,
    -- playback (observed properties)
    paused = true,
    duration = 0,
    volume = 100,
    mute = false,
    -- pointer interaction
    hover_id = nil,   -- hit-area id under the pointer
    hover_seek = nil, -- fraction while hovering the seek strip
    scrub = nil,      -- seek-preview fraction while click-dragging
    last_click = { t = 0, id = nil },
    popup = false,    -- quality list open
    -- app-fed data
    infoblock = nil,  -- { w, h } while the webview-rendered info-block bitmap
                      -- is uploaded; nil = nothing draws in the top-left
    qualities = nil,  -- array of labels; nil = quality menu unavailable
    quality = "",
    q_header = "",   -- localized "Quality" menu header
    chapters = {},   -- { { s = startSec, label = "…" }, … }
    muted = {},      -- { { s = startSec, e = endSec }, … }
    sb = nil,        -- storyboard: { interval, count, cols, rows, strips, tileW, tileH }
    pip = false,
    theater = false,
    fullscreen = false,
    -- UI-scale multiplier from the app (the OSD scales with the VIDEO;
    -- the app's HTML scales with uiScale — multiply to keep them in step)
    scale = 1.0,
}

-- Theme defaults mirror the app's default theme (amethyst); the app sends
-- the live values (per-theme) via ks-theme. All RRGGBB.
local theme = {
    overlay = "0e0e10",
    accent  = "6d5dd3",
    text    = "efeff1",
    dim     = "adadb8",
    border  = "2a2a2d",
    live    = "eb0400",
}

-- ---------------------------------------------------------------------------
-- small utils

local function clamp(v, lo, hi)
    if v < lo then return lo end
    if v > hi then return hi end
    return v
end

local function fmt_time(t)
    t = math.max(0, math.floor(t or 0))
    local h = math.floor(t / 3600)
    local m = math.floor((t % 3600) / 60)
    local s = t % 60
    if h > 0 then return string.format("%d:%02d:%02d", h, m, s) end
    return string.format("%d:%02d", m, s)
end

local function esc(text)
    return (tostring(text or ""):gsub("[{}\\\n\r]", " "))
end

-- RRGGBB -> ASS &HBBGGRR&
local function bgr(rgb)
    if rgb == nil or #rgb ~= 6 then return "&HFFFFFF&" end
    return string.format("&H%s%s%s&", rgb:sub(5, 6), rgb:sub(3, 4), rgb:sub(1, 2))
end

local function alpha_tag(a)
    return string.format("&H%02X", clamp(math.floor(a), 0, 255))
end

-- Every callback mpv dispatches (key bindings, timers) runs guarded: one
-- uncaught Lua error bricks the script's input dispatch for the whole
-- session on this libmpv, so a bug must degrade to a logged line instead.
local function guard(fn)
    return function(...)
        local ok, err = pcall(fn, ...)
        if not ok then print("ks-osc error: " .. tostring(err)) end
    end
end

-- ---------------------------------------------------------------------------
-- ASS drawing helpers (drawings in ABSOLUTE OSD pixels, \pos(0,0)\an7)

local function new_ass()
    local a = assdraw.ass_new()
    a.scale = 1 -- pixel units
    return a
end

local function shape_begin(a, color, al)
    a:new_event()
    a:pos(0, 0)
    a:an(7)
    a:append(string.format(
        "{\\1c%s\\1a%s\\3a&HFF&\\4a&HFF&\\bord0\\shad0\\blur0\\fscx100\\fscy100\\p1}",
        bgr(color), alpha_tag(al)))
end

local function rect(a, x1, y1, x2, y2, color, al)
    shape_begin(a, color, al)
    a:rect_cw(x1, y1, x2, y2)
    a:draw_stop()
end

-- A stroked rectangle: filled outer ring (even-odd with the inner cut).
local function frame(a, x1, y1, x2, y2, t, color, al)
    shape_begin(a, color, al)
    a:rect_cw(x1, y1, x2, y2)
    a:rect_ccw(x1 + t, y1 + t, x2 - t, y2 - t)
    a:draw_stop()
end

local function text_ev(a, x, y, an, body, size, color, al, bold)
    a:new_event()
    a:pos(x, y)
    a:an(an)
    a:append(string.format(
        "{\\fs%d\\fnsans-serif\\1c%s\\1a%s\\bord0\\shad0\\blur0\\fscx100\\fscy100%s}",
        math.floor(size + 0.5), bgr(color), alpha_tag(al), bold and "\\b1" or "\\b0"))
    a:append(esc(body))
end

-- ---------------------------------------------------------------------------
-- icons (drawn inside a 24-unit box scaled by u = box/24; x,y = box origin)
local function icon_play(a, x, y, u, color, al)
    shape_begin(a, color, al)
    a:move_to(x + 7.5 * u, y + 5 * u)
    a:line_to(x + 18.5 * u, y + 12 * u)
    a:line_to(x + 7.5 * u, y + 19 * u)
    a:draw_stop()
end

local function icon_pause(a, x, y, u, color, al)
    rect(a, x + 7 * u, y + 5 * u, x + 11 * u, y + 19 * u, color, al)
    rect(a, x + 14 * u, y + 5 * u, x + 18 * u, y + 19 * u, color, al)
end

local function icon_stop(a, x, y, u, color, al)
    rect(a, x + 6 * u, y + 6 * u, x + 18 * u, y + 18 * u, color, al)
end

local function icon_speaker(a, x, y, u, color, al, muted, loud)
    shape_begin(a, color, al)
    a:move_to(x + 3 * u, y + 9 * u)
    a:line_to(x + 7 * u, y + 9 * u)
    a:line_to(x + 12 * u, y + 4 * u)
    a:line_to(x + 12 * u, y + 20 * u)
    a:line_to(x + 7 * u, y + 15 * u)
    a:line_to(x + 3 * u, y + 15 * u)
    a:draw_stop()
    if muted then
        -- X over the speaker: two thin diagonal quads
        shape_begin(a, color, al)
        a:move_to(x + 14.5 * u, y + 8 * u)
        a:line_to(x + 16 * u, y + 8 * u)
        a:line_to(x + 20 * u, y + 16 * u)
        a:line_to(x + 18.5 * u, y + 16 * u)
        a:draw_stop()
        shape_begin(a, color, al)
        a:move_to(x + 18.5 * u, y + 8 * u)
        a:line_to(x + 20 * u, y + 8 * u)
        a:line_to(x + 16 * u, y + 16 * u)
        a:line_to(x + 14.5 * u, y + 16 * u)
        a:draw_stop()
    else
        -- two "wave" bars of increasing height
        rect(a, x + 15 * u, y + 10.5 * u, x + 16.5 * u, y + 13.5 * u, color, al)
        if loud then
            rect(a, x + 18.5 * u, y + 8.5 * u, x + 20 * u, y + 15.5 * u, color, al)
        end
    end
end

local function icon_pip(a, x, y, u, color, al)
    frame(a, x + 3 * u, y + 4 * u, x + 21 * u, y + 18 * u, 1.8 * u, color, al)
    rect(a, x + 12 * u, y + 10 * u, x + 20 * u, y + 16 * u, color, al)
end

local function icon_external(a, x, y, u, color, al)
    -- screen + play glyph (the app's "open in mpv" mark)
    frame(a, x + 2 * u, y + 4 * u, x + 22 * u, y + 18 * u, 1.8 * u, color, al)
    shape_begin(a, color, al)
    a:move_to(x + 9 * u, y + 7.5 * u)
    a:line_to(x + 16 * u, y + 11 * u)
    a:line_to(x + 9 * u, y + 14.5 * u)
    a:draw_stop()
end

local function icon_theater(a, x, y, u, color, al)
    rect(a, x + 3 * u, y + 4 * u, x + 21 * u, y + 6.5 * u, color, al)
    frame(a, x + 5 * u, y + 9 * u, x + 19 * u, y + 17 * u, 1.8 * u, color, al)
end

local function icon_fullscreen(a, x, y, u, color, al)
    local t = 2 * u
    local long = 7 * u
    local x2, y2 = x + 21 * u, y + 21 * u
    -- four corner brackets (clockwise from top-left)
    rect(a, x + 3 * u, y + 3 * u, x + 3 * u + long, y + 3 * u + t, color, al)
    rect(a, x + 3 * u, y + 3 * u, x + 3 * u + t, y + 3 * u + long, color, al)
    rect(a, x2 - long, y + 3 * u, x2, y + 3 * u + t, color, al)
    rect(a, x2 - t, y + 3 * u, x2, y + 3 * u + long, color, al)
    rect(a, x + 3 * u, y2 - t, x + 3 * u + long, y2, color, al)
    rect(a, x + 3 * u, y2 - long, x + 3 * u + t, y2, color, al)
    rect(a, x2 - long, y2 - t, x2, y2, color, al)
    rect(a, x2 - t, y2 - long, x2, y2, color, al)
end

-- Tile reorder arrows (tile mode only): solid triangles in the bar.
local function icon_arr_left(a, x, y, u, color, al)
    shape_begin(a, color, al)
    a:move_to(x + 15 * u, y + 6 * u)
    a:line_to(x + 7 * u, y + 12 * u)
    a:line_to(x + 15 * u, y + 18 * u)
end

local function icon_arr_right(a, x, y, u, color, al)
    shape_begin(a, color, al)
    a:move_to(x + 9 * u, y + 6 * u)
    a:line_to(x + 17 * u, y + 12 * u)
    a:line_to(x + 9 * u, y + 18 * u)
end

-- The tile close X (tile mode only, far right — hls.js parity; mirrors
-- what the stop button already does on a tile): two thick diagonal bars.
local function icon_close(a, x, y, u, color, al)
    local d = 1.13 * u -- half-thickness offset (√2/2 · 1.6)
    shape_begin(a, color, al)
    a:move_to(x + 7 * u + d, y + 7 * u - d)
    a:line_to(x + 17 * u + d, y + 17 * u - d)
    a:line_to(x + 17 * u - d, y + 17 * u + d)
    a:line_to(x + 7 * u - d, y + 7 * u + d)
    a:draw_stop()
    shape_begin(a, color, al)
    a:move_to(x + 17 * u + d, y + 7 * u + d)
    a:line_to(x + 7 * u + d, y + 17 * u + d)
    a:line_to(x + 7 * u - d, y + 17 * u - d)
    a:line_to(x + 17 * u - d, y + 7 * u - d)
    a:draw_stop()
end

-- The settings gear (the app's quality-menu trigger, hls.js look): an
-- 8-tooth ring with the hole cut by a reversed-winding subpath — the same
-- even-odd trick `frame()` uses for stroked rectangles.
local function icon_gear(a, x, y, u, color, al)
    local cx, cy = x + 12 * u, y + 12 * u
    local r_out, r_ring, r_hole = 9.6 * u, 6.4 * u, 3.1 * u
    shape_begin(a, color, al)
    for i = 0, 7 do
        local base = i * 45
        local points = {
            { r_out, base - 9 }, { r_out, base + 9 }, -- tooth
            { r_ring, base + 14 }, { r_ring, base + 31 }, -- ring gap
        }
        for _, p in ipairs(points) do
            local rad = p[2] * math.pi / 180
            local px, py = cx + p[1] * math.cos(rad), cy + p[1] * math.sin(rad)
            if i == 0 and p == points[1] then
                a:move_to(px, py)
            else
                a:line_to(px, py)
            end
        end
    end
    for i = 7, 0, -1 do -- hole, opposite winding
        local rad = (i * 45 + 22.5) * math.pi / 180
        local px, py = cx + r_hole * math.cos(rad), cy + r_hole * math.sin(rad)
        if i == 7 then
            a:move_to(px, py)
        else
            a:line_to(px, py)
        end
    end
    a:draw_stop()
end

-- The check mark shown next to the active quality row.
local function icon_check(a, x, y, u, color, al)
    shape_begin(a, color, al)
    a:move_to(x, y + 5 * u)
    a:line_to(x + 2.2 * u, y + 7.2 * u)
    a:line_to(x + 7 * u, y + 1.6 * u)
    a:line_to(x + 8.4 * u, y + 3 * u)
    a:line_to(x + 2.2 * u, y + 10 * u)
    a:line_to(x - 1.4 * u, y + 6.4 * u)
    a:draw_stop()
end

-- ---------------------------------------------------------------------------
-- layout + render

local hit_areas = {}

local function add_hit(x1, y1, x2, y2, id)
    hit_areas[#hit_areas + 1] = { x1 = x1, y1 = y1, x2 = x2, y2 = y2, id = id }
end

local function hit_at(x, y)
    for _, ha in ipairs(hit_areas) do
        if x >= ha.x1 and x <= ha.x2 and y >= ha.y1 and y <= ha.y2 then
            return ha.id
        end
    end
    return nil
end

-- The UI scale factor (osd height / 720 × the app's uiScale) + osd size.
-- Shared by render, move and click so hit-testing and drawing always agree.
local function ui_s()
    local w, h = mp.get_osd_size()
    return clamp((h or 0) / 720 * state.scale, 0.6, 3.0), w, h
end

local unpack_fn = table.unpack or unpack

-- Image-overlay geometry OUT to Rust (hover thumbnails, the page-UI
-- snapshot overlay, the info block). Numbers are floored: commandv stringifies
-- Lua numbers with full float precision, and the Rust side parses them as
-- integers. Hides are gated on a transition (the render tick would
-- otherwise re-send them at ~16 Hz); shows re-send freely — Rust dedupes
-- unchanged geometry and re-issues on resize, which is exactly what a
-- moving layout needs.
local overlay_on = { thumb = false, page = false, infoblock = false }
local function send_overlay(kind, action, ...)
    if action == "hide" and not overlay_on[kind] then return end
    overlay_on[kind] = action ~= "hide"
    local args = { "ks-overlay", kind, action }
    for _, v in ipairs({ ... }) do
        args[#args + 1] = tostring(math.floor(v + 0.5))
    end
    mp.commandv("script-message", unpack_fn(args))
end

-- The chapter in effect at t (latest start <= t), or nil — mirrors
-- chapterAt() in vod-extras.ts.
local function chapter_at(t)
    local found = nil
    for _, c in ipairs(state.chapters) do
        if c.s <= t then
            found = c
        else
            break
        end
    end
    return found
end

local function render()
    hit_areas = {}
    local s, w, h = ui_s()
    if w == nil or w <= 0 or h <= 0 then return end
    local a = new_ass()

    local bar_h = 40 * s
    local bar_y = h - bar_h
    local pad = 10 * s
    local btn = 32 * s
    local icon_u = (22 * s) / 24

    -- bar background: the hls.js controls fade from --bg-overlay
    -- (rgba(…,0.85)) at the BOTTOM to fully transparent at the TOP — a
    -- bottom-to-top gradient, not a flat band. ASS quads can't gradient-
    -- fill, so approximate with ~2px strips whose alpha runs 255 (top,
    -- invisible) → 38 (bottom, 0.85 opacity). ASS alpha is linear in
    -- opacity, so strip interpolation reproduces the CSS gradient exactly;
    -- strips share edge coordinates, and their 1-unit horizontal inset
    -- keeps side seams out of view.
    do
        local scrim_h = h - bar_y
        local strips = math.max(1, math.ceil(scrim_h / (2 * s)))
        local strip_h = scrim_h / strips
        for i = 0, strips - 1 do
            local f = i / math.max(strips - 1, 1) -- 0 top → 1 bottom
            local al = math.floor(38 + (255 - 38) * (1 - f))
            if al < 255 then
                rect(a, 1, bar_y + i * strip_h, w - 1,
                    bar_y + (i + 1) * strip_h, theme.overlay, al)
            end
        end
    end

    local duration = state.duration or 0
    -- No seek strip on live playback (tile mode implies live): mpv's HLS
    -- demuxer reports a playlist pseudo-duration that would otherwise draw
    -- a jumpable seek bar on a live stream. VODs/clips keep it.
    local seekable = not state.live and duration > 1

    -- seek strip along the bar's top edge (VOD/clip); plain bar for live
    local strip_y = bar_y
    local strip_h = seekable and 4 * s or 0
    if seekable then
        rect(a, pad, strip_y, w - pad, strip_y + strip_h, theme.border, 0)
        local frac = state.scrub
            or clamp((mp.get_property_number("time-pos") or 0) / duration, 0, 1)
        rect(a, pad, strip_y, pad + (w - 2 * pad) * frac, strip_y + strip_h, theme.accent, 0)
        -- muted segments: dark-red base + slanted bright stripes (hls.js look)
        for _, m in ipairs(state.muted) do
            local x1 = pad + (w - 2 * pad) * clamp(m.s / duration, 0, 1)
            local x2 = pad + (w - 2 * pad) * clamp(m.e / duration, 0, 1)
            if x2 > x1 then
                rect(a, x1, strip_y, x2, strip_y + strip_h, "781414", 0)
                local x = x1
                while x + 3 * s + strip_h <= x2 do
                    shape_begin(a, "e53935", 0)
                    a:move_to(x, strip_y + strip_h)
                    a:line_to(x + 3 * s, strip_y + strip_h)
                    a:line_to(x + 3 * s + strip_h, strip_y)
                    a:line_to(x + strip_h, strip_y)
                    a:draw_stop()
                    x = x + 6 * s
                end
            end
        end
        -- chapter ticks (start marks > 0, hls.js look)
        for _, c in ipairs(state.chapters) do
            if c.s > 0 and c.s < duration then
                local cx = pad + (w - 2 * pad) * (c.s / duration)
                rect(a, cx - 1.5 * s, strip_y - 4 * s, cx + 1.5 * s, strip_y + strip_h + 4 * s,
                    "ffffff", 60)
            end
        end
        add_hit(pad - 4 * s, strip_y - 10 * s, w - pad + 4 * s, strip_y + 12 * s, "seek")
        -- hover/scrub preview: thumbnail (storyboard) + "time · chapter" bubble
        local hfrac = state.scrub or state.hover_seek
        if hfrac then
            local hx = pad + (w - 2 * pad) * hfrac
            local t = hfrac * duration
            local label = fmt_time(t)
            local chap = chapter_at(t)
            if chap then
                label = label .. "  ·  " .. chap.label
            end
            local bubble_y = strip_y - 8 * s
            local shown = false
            if state.sb and state.sb.count > 0 then
                local tw = math.floor(160 * s + 0.5)
                local th = math.floor(tw * state.sb.tileH / state.sb.tileW + 0.5)
                local idx = math.min(math.floor(t / state.sb.interval), state.sb.count - 1)
                local per = state.sb.cols * state.sb.rows
                local img = math.floor(idx / per)
                if idx >= 0 and img < state.sb.strips then
                    local tx = clamp(hx - tw / 2, pad, w - pad - tw)
                    local ty = strip_y - th - 26 * s
                    send_overlay("thumb", "show", tx, ty, tw, th, img, idx % per)
                    shown = true
                    bubble_y = ty + th + 18 * s
                end
            end
            if not shown then
                send_overlay("thumb", "hide")
            end
            text_ev(a, clamp(hx, pad + 30 * s, w - pad - 30 * s), bubble_y, 2,
                label, 15 * s, theme.text, 0)
        else
            send_overlay("thumb", "hide")
        end
    end

    -- controls row: centered in the bar (below the seek strip when present)
    local row_cy = bar_y + (bar_h + strip_h) / 2
    local icon_y = row_cy - 11 * s
    local x = pad

    local function draw_button(id, icon_fn, active)
        local hovered = state.hover_id == id
        local color = active and theme.accent or theme.text
        local al = active and 0 or (hovered and 0 or 40)
        if hovered then
            rect(a, x, row_cy - btn / 2, x + btn, row_cy + btn / 2, theme.text, 224)
        end
        icon_fn(a, x + (btn - 22 * s) / 2, icon_y, icon_u, color, al)
        add_hit(x - 2 * s, row_cy - btn / 2 - 4 * s, x + btn + 2 * s, row_cy + btn / 2 + 4 * s, id)
        x = x + btn
    end

    if state.paused then
        draw_button("play", icon_play, false)
    else
        draw_button("play", icon_pause, false)
    end
    -- no stop button in tile mode (the far-right X closes the tile)
    if not state.tile then
        draw_button("stop", icon_stop, false)
    end

    -- mute + volume bar
    local muted = state.mute or state.volume <= 0
    do
        local id = "mute"
        local hovered = state.hover_id == id
        if hovered then
            rect(a, x, row_cy - btn / 2, x + btn, row_cy + btn / 2, theme.text, 224)
        end
        icon_speaker(a, x + (btn - 22 * s) / 2, icon_y, icon_u,
            theme.text, hovered and 0 or 40,
            muted, state.volume > 50)
        add_hit(x - 2 * s, row_cy - btn / 2 - 4 * s, x + btn + 2 * s, row_cy + btn / 2 + 4 * s, id)
        x = x + btn
    end
    x = x + 4 * s
    do
        local vw = 78 * s
        local vy = row_cy - 2.5 * s
        local vf = clamp(state.volume / 100, 0, 1)
        rect(a, x, vy, x + vw, vy + 5 * s, theme.border, 0)
        rect(a, x, vy, x + vw * vf, vy + 5 * s, theme.text, 0)
        -- handle
        rect(a, x + vw * vf - 4 * s, vy - 2.5 * s, x + vw * vf + 4 * s, vy + 7.5 * s,
            theme.text, 0)
        add_hit(x - 4 * s, vy - 9 * s, x + vw + 4 * s, vy + 15 * s, "vol")
        x = x + vw + 8 * s
    end

    -- time / LIVE badge — skipped in tile mode (tiles are always live, and
    -- the bar stays minimal: play, mute, volume, arrows, quality, X)
    if not state.tile then
        if seekable then
            local t = (state.scrub or clamp((mp.get_property_number("time-pos") or 0) / duration, 0, 1))
                * duration
            text_ev(a, x, row_cy, 4,
                fmt_time(t) .. " / " .. fmt_time(duration), 14 * s, theme.dim, 0)
            x = x + 118 * s
        else
            rect(a, x, row_cy - 3 * s, x + 6 * s, row_cy + 3 * s, theme.live, 0)
            text_ev(a, x + 10 * s, row_cy, 4, "LIVE", 13 * s, theme.live, 0, true)
            x = x + 48 * s
        end
    end

    -- right-aligned group (hls.js order): gear(quality), pip, mpv, theater,
    -- fullscreen — drawn RIGHT-TO-LEFT, so the array runs fullscreen→gear.
    -- The gear renders only when the app sent a quality list. TILE mode
    -- adds the reorder arrows (◀/▶ swap with the neighbouring slot) and
    -- the close X, and drops the app-global buttons + fullscreen.
    local rx = w - pad
    local buttons = {
        { id = "close",      icon = icon_close,      active = false,            enabled = state.tile },
        { id = "fullscreen", icon = icon_fullscreen, active = state.fullscreen, enabled = not state.tile },
        { id = "theater",    icon = icon_theater,    active = state.theater,    enabled = not state.tile },
        { id = "mpv",        icon = icon_external,   active = false,            enabled = not state.tile },
        { id = "pip",        icon = icon_pip,        active = state.pip,        enabled = not state.tile },
        { id = "quality",    icon = icon_gear,       active = false, enabled = state.qualities ~= nil },
        { id = "moveright",  icon = icon_arr_right,  active = false,            enabled = state.tile },
        { id = "moveleft",   icon = icon_arr_left,   active = false,            enabled = state.tile },
    }
    local gear_rx = nil
    for _, b in ipairs(buttons) do
        rx = rx - btn
        if b.enabled then
            local hovered = state.hover_id == b.id
            if hovered then
                rect(a, rx, row_cy - btn / 2, rx + btn, row_cy + btn / 2, theme.text, 224)
            end
            b.icon(a, rx + (btn - 22 * s) / 2, icon_y, icon_u,
                b.active and theme.accent or theme.text,
                b.active and 0 or (hovered and 0 or 40))
            add_hit(rx - 2 * s, row_cy - btn / 2 - 4 * s, rx + btn + 2 * s,
                row_cy + btn / 2 + 4 * s, b.id)
            if b.id == "quality" then
                gear_rx = rx
            end
        else
            rx = rx + btn -- disabled buttons leave their slot free
        end
    end

    -- quality menu (hls.js look: header + rows, check on the active one)
    if state.popup and state.qualities and gear_rx then
        local row_h = 30 * s
        local menu_w = 170 * s
        local header_h = 26 * s
        local menu_h = header_h + row_h * #state.qualities + 8 * s
        local mx = clamp(gear_rx + btn - menu_w, pad, w - pad - menu_w)
        local my = bar_y - menu_h - 8 * s
        rect(a, mx, my, mx + menu_w, my + menu_h, theme.overlay, 20)
        frame(a, mx, my, mx + menu_w, my + menu_h, 1 * s, theme.border, 0)
        local header = state.q_header ~= "" and state.q_header or "Quality"
        text_ev(a, mx + 14 * s, my + 6 * s, 7, string.upper(header), 11 * s,
            theme.dim, 0, true)
        local ry = my + header_h
        for _, ql in ipairs(state.qualities) do
            local id = "qrow:" .. ql
            local active_q = ql == state.quality
            local hovered = state.hover_id == id
            if hovered then
                rect(a, mx + 4 * s, ry, mx + menu_w - 4 * s, ry + row_h, theme.text, 224)
            end
            text_ev(a, mx + 14 * s, ry + row_h / 2, 4, ql, 14 * s,
                active_q and theme.accent or theme.text, 0)
            if active_q then
                icon_check(a, mx + menu_w - 24 * s, ry + row_h / 2 - 5 * s, s,
                    theme.accent, 0)
            end
            add_hit(mx + 2 * s, ry, mx + menu_w - 2 * s, ry + row_h, id)
            ry = ry + row_h
        end
    end

    -- top-left stream info block (hls.js theater-info look: circular avatar,
    -- bold title, "game · N viewers"): the whole block arrives as ONE
    -- webview-rendered BITMAP (ks-infoblock) — the webview's font stack
    -- renders the COLOR emoji in titles that libass structurally cannot
    -- (its providers reject bitmap-only emoji fonts), and the app
    -- rasterizes the block at this layout's exact metrics. Without the
    -- bitmap nothing draws here.
    do
        local ix = 14 * s
        local iy = 12 * s
        if state.infoblock then
            send_overlay("infoblock", "show", ix, iy,
                state.infoblock.w, state.infoblock.h)
        else
            send_overlay("infoblock", "hide")
        end
    end

    -- TILE-MODE TOP CHROME (hls.js optics): channel label top-left (white
    -- text, dark outline for legibility over any video — ASS has no text
    -- measuring, so no pill background). Shows and hides with the bar like
    -- the hls.js overlay. (Tile reorder lives in the BAR: ◀/▶ buttons.)
    if state.tile and state.label ~= "" then
        a:new_event()
        a:pos(8 * s, 6 * s)
        a:an(7)
        a:append(string.format(
            "{\\fs%d\\fnsans-serif\\b1\\bord1.5\\shad1\\blur0.4\\1c&HFFFFFF&\\3c&H0&\\fscx100\\fscy100}",
            math.floor(23 * s + 0.5)))
        a:append(esc(state.label))
    end

    osd.res_x = w
    osd.res_y = h
    osd.data = a.text
    osd:update()
end

-- ---------------------------------------------------------------------------
-- visibility + tick

local tick_timer = nil

local function hide()
    state.visible = false
    state.hover_id = nil
    state.scrub = nil
    state.hover_seek = nil
    state.popup = false
    if tick_timer then tick_timer:kill() end
    send_overlay("thumb", "hide")
    send_overlay("infoblock", "hide")
    osd.data = ""
    osd:remove()
end

local function show()
    if state.disabled then return end
    state.visible = true
    state.last_activity = mp.get_time()
    if tick_timer and not tick_timer:is_enabled() then
        tick_timer.timeout = 0.06
        tick_timer:resume()
    end
    render()
end

local function activity()
    if state.disabled then return end
    state.last_activity = mp.get_time()
    if not state.visible then
        show()
    else
        render()
    end
end

local function seek_exact(frac)
    if (state.duration or 0) > 1 then
        mp.commandv("seek", string.format("%.3f", frac * state.duration),
            "absolute", "exact")
    end
end

local function tick()
    if not state.visible then return end
    -- Click-stream scrub end: when the clicks stop, commit the scrubbed
    -- position (unless it already IS the position).
    if state.scrub ~= nil and (mp.get_time() - state.last_click.t) > 0.35 then
        local target = state.scrub * (state.duration or 0)
        if math.abs(target - (mp.get_property_number("time-pos") or 0)) > 0.5 then
            seek_exact(state.scrub)
        end
        state.scrub = nil
    end
    if not state.paused and not state.popup and state.scrub == nil
        and (mp.get_time() - state.last_activity) > 3.0 then
        hide()
        return
    end
    render()
end

tick_timer = mp.add_periodic_timer(0.06, guard(tick))
tick_timer:kill()

-- ---------------------------------------------------------------------------
-- input
--
-- CLICK MODEL: mpv 0.40's `mouse` command only supports "single" clicks
-- (no down/up — see the Rust mpv_pointer comment), so every press arrives
-- as the binding's down callback. The app sends one click per press plus a
-- >=50 ms stream while the pointer is held and MOVING (never a release
-- click — that would double-activate buttons on slow presses); this side
-- synthesizes the expected behaviour per element:
--   - seek strip: first click seeks immediately, subsequent clicks within
--     0.4 s only SCRUB (preview); when the stream ends, the scrub commits.
--   - volume bar: every click applies its fraction (live drag feel).
--   - buttons/popup rows: a click within 0.12 s of the previous click on
--     the SAME element is ignored — only the held-move stream (>=50 ms
--     cadence) ever lands there; a deliberate re-tap is later and works.

local function action(name)
    mp.commandv("script-message", "ks-action", name)
end

local function apply_volume(frac)
    state.volume = clamp(frac, 0, 1) * 100
    mp.set_property_native("volume", state.volume)
end

local function volume_step(dir)
    apply_volume((clamp(state.volume, 0, 100) + dir * 5) / 100)
    activity()
end

local function activate(id)
    if id == "quality" then
        if state.qualities then state.popup = not state.popup end
        return
    elseif id:sub(1, 5) == "qrow:" then
        local label = id:sub(6)
        state.popup = false
        action("quality:" .. label)
        return
    elseif id == "play" then
        mp.set_property_native("pause", not state.paused)
    elseif id == "stop" then
        action("stop")
    elseif id == "mute" then
        mp.set_property_native("mute", not state.mute)
    elseif id == "pip" then
        action("pip")
    elseif id == "mpv" then
        action("mpv")
    elseif id == "theater" then
        action("theater")
    elseif id == "fullscreen" then
        action("fullscreen")
    elseif id == "close" then
        action("close")
    elseif id == "moveleft" then
        action("moveleft")
    elseif id == "moveright" then
        action("moveright")
    end
    -- Any other activation closes the quality popup (it behaves modal-ish).
    state.popup = false
end

local function on_mouse_move()
    local x, y = mp.get_mouse_pos()
    local id = hit_at(x, y)
    -- seek hover preview
    if id == "seek" then
        local s, w = ui_s()
        if w and w > 0 then
            local pad = 10 * s
            state.hover_seek = clamp((x - pad) / (w - 2 * pad), 0, 1)
        end
    else
        state.hover_seek = nil
    end
    if id ~= state.hover_id then
        state.hover_id = id
    end
    activity()
end

local function on_mouse_leave()
    state.hover_id = nil
    state.hover_seek = nil
    state.last_activity = mp.get_time() - 10 -- let the next tick hide the bar
end

local function on_click()
    local x, y = mp.get_mouse_pos()
    activity()
    local id = hit_at(x, y)
    local now = mp.get_time()
    local repeated = state.last_click.id == id and (now - state.last_click.t) < 0.12
    state.last_click.t = now
    state.last_click.id = id
    if state.popup and id == nil then
        state.popup = false
        return
    end
    if id == nil then return end
    if id == "seek" then
        local s, w = ui_s()
        if w == nil or w <= 0 then return end
        local frac = clamp((x - 10 * s) / (w - 2 * 10 * s), 0, 1)
        if repeated then
            state.scrub = frac
        else
            state.scrub = nil
            seek_exact(frac)
        end
        return
    elseif id == "vol" then
        for _, ha in ipairs(hit_areas) do
            if ha.id == "vol" then
                apply_volume(clamp((x - ha.x1) / (ha.x2 - ha.x1), 0, 1))
                break
            end
        end
        return
    end
    if repeated then return end
    activate(id)
end

mp.set_key_bindings({
    { "mouse_move", guard(on_mouse_move) },
    { "mouse_leave", guard(on_mouse_leave) },
}, "ksosc-showhide", "force")
mp.set_key_bindings({
    { "mbtn_left", guard(on_click), function() end },
    { "wheel_up", guard(function() volume_step(1) end) },
    { "wheel_down", guard(function() volume_step(-1) end) },
    { "mbtn_left_dbl", "ignore" },
}, "ksosc-input", "force")
mp.enable_key_bindings("ksosc-showhide")
mp.enable_key_bindings("ksosc-input")

-- ---------------------------------------------------------------------------
-- observed properties

local function on_pause_change(name, value)
    state.paused = value
    activity()
end

local function on_duration_change(name, value)
    state.duration = (value and value > 1) and value or 0
    if state.visible then render() end
end

local function on_volume_change(name, value)
    state.volume = value or 100
    if state.visible then render() end
end

local function on_mute_change(name, value)
    state.mute = value
    if state.visible then render() end
end

local function on_idle_change(name, value)
    state.loaded = not value
    if value then
        hide()
    end
end

mp.observe_property("pause", "bool", on_pause_change)
mp.observe_property("duration", "number", on_duration_change)
mp.observe_property("volume", "number", on_volume_change)
mp.observe_property("mute", "bool", on_mute_change)
mp.observe_property("idle-active", "bool", on_idle_change)
-- Re-render when the OSD surface size changes (window resize).
mp.observe_property("osd-dimensions", "native", function()
    if state.visible then render() end
end)

-- ---------------------------------------------------------------------------
-- script messages (app -> osd)

mp.register_script_message("ks-theme", function(overlay, accent, text, dim, border, live)
    theme.overlay = overlay or theme.overlay
    theme.accent = accent or theme.accent
    theme.text = text or theme.text
    theme.dim = dim or theme.dim
    theme.border = border or theme.border
    theme.live = live or theme.live
    if state.visible then render() end
end)

mp.register_script_message("ks-qualities", function(header, current, ...)
    state.q_header = header or ""
    state.quality = current or ""
    local list = { ... }
    if #list > 0 then
        state.qualities = list
    else
        state.qualities = nil
        state.popup = false
    end
    if state.visible then render() end
end)

mp.register_script_message("ks-chapters", function(n, ...)
    local args = { ... }
    local list = {}
    local cnt = math.min(tonumber(n) or 0, math.floor(#args / 2))
    for i = 1, cnt do
        list[#list + 1] = { s = tonumber(args[i * 2 - 1]) or 0, label = args[i * 2] or "" }
    end
    state.chapters = list
    if state.visible then render() end
end)

mp.register_script_message("ks-muted", function(n, ...)
    local args = { ... }
    local list = {}
    local cnt = math.min(tonumber(n) or 0, math.floor(#args / 2))
    for i = 1, cnt do
        list[#list + 1] = { s = tonumber(args[i * 2 - 1]) or 0, e = tonumber(args[i * 2]) or 0 }
    end
    state.muted = list
    if state.visible then render() end
end)

mp.register_script_message("ks-storyboard", function(interval, count, cols, rows, strips, tileW, tileH)
    local iv = tonumber(interval) or 0
    if iv > 0 then
        state.sb = {
            interval = iv,
            count = tonumber(count) or 0,
            cols = tonumber(cols) or 1,
            rows = tonumber(rows) or 1,
            strips = tonumber(strips) or 0,
            tileW = tonumber(tileW) or 16,
            tileH = tonumber(tileH) or 9,
        }
    else
        state.sb = nil
    end
    if state.visible then render() end
end)

mp.register_script_message("ks-pip", function(v)
    state.pip = v == "1"
    if state.visible then render() end
end)

-- Page-UI overlay: page modules (dialogs, dropdowns, tooltips, toasts)
-- that overlap the video are re-drawn OVER it by Rust as a snapshot bitmap
-- (mpv_page_snapshot → overlay-add, id above thumb/infoblock). The app
-- sends the union box as FRACTIONS of the video rect; convert here into
-- OSD units. Deliberately
-- NOT tied to OSD visibility (no render tick): a dialog must stay overlaid
-- after the OSD auto-hides, so this replies immediately on every message.
mp.register_script_message("ks-page", guard(function(action, xf, yf, wf, hf)
    if action == "hide" then
        send_overlay("page", "hide")
        return
    end
    local w, h = mp.get_osd_size()
    local fx, fy = tonumber(xf) or 0, tonumber(yf) or 0
    local fw, fh = tonumber(wf) or 0, tonumber(hf) or 0
    if not w or not h or w < 2 or h < 2 or fw <= 0 or fh <= 0 then return end
    send_overlay("page", "show", fx * w, fy * h, fw * w, fh * h)
end))

-- Info-block bitmap availability (webview-rendered: color emoji). The app
-- uploads the block under the "infoblock" key and reports its dims; render()
-- then composites it in place of the text path. 0 = unavailable → the
-- libass text fallback (monochrome emoji) draws instead.
mp.register_script_message("ks-infoblock", guard(function(on, w, h)
    if on == "1" then
        state.infoblock = {
            w = math.max(1, math.floor(tonumber(w) or 0)),
            h = math.max(1, math.floor(tonumber(h) or 0)),
        }
    else
        state.infoblock = nil
    end
    if state.visible then render() end
end))

mp.register_script_message("ks-theater", function(v)
    state.theater = v == "1"
    if state.visible then render() end
end)

mp.register_script_message("ks-fullscreen", function(v)
    state.fullscreen = v == "1"
    if state.visible then render() end
end)

-- Multi-view tile engines disable the bar (their controls are the app's
-- HTML strip); entering disabled also clears anything already on screen.
mp.register_script_message("ks-disable", function(v)
    state.disabled = v == "1"
    if state.disabled then hide() end
end)

-- Tile MODE (multi-view engines): the bar stays on, but the app-global
-- buttons (pip / mpv handoff / theater) are hidden — a tile's close X at
-- the far right closes the tile. Also draws the channel label top-left
-- (ks-label).
mp.register_script_message("ks-mode", function(v)
    state.tile = v == "tile"
    state.live = state.tile or v == "live"
    if state.visible then render() end
end)

-- Tile chrome label (the channel name, drawn top-left in tile mode).
mp.register_script_message("ks-label", function(v)
    state.label = v or ""
    if state.visible then render() end
end)

mp.register_script_message("ks-scale", function(v)
    state.scale = tonumber(v) or 1.0
    if state.scale < 0.5 then state.scale = 0.5 end
    if state.scale > 3.0 then state.scale = 3.0 end
    if state.visible then render() end
end)
