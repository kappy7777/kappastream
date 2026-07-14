# Changelog

All notable changes to **kappastream** are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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

[Unreleased]: https://github.com/kappy7777/kappastream/compare/v0.1.3...HEAD
[0.1.3]: https://github.com/kappy7777/kappastream/releases/tag/v0.1.3
[0.1.2]: https://github.com/kappy7777/kappastream/releases/tag/v0.1.2
[0.1.1]: https://github.com/kappy7777/kappastream/releases/tag/v0.1.1
[0.1.0]: https://github.com/kappy7777/kappastream/releases/tag/v0.1.0
