# Changelog

All notable changes to **kappastream** are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- GitHub Actions CI: type-check (`npm run check`), `cargo clippy -D warnings`,
  and `cargo test` on every push to `main` and pull request.
- GitHub Actions release workflow: building the AppImage / `.deb` / `.rpm`
  bundles on `v*` tags, publishing a GitHub Release with a `SHA256SUMS`
  checksum file.
- GitHub issue templates (bug report, feature request) and Dependabot
  configuration (npm, cargo, github-actions).

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

[Unreleased]: https://github.com/kappy7777/kappastream/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/kappy7777/kappastream/releases/tag/v0.1.0
