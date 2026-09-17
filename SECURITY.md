# Security Policy

## Reporting a vulnerability

Please **do not** open a public GitHub issue for security-sensitive bugs.

Instead, report them privately via GitHub's _"Report a vulnerability"_
flow on the [Security tab](./security/advisories/new), or email
**kappy777@proton.me**. Include:

- the app version (About modal, or the release page)
- your operating system and version (on Linux: distro / compositor, X11 or Wayland; on macOS: the macOS version)
- a description of the issue and, if possible, minimal reproduction steps

You should hear back within a few days. If confirmed, a fix and a
GitHub Security Advisory / new release will follow.

## Scope

kappastream is an **anonymous, read-only** Twitch viewer — there is no
Twitch login, no OAuth, and no credentials are ever stored or sent. All
persistence is local (`localStorage` only).

The desktop build (Tauri) exposes a small, fixed set of local IPC
commands plus one custom URI scheme to its WebView. The complete surface
(see `src-tauri/src/lib.rs`):

- **Stream resolution** (`resolve_stream`, `resolve_vod`, `resolve_clip`)
  and **mpv handoff** (`launch_player`) — shell out to the local
  `streamlink` binary (and `mpv`). Channel names, VOD IDs, and clip slugs
  are validated against strict patterns before any subprocess runs;
  stream qualities are validated structurally (lowercase alphanumeric
  tokens, length-bounded — Twitch's transcode ladder is dynamic, so a
  fixed allowlist would reject real variants), and the token reaches
  streamlink as a direct argv element, never through a shell. Every URL
  streamlink returns is itself re-validated (https-only, no userinfo,
  default port, allowlisted Twitch media host families) before the
  frontend ever sees it.
- **Embedded mpv engine** (`mpv_*`, when the `mpv-embed` Cargo feature is
  compiled in — the default for release builds) — libmpv renders video
  into a native surface. The URL handed to `mpv_load` is validated the
  same way resolver output is (https, no userinfo, default port, and the
  host family matching the media kind — live vs VOD/clip), so mpv can
  never be pointed at `file://`, `edl://`, `smb://` or any off-site host
  by the page. Engine ids are bounded to 0..=4 (single view + multi-view
  tiles); no command can mint extra mpv cores. The engine's OSD script
  lives in a private per-user runtime dir (0700, files 0600 — never the
  shared `/tmp`), and OSD bitmaps are passed to mpv by memory, not files.
  The engine is currently enabled on Linux only (`mpv_available` returns
  false elsewhere pending on-hardware verification).
- **Twitch GQL proxy** (`gql_fetch`) — a POST proxy to `gql.twitch.tv`
  that bypasses browser CORS, with Twitch's public web Client-ID pinned
  in the native binary so the page cannot change or omit it.
- **`ksvod` media proxy** — a custom URI scheme that fetches HLS VOD
  media from Twitch's CloudFront CDN through Rust (CloudFront sends no
  CORS headers, so the WebView's fetch is otherwise blocked) and returns
  it with `Access-Control-Allow-Origin: *`. Only allowlisted Twitch media
  hosts are fetched, redirects are disabled (so an allowlisted host can't
  bounce a fetch elsewhere), and response sizes are capped.
- **URL opening** (`open_url_robust`) — opens `twitch.tv` HTTPS URLs
  through the system browser/opener; URLs are validated before launch.
- **Favorites export** (`save_favorites_export`) — a native save dialog
  for backing up favorites to a JSON file the user chooses.
- **Platform query** (`target_os`) — returns the compile-time target OS
  string (read-only, no side effects).
- **Window / Picture-in-Picture controls and OS notifications** — core
  window APIs (Picture-in-Picture is a second always-on-top webview) and
  the notification plugin. The in-app updater (when the `updater` Cargo
  feature is compiled in — it is not in the AUR builds) verifies a
  minisign signature before installing anything.

No command accepts arbitrary URLs, hosts, file paths, or shell arguments
from the page unvalidated.

## Supported versions

Only the latest release is supported. See the
[releases page](./releases/latest).
