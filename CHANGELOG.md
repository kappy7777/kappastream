# Changelog

All notable changes to **kappastream** are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.2.2] - 2026-07-21

### Changed

- **The Twitch GQL transport now sends a generic browser User-Agent** instead
  of an app-identifying `Kappastream/<version>` one. `gql.twitch.tv` is
  Twitch's unofficial internal endpoint, and an app-specific User-Agent was a
  single-rule block target — one server-side filter on that string would have
  disabled every kappastream install at once. (The DecAPI transport
  intentionally continues to identify itself honestly, since DecAPI is a
  small donation-funded service the project depends on as a guest.) A unit
  test guards the constant against a silent revert.

## [0.2.1] - 2026-07-21

### Changed

- **Favorites now resolve via Twitch GQL as the primary data source.** A
  single batched anonymous `users(logins:)` request per refresh covers the
  whole list (live/offline, title, game, viewers, avatar, thumbnail) — what
  previously took 4–5 DecAPI calls per channel is now one round trip for
  everyone. DecAPI remains as a per-channel fallback, used only when the GQL
  request fails at the transport layer (network error / non-2xx / timeout);
  a channel GQL reports as offline is a success and never triggers the
  fallback. Refresh interval is 150 s.
- **Favorites limit raised from 100 to 1000.** Larger lists are fetched as
  sequential chunks of 100 logins (still well inside the refresh window).
- **Removed the 1-hour localStorage status cache** (`fav-status-cache-v1` /
  `fav-status-cache-ts-v1`). Every channel now starts fresh on launch and is
  repopulated by the first GQL poll (~1 s), so stale up-to-1-hour-old
  live/title/viewers state is no longer shown. Old keys left in localStorage
  are ignored.
- Emote user-ID lookups (for 7TV/BTTV/FFZ channel emotes) now go through the
  same batched GQL path instead of per-user DecAPI `/twitch/id` calls.

## [0.2.0] - 2026-07-20

### Added

- **Stop / Disconnect button** in the video controls (between play/pause and
  mute). It fully tears down the active stream — video playback, HLS segment
  fetching, and the IRC chat connection — and returns the UI to its idle
  "no stream loaded" state.
- **Pause button in the PiP window**, and the PiP volume slider no longer
  stretches across the whole window.

### Changed

- **mpv handoff now frees the in-app player.** Launching a stream in mpv stops
  playback inside kappastream (HLS + video) so it is no longer fetching segments
  or using resources in parallel with mpv. The IRC chat connection is left
  running.
- **Close-to-tray disconnects the stream.** When the window is hidden to the
  tray, both video and chat are torn down so nothing keeps downloading or
  playing audio in the background.
- **PiP now takes over the stream.** Because the PiP window is a separate
  webview with its own `<video>`/hls.js instance, opening PiP disconnects the
  main-window player (freeing its resources) while the floating window is the
  active player; closing PiP resumes the main stream automatically.
- GitHub release notes now use a short, consistent body (a link to CHANGELOG.md
  and a pointer to SHA256SUMS) instead of the per-artifact breakdown.

### Fixed

- **Chat no longer jumps while reading history.** The 500-message buffer trim
  previously fired unconditionally; trimming from the front while you were
  scrolled up shifted the visible messages. The trim now only runs while
  following live at the bottom, so the history stays frozen until you press
  "Back to bottom".

## [0.1.10] - 2026-07-19

### Fixed

