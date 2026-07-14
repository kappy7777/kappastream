# Debian / Ubuntu packaging for kappastream

Builds a **native** `.deb` from source (not the AppImage): the frontend is built
with Vite, then `cargo build --release` embeds `dist/` into the Rust binary via
tauri-build. The result is assembled into a `.deb` with `dpkg-deb`.

This is a standalone release artifact — there is **no** apt repository / PPA.
Users install it with `dpkg -i` (or `apt install ./kappastream_*.deb`).

## Targets

| Distro | Status | Why |
| --- | --- | --- |
| Ubuntu 24.04 (noble) | ✅ primary build host | glibc 2.39 — the older floor |
| Debian 13 (trixie) | ✅ covered by the noble build | glibc 2.40 (newer → runs the noble binary); t64 `Provides` satisfy the non-t64 `Depends` names |
| Debian 12 (bookworm) | ❌ | only has webkit2gtk-4.0; Tauri 2 needs 4.1. Use the AppImage. |
| Ubuntu 22.04 (jammy) | ❌ | same — webkit2gtk-4.0 only. Use the AppImage. |

If a trixie box ever fails dependency resolution on the noble-built `.deb`,
rebuild inside a `debian:trixie` container (its native toolchain is recent
enough that no rustup/nodesource is needed) and ship that `.deb` for trixie.

## Contents

| File | Purpose |
| --- | --- |
| `build.sh` | Orchestrates npm + cargo build, assembles the staging tree, calls `dpkg-deb --build`. |
| `control.in` | `DEBIAN/control` template (`@VERSION@` / `@INSTALLED_SIZE@` substituted at build time). |
| `postinst` / `postrm` | Refresh desktop-entry + icon caches (guarded; the dpkg path triggers usually handle this). |
| `Dockerfile` | Ubuntu 24.04 build host (rustup + nodesource for current toolchains). |
| `.gitignore` | Excludes `dist/`. |
| `README.md` | This file. |

Shared assets (desktop entry, metainfo, Wayland-workaround wrapper) live in
`packaging/shared/`.

## Why `dpkg-deb` and not debhelper

Matches the AUR's "single recipe" philosophy: one readable `build.sh`, no
debhelper version dance, no assumptions about the source tree being laid out as
a Debian source package. The `.deb` is still lintian-mostly-clean. Switch to a
proper debhelper `debian/` source package only if you later target a PPA or
official Debian inclusion.

## Local build & test

The build runs in the Docker container (it needs `libwebkit2gtk-4.1-dev` and a
current Rust/Node, which this repo's dev container does not provide):

```bash
# from the repo root:
docker build -t kappastream-deb packaging/debian
docker run --rm -v "$PWD":/src kappastream-deb
# → packaging/debian/dist/kappastream_<version>_amd64.deb
```

Then inspect and (lintian permitting) validate:

```bash
cd packaging/debian
dpkg-deb -I  dist/kappastream_*_amd64.deb   # metadata
dpkg-deb -c  dist/kappastream_*_amd64.deb   # file tree
dpkg-deb -W  dist/kappastream_*_amd64.deb   # name + version
lintian      dist/kappastream_*_amd64.deb   # policy checks (apt install lintian)
```

Install on a real noble/trixie box and smoke-test (video, chat, emotes,
notifications, external links, fullscreen, favorites persistence).

## Release

Ship `kappastream_<version>_amd64.deb` as a GitHub release asset alongside the
AppImage, with a SHA-256 in `SHA256SUMS`. GPG signing (debsigs) is optional and
can be added later without restructuring.

## TODO before first release

1. Confirm the trixie dependency story on a real trixie install (the t64
   `Provides` should resolve every non-t64 `Depends` name).
