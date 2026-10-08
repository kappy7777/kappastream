# Shared packaging assets for kappastream

Files reused verbatim by all three packaging layouts under `packaging/`
(`aur/`, `debian/`, `fedora/` — the AUR packages and the local reproducible
`.deb`/`.rpm` builds). Each layout's `build.sh` / `PKGBUILD` / `.spec` copies
what it needs from here so those packages never drift apart.

The GitHub-release `.deb`/`.rpm`/AppImage are **not** built from these
layouts — release.yml bundles them with tauri-bundler, which generates its
own desktop entry from `src-tauri/tauri.conf.json` (`bundle.category` fills
`Categories=`) and pulls the metainfo in via
`bundle.linux.{deb,rpm}.files`. The curated desktop entry and the `/usr/bin`
wrapper below therefore exist only in the AUR and local-build packages; the
release packages run the bare binary from `/usr/bin` with the generated
entry.

| File | Purpose |
| --- | --- |
| `kappastream.desktop` | Desktop entry (native, `Exec=kappastream` — AUR and local deb/rpm builds only; tauri-bundler generates its own for the release packages and the AppImage). |
| `dev.kappy.kappastream.metainfo.xml` | AppStream metadata for GNOME Software / KDE Discover. Installed directly by the AUR/local layouts; the release `.deb`/`.rpm` ship it via `tauri.conf.json`'s `files` maps. |
| `kappastream.sh` | Thin runtime launcher (the NVIDIA EGL-Wayland explicit-sync compatibility is handled in the Rust binary at startup, not here). Installed at `/usr/bin/kappastream` by the AUR/local layouts; the real binary lives at `/usr/lib/kappastream/kappastream`. |

Edit these here, not in the per-distro directories. Bump the metainfo
`<releases>` block when cutting a release (version must match the three
authoritative version sources: `package.json`, `src-tauri/Cargo.toml`,
`src-tauri/Cargo.lock` — asserted by `scripts/check-versions.sh`).