- **Third-party emote rendering** — a cluster of bugs that together left many
  emotes rendering as plain text:
  - **7TV channel-set aliases.** A 7TV v3 emote-set entry's top-level `name`
    is the alias active in that set (the string chatters actually type), while
    `data.name` is the emote's original name. The map was keyed on
    `data.name`, so a channel that renamed `catErm` to `erm` returned
    `{ name: "erm", data: { name: "catErm" } }` and no chatter's "erm" ever
    matched. Now keyed on the set-entry name.
  - **7TV `PERSONAL` filter.** `data.state` describes the emote globally, and
    `PERSONAL` there means "approved for personal-emote use" — an eligibility
    flag, not "this entry is a personal emote". Real channel-set responses
    carry `state: ["PERSONAL", "LISTED"]` on ordinary public listed emotes,
    so the old `isPublicSevenTv` filter silently deleted part of the map.
    Removed.
  - **FFZ global emotes were never fetched.** `loadGlobalEmotes` only called
    `fetch7TVGlobal` + `fetchBTTVGlobal`, so every FFZ global emote rendered
    as text. Added `fetchFFZGlobal` hitting `/v1/set/global`, iterating only
    the sets listed in `default_sets` (not every key of `sets`).
  - **Trailing punctuation absorbed into emote spans.** `thirdPartyRanges`
    looked up the punctuation-stripped token but emitted a range covering the
    full word, so "omE!" matched the emote and then rendered the "!" inside
    the emote `<img>`. The range now covers only the stripped token; the
    punctuation stays as a separate text part.
  - **Broken emote images were indistinguishable from lookup misses.** Emote
    `<img>` elements had no `onerror` handler, so a broken URL silently fell
    back to the alt text. Added an `erroredEmotes` set + `markEmoteErrored`
    mirroring the badge pattern; on error the emote's name renders as a plain
    text span.
  - **Emote-only styling was inert.** The `class:emote-only` expression could
    only ever be true for a whitespace-only message and no `.emote-only` CSS
    rule existed. The flag is now derived once from the rendered parts
    (`parts.some(emote) && parts.every(emote || whitespace-only)`) and stored
    on the `ChatMessage`; the new `.message.emote-only .emote` rule doubles
    the emote height (with an explicit `.emote--twitch` companion so it wins
    over the twitch-specific height rule).
  - **Failed channel-emote lookups were cached forever.** When
    `getTwitchUserId` returned `null` (typically a transient DecAPI
    429/timeout), the empty result was written to the channel cache, so one
    failure cost that channel its third-party emotes for the rest of the
    process while `loadEmotes` still reported `emoteStatus = 'ready'`. The
    empty result is no longer cached; a later rejoin retries.

### Added

- Vitest suite for `src/lib/emotes.ts` (`src/lib/emotes.test.ts`) covering
  the 7TV alias keying, the `PERSONAL`/`LISTED` filter removal, FFZ global
  `default_sets` parsing, trailing-punctuation rendering, and the
  `emoteOnly` predicate.

## [0.1.9] - 2026-07-19

### Changed

- Chat timestamps now render **before** the badges (timestamp → badges →
  username) instead of after them, matching the layout users expect from web
  Twitch chat.
- The DecAPI HTTP client's `User-Agent` is now derived from the crate version
  (`Kappastream/<version>`) instead of a hardcoded `Kappastream/0.1` that had
  to be bumped manually each release.

### Fixed

