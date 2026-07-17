# Shared packaging assets for kappastream

Files reused verbatim by all three native packaging layouts
(`packaging/aur/`, `packaging/debian/`, `packaging/fedora/`). Each distro's
`build.sh` / `PKGBUILD` / `.spec` copies what it needs from here so the three
packages never drift apart.

| File | Purpose |
| --- | --- |
| `kappastream.desktop` | Desktop entry (native, `Exec=kappastream` — not the AppImage one). |
| `dev.kappy.kappastream.metainfo.xml` | AppStream metadata for GNOME Software / KDE Discover. |
| `kappastream.sh` | Thin runtime launcher (the NVIDIA EGL-Wayland explicit-sync compatibility is handled in the Rust binary at startup, not here). Installed at `/usr/bin/kappastream`; the real binary lives at `/usr/lib/kappastream/kappastream`. |

Edit these here, not in the per-distro directories. Bump the metainfo
`<releases>` block when cutting a release (version must match the three
authoritative version sources: `package.json`, `src-tauri/Cargo.toml`,
`src-tauri/tauri.conf.json`).
