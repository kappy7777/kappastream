# Contributing to kappastream

Thanks for considering a contribution. kappastream is a small, opinionated
project, so this is short.

## Bug reports

Open an [issue](./issues) and include:

- your distro and compositor (X11 or Wayland, and which — Hyprland, KDE, GNOME, …)
- the app version (see the About modal, or the release page)
- what you expected, and what happened
- whether `streamlink` is installed (`streamlink --version`)

Screenshots or a screen recording help a lot.

## Pull requests

PRs are welcome for bug fixes and features that fit the project's scope (a
no-account, no-tracking native Twitch viewer). Before opening one:

1. **Run the verification gates.** The full gate set (CI enforces all of
   these) is:

   ```bash
   npm run check                       # svelte-check (src/**) + tsc (vite.config.ts)
   npm test                            # Vitest (src/**/*.test.ts)
   sh scripts/check-versions.sh        # version-drift guard (see Releasing)
   cargo fmt --all -- --check          # run inside src-tauri/
   cargo clippy --all-targets -- -D warnings
   cargo test
   ```

   No ESLint/Prettier — don't add one without asking first.

   CI additionally runs `cargo clippy --all-targets -- -D warnings` and
   `cargo test`, so `npm run build` must succeed (the Rust build embeds
   `dist/` and will panic if it's missing).

2. **Keep the no-auth posture.** Don't add Twitch login, OAuth, a
   `client_id`, or calls to the Helix/Kraken APIs. The whole point is that
   the app is anonymous read-only and holds no Twitch credentials. If your
   change seems to need auth, open an issue to discuss it first.

3. **Build from source** to confirm it compiles end-to-end — see the
   [README](./README.md#build-from-source).

## Scope notes

- **Linux only** (X11 + Wayland). Don't add macOS or Windows paths.
- **Persistence is `localStorage` only** — there is no backend and there
  shouldn't be one.
- **`main` is the public release branch.** Keep commit history readable;
  this is the line that ships to GitHub Releases and the AUR.

## Releasing

Releases ship to GitHub Releases (AppImage / `.deb` / `.rpm` / tarball) and the
AUR (`kappastream-git`, `kappastream-bin`). The release workflow (`release.yml`)
is triggered by pushing a `v*` tag.

Checklist for cutting a release:

1. Bump the version in **all three** authoritative sources in lockstep —
   `package.json`, `src-tauri/Cargo.toml`, and `src-tauri/Cargo.lock`
   (`tauri.conf.json` has no `version` key; it falls back to `Cargo.toml`).
   Regenerate the lock by running `cargo check` inside `src-tauri/`.
2. Add a `## [<version>]` entry to `CHANGELOG.md` and update the
   `[Unreleased]` / `[<version>]` compare links at the bottom.
3. Run the version-drift guard to confirm nothing has drifted:
   ```bash
   sh scripts/check-versions.sh
   ```
4. Run the full local gate set (`npm run check`, `npm test`, `cargo fmt
   --all -- --check`, `cargo clippy --all-targets -- -D warnings`, `cargo
   test`). CI runs these too, but catch failures before tagging.
5. Commit on `main` (e.g. `Release v<version>`), then tag and push the tag:
   ```bash
   git tag v<version>
   git push origin v<version>
   ```
   Pushing the tag runs `release.yml`, which builds and publishes the bundles +
   `SHA256SUMS` (the release stays **draft** until the checksums land).
6. After the release publishes, update the AUR packages (see
   `packaging/aur/README.md`): refresh `-git`'s `pkgver` and `-bin`'s tarball
   sha256 (taken from the release's `SHA256SUMS`) + `pkgver`.

## License

By contributing, you agree your changes are licensed under
[GPL-3.0-only](./LICENSE), the same as the rest of the project.
