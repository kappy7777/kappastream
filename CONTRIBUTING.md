# Contributing to kappastream

Thanks for considering a contribution. kappastream is a small, opinionated
project, so this is short.

## Bug reports

Open an [issue](../../issues) and include:

- your distro and compositor (X11 or Wayland, and which — Hyprland, KDE, GNOME, …)
- the app version (see the About modal, or the release page)
- what you expected, and what happened
- whether `streamlink` is installed (`streamlink --version`)

Screenshots or a screen recording help a lot.

## Pull requests

PRs are welcome for bug fixes and features that fit the project's scope (a
no-account, no-tracking native Twitch viewer). Before opening one:

1. **Run the verification gates.** The full gate set (CI enforces all of
   these, in this order) is:

   ```bash
   npm audit                           # JS supply-chain scan over package-lock.json
   sh scripts/check-versions.sh        # version-drift guard (see Releasing)
   npm run check                       # svelte-check (src/**) + tsc (vite.config.ts)
   npm run lint                        # ESLint (flat config), .ts + .svelte
   npm run format:check                # Prettier (fix with `npm run format`)
   npm test                            # Vitest (src/**/*.test.ts)
   npm run build                       # must precede every cargo command below
   cargo fmt --all -- --check          # cargo commands run inside src-tauri/
   cargo clippy --all-targets -- -D warnings
   cargo clippy --no-default-features --features "mpv-embed,tauri/custom-protocol" \
       --all-targets -- -D warnings    # the AUR build state (updater off, engine on)
   cargo test
   cargo audit                         # RustSec scan (ignores in src-tauri/.cargo/audit.toml)
   ```

   `npm run build` before the cargo gates is not optional: the Rust build
   embeds `dist/` via `tauri::generate_context!` and panics if it's
   missing. Formatting is owned by Prettier — don't hand-argue style in
   reviews, and don't add other tooling without asking first.

2. **Keep the no-auth posture.** Don't add Twitch login, OAuth, calls to
   the Helix/Kraken APIs, or a registered app `client_id`. The anonymous
   GQL transport (`gql_fetch` in `src-tauri/src/gql.rs`) already pins
   Twitch's public web Client-ID in the native binary — keep it that
   way. The whole point is that the app is anonymous read-only and holds
   no Twitch credentials. If your change seems to need auth, open an
   issue to discuss it first.

3. **Build from source** to confirm it compiles end-to-end — see the
   [README](./README.md#build-from-source). Linux builds additionally need
   `libmpv-dev` (`pacman -S mpv` on Arch): the embedded video engine is a
   default Cargo feature on Linux. Windows and macOS builds need nothing
   mpv-related — the engine is Linux-only and its dependency set is
   target-gated away there.

4. **Leave release prose to the maintainer.** Don't edit `CHANGELOG.md` or
   `src/lib/release-notes.ts` in a PR — both are curated alongside each
   release, and the what's-new highlights mirror the CHANGELOG by design.

## Scope notes

- **Linux, macOS, and Windows.** Linux targets X11 + Wayland; macOS and Windows are also first-class targets. macOS builds target Apple Silicon (arm64) only.
- **Persistence is `localStorage` only** — there is no backend and there
  shouldn't be one.
- **`main` is the public release branch.** Keep commit history readable;
  this is the line that ships to GitHub Releases and the AUR.

## Releasing

Releases ship to GitHub Releases (AppImage / `.deb` / `.rpm` / tarball / Windows installer / macOS `.dmg`) and the
AUR (`kappastream-git`, `kappastream-bin`). The release workflow (`release.yml`)
is triggered by pushing a `v*` tag.

Checklist for cutting a release:

1. Bump the version in **all four** version-carrying files in lockstep —
   `package.json`, `package-lock.json` (the two root `version` fields;
   sync them with `npm install --package-lock-only`), `src-tauri/Cargo.toml`,
   and `src-tauri/Cargo.lock` (`tauri.conf.json` has no `version` key; it
   falls back to `Cargo.toml`). Regenerate `Cargo.lock` by running
   `cargo check` inside `src-tauri/`.
2. Add a `## [<version>]` entry to `CHANGELOG.md` and update the
   `[Unreleased]` / `[<version>]` compare links at the bottom.
3. Add the version's entry to `src/lib/release-notes.ts` (the what's-new
   highlights; sections mirror the CHANGELOG's Added/Changed/Fixed) and
   fill `.github/update-notes.md` with the update-banner note (plain
   text, one line — the file is empty between releases, and its content
   at the tagged commit ships in the release's `latest.json`). Clear it
   back to empty once the release has published.
4. Add a `<release version="<version>" date="<YYYY-MM-DD>">` entry to
   `packaging/shared/dev.kappy.kappastream.metainfo.xml` at the top of the
   `<releases>` block (newest first), with a `<url>` pointing at the GitHub
   release. The date must match the CHANGELOG heading.
5. Run the version-drift guard to confirm nothing has drifted:
   ```bash
   sh scripts/check-versions.sh
   ```
6. Run the full local gate set from **Pull requests** above. CI runs
   these too, but catch failures before tagging.
7. Commit on `main` (e.g. `Release v<version>`), then tag and push the tag:
   ```bash
   git tag v<version>
   git push origin v<version>
   ```
   Pushing the tag runs `release.yml`, which builds and publishes the bundles +
   `SHA256SUMS` (the release stays **draft** until the checksums land).
8. After the release publishes, update the AUR packages (see
   `packaging/aur/README.md`): refresh `-git`'s `pkgver` and `-bin`'s tarball
   sha256 (taken from the release's `SHA256SUMS`) + `pkgver`.

## License

By contributing, you agree your changes are licensed under
[GPL-3.0-only](./LICENSE), the same as the rest of the project.
