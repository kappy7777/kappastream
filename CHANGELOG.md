# Changelog

All notable changes to **kappastream** are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.6] - 2026-07-16

### Fixed

- The hls.js low-latency mode now follows the Low Latency setting instead of
  being hardcoded on. Previously `lowLatencyMode` was always enabled and the
  `liveSyncDurationCount` default was clobbered to `undefined` (hls.js's shallow
  config merge does not skip `undefined`), so with Low Latency off the player
  chased the live edge with a tiny buffer and no partial segments — causing
  constant micro-underruns and, on webkit2gtk, the picture freezing while audio
  kept going. Both the main player and the PiP window now share one config
  builder (`buildHlsConfig`).

## [0.1.5] - 2026-07-16

### Added

- Frontend test suite (Vitest) covering favorite synchronization:
  cooldown deferral, stale-response guards, rate limiting,
  status-before-enrichment, and live-channel enrichment priority.
- CI now runs frontend tests (`npm test`) and enforces `cargo fmt`.

### Fixed

- Favorites no longer get stuck in the loading/"unknown" state for
  ~10 minutes after startup. Channels skipped during a DecAPI rate-limit
  cooldown are retried after the cooldown instead of being dropped, and
  the aggressive startup poll now includes every non-live favorite.
- Live/offline status is published as soon as the uptime check resolves,
  before avatars and live metadata are fetched, so the loading indicator
  clears after a single request per channel.
- The DecAPI request limiter was slowed to 650 ms (~92 req/min) to stay
  safely under DecAPI's ~100 req/60s limit, eliminating the 429 bursts
  that triggered the cooldown.
- Global-cooldown deferrals no longer count as per-channel failures or
  mark channels stale; only real network failures consume the retry
  budget.
- After a classification batch, enrichment is prioritized — live
  metadata, then live avatars, then offline avatars — so offline avatars
  can't delay titles/games/viewer counts for live channels.
- Persisted avatar and metadata hydrate the in-memory caches on restart.

## [0.1.4] - 2026-07-15

### Added

- mpv handoff: open the current stream in a standalone `mpv` player via
  `streamlink --player=mpv` (new `launch_player` command in `player.rs`).
- Low-latency playback mode (~1-segment buffer) with a toggle in Settings.
- System tray icon with Show / Hide / Quit menu and close-to-tray
  (enabled by default; `tray.rs`).
- `SECURITY.md`.

### Changed

- All frontend ↔ Rust IPC now goes through the typed `@tauri-apps/api`
  package; the untyped `window.__TAURI__` global is disabled
  (`withGlobalTauri: false`).
- Release workflow upgraded to `tauri-apps/tauri-action@v1`.

### Fixed

- Tooltip positioning under UI-scale `zoom` now measures the real zoom
  factor instead of assuming a formula (fixes misaligned tooltips in the
  AppImage's webkit2gtk engine).
- Low-latency stall recovery: webkit2gtk pauses (rather than just
  buffering) on an underrun; playback now auto-seeks to the live edge and
  resumes while respecting a deliberate user pause.

## [0.1.3] - 2026-07-14

### Changed

- Dependency bumps: svelte 5.56.4 → 5.56.5, vite 8.1.3 → 8.1.4,
  `@types/node` 24 → 26, `tauri-plugin-log` 2.8 → 2.9.
- CI/release workflows now use `actions/checkout@v7` and `actions/setup-node@v7`.

### Fixed

- `dependabot.yml` now ignores `typescript` major updates (7.x breaks the
  `svelte-check` type-check gate).

## [0.1.2] - 2026-07-14

### Fixed

- Release workflow once again publishes the `kappastream-<ver>-x86_64.tar.gz`
  consumed by the `kappastream-bin` AUR package (it was dropped in v0.1.1);
  its checksum is now included in `SHA256SUMS`.
- The `.deb` and `.rpm` bundles now declare `streamlink` as a dependency
  (`bundle.linux.deb.depends` / `rpm.depends` in `tauri.conf.json`).
- The About modal now shows the real release version instead of a hardcoded
  `v0.1.0` (injected at build time via Vite `define`).

## [0.1.1] - 2026-07-14

### Added

- GitHub Actions CI: type-check (`npm run check`), `cargo clippy -D warnings`,
  and `cargo test` on every push to `main` and pull request.
- GitHub Actions release workflow: building the AppImage / `.deb` / `.rpm`
  bundles on `v*` tags, publishing a GitHub Release with a `SHA256SUMS`
  checksum file.
- GitHub issue templates (bug report, feature request) and Dependabot
  configuration (npm, cargo, github-actions).

### Changed

- The frontend is now built before Rust checks in CI (`tauri::generate_context!`
  embeds `frontendDist` at compile time).
- Resolved clippy lints in `decapi.rs` and `resolve.rs` (use `.contains()`,
  inline nested `format!`).

## [0.1.0] - 2026-07-14

### Added

- Lightweight, anonymous (no-login) Twitch viewer shipped as a Linux
  AppImage / `.deb` / `.rpm` and as a browser SPA.
- Live stream playback via streamlink + hls.js.
- Read-only IRC chat over the public Twitch WebSocket, with emotes
  (Twitch, 7TV, BTTV, FFZ) and badges.
- Favorites with DecAPI live-status polling, retry backoff, circuit
  breaker, and per-channel desktop notifications.
- 29 themes, configurable UI scale, theater mode, fullscreen, and
  per-channel quality preference. All state persisted to `localStorage`.

[Unreleased]: https://github.com/kappy7777/kappastream/compare/v0.1.6...HEAD
[0.1.6]: https://github.com/kappy7777/kappastream/releases/tag/v0.1.6
[0.1.5]: https://github.com/kappy7777/kappastream/releases/tag/v0.1.5
[0.1.4]: https://github.com/kappy7777/kappastream/releases/tag/v0.1.4
[0.1.3]: https://github.com/kappy7777/kappastream/releases/tag/v0.1.3
[0.1.2]: https://github.com/kappy7777/kappastream/releases/tag/v0.1.2
[0.1.1]: https://github.com/kappy7777/kappastream/releases/tag/v0.1.1
[0.1.0]: https://github.com/kappy7777/kappastream/releases/tag/v0.1.0
