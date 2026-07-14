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

1. **Run the verification gates.** There is no `npm test` / lint / format
   script — don't add one without asking first. The gates are:

   ```bash
   npm run check      # svelte-check (src/**) + tsc (vite.config.ts)
   cargo check        # run inside src-tauri/
   ```

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

## License

By contributing, you agree your changes are licensed under
[GPL-3.0-only](./LICENSE), the same as the rest of the project.