- IRCv3 tag-value escape decoding no longer mis-decodes `\\` followed by `s`.
  The previous sequential `.replace()` chain ran `\\` → `\` before `\s` could
  match against the original input, so a raw `a\\sb` decoded to `a\ b` instead
  of `a\sb`. The decoder is now a single `\\(.)` regex pass with a map for the
  five defined escapes (`\s`, `\n`, `\r`, `\:`, `\\`) and a fallback that
  drops the backslash for unknown escapes (per the IRCv3 spec). Covered by a
  new Vitest suite (`src/lib/irc.test.ts`).
- The AppStream metainfo's `<releases>` block now lists every released
  version (0.1.0 through 0.1.9), each with a `<url>` pointing at its GitHub
  release. Previously it listed only 0.1.0, which blocked Flathub submission.
  Two pre-existing `appstreamcli validate` findings were fixed in passing:
  `<control type="…">` (needs AppStream 1.0+) was switched to the universally
  accepted value form, and screenshot URLs pointing at the stale `Screenshots/`
  path were corrected to `docs/screenshots/` (where the tracked images live).

### Added

- **Metainfo drift guard.** `scripts/check-versions.sh` now asserts that the
  latest `<release version="…">` in the AppStream metainfo matches the current
  `package.json` version, so the metainfo and CHANGELOG can't silently drift
  apart on a future release. The `Releasing` checklist in `CONTRIBUTING.md`
  was updated to include the metainfo bump.
- **RustSec audit in CI.** `ci.yml` runs `cargo audit` after the Rust tests,
  blocking on any non-ignored advisory. `src-tauri/.cargo/audit.toml` ignores
  two `quick-xml` DoS advisories (reached only via plist and wayland-scanner;
  kappastream parses no untrusted XML at runtime). `--deny warnings` /
  `--deny unmaintained` are deliberately not passed — the gtk3-rs 0.18 stack
  Tauri v2 pins on Linux is flagged unmaintained upstream and would keep CI
  permanently red.
- **Supply-chain pin.** `dtolnay/rust-toolchain@stable` (the only moving
  branch ref in either workflow) is pinned to a commit SHA in `ci.yml` and
  both `release.yml` jobs. Dependabot keeps SHA pins updated.

### Removed

- Dead `ParsedMessage.emoteOnly` field and its computation in `parseIrcLine`.
  The predicate was always true for any string without consecutive whitespace,
  and the actual emote-only styling is derived inline in `App.svelte`.

## [0.1.8] - 2026-07-17

### Changed

- AppImage releases are now built on **Ubuntu 24.04**, bundling the newer
  WebKitGTK 2.44 and GStreamer stack. On the target NVIDIA/Wayland system this
  is dramatically smoother than the previous Ubuntu 22.04 AppImage (which was
  effectively unusable). The build pipeline measures and reports the AppImage's
  highest `GLIBC_*` requirement, which is recorded in the release notes.
- **DEB, RPM and the AUR `kappastream-bin` tarball remain built on Ubuntu
  22.04** to preserve their existing (wider) glibc compatibility baseline; only
  the AppImage uses the newer stack. The release workflow was split into
  separate `build-native-packages` (ubuntu-22.04) and `build-appimage`
  (ubuntu-24.04) jobs feeding a single `publish-release` job, so the release
  is still published as one draft with one `SHA256SUMS` and only goes public
  once every artifact and its checksums are attached.

### Fixed

- NVIDIA users on **X11** no longer get a blank/invisible window. Kappastream
  now sets `WEBKIT_DISABLE_DMABUF_RENDERER=1` only on X11 sessions with the
  NVIDIA kernel driver loaded, applied inside the binary at the very start of
  `main()` (before WebKitGTK picks its renderer). This prevents WebKitGTK from
  attempting the NVIDIA GBM/DMA-BUF renderer path that fails with `Failed to
  create GBM buffer of size 800x600: Invalid argument` and leaves the webview
  blank — without disabling compositing globally. The NVIDIA **Wayland**
  `__NV_DISABLE_EXPLICIT_SYNC=1` fix from 0.1.7 is unchanged; the two paths are
  mutually exclusive (Wayland selects explicit-sync, X11 selects DMA-BUF
  renderer). AMD, Intel and unknown sessions are unaffected. A user-supplied
  `WEBKIT_DISABLE_DMABUF_RENDERER` value (including `0`) is always preserved.

## [0.1.7] - 2026-07-17

### Fixed

- NVIDIA Wayland users no longer need WebKitGTK compositing disabled globally.
  Kappastream now disables NVIDIA EGL-Wayland explicit sync (`__NV_DISABLE_EXPLICIT_SYNC=1`)
  only for Wayland launches on systems with the NVIDIA kernel driver loaded,
  applied inside the binary at the very start of `main()` (before GTK/WebKitGTK/EGL
  initialize). This avoids the `Error 71 (Protocol error) dispatching to Wayland
  display` crash while keeping WebKitGTK's accelerated compositing path enabled
  — a substantial improvement to maximized-window UI and video performance that
  the previous broad `WEBKIT_DISABLE_COMPOSITING_MODE=1` workaround had cost.
  AMD, Intel and X11 sessions are unaffected. A user-supplied
  `__NV_DISABLE_EXPLICIT_SYNC` value (including `0`) is always preserved, and
  the old fallback can still be forced with `WEBKIT_DISABLE_COMPOSITING_MODE=1
  kappastream`.

### Added

- `scripts/check-versions.sh`: a version-drift guard asserting the version
  matches across `package.json`, `src-tauri/Cargo.toml` and `src-tauri/Cargo.lock`,
  with no stale hardcoded version in the packaging docs. It runs in CI before
  the type-check and is part of the release checklist in `CONTRIBUTING.md`.

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

[Unreleased]: https://github.com/kappy7777/kappastream/compare/v0.2.2...HEAD
[0.2.2]: https://github.com/kappy7777/kappastream/releases/tag/v0.2.2
[0.2.1]: https://github.com/kappy7777/kappastream/releases/tag/v0.2.1
[0.2.0]: https://github.com/kappy7777/kappastream/releases/tag/v0.2.0
[0.1.10]: https://github.com/kappy7777/kappastream/releases/tag/v0.1.10
[0.1.9]: https://github.com/kappy7777/kappastream/releases/tag/v0.1.9
[0.1.8]: https://github.com/kappy7777/kappastream/releases/tag/v0.1.8
[0.1.7]: https://github.com/kappy7777/kappastream/releases/tag/v0.1.7
[0.1.6]: https://github.com/kappy7777/kappastream/releases/tag/v0.1.6
[0.1.5]: https://github.com/kappy7777/kappastream/releases/tag/v0.1.5
[0.1.4]: https://github.com/kappy7777/kappastream/releases/tag/v0.1.4
[0.1.3]: https://github.com/kappy7777/kappastream/releases/tag/v0.1.3
[0.1.2]: https://github.com/kappy7777/kappastream/releases/tag/v0.1.2
[0.1.1]: https://github.com/kappy7777/kappastream/releases/tag/v0.1.1
[0.1.0]: https://github.com/kappy7777/kappastream/releases/tag/v0.1.0
