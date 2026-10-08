# Debian / Ubuntu packaging for kappastream

Builds a **native** `.deb` from source (not the AppImage): the frontend is built
with Vite, then `cargo build --release` embeds `dist/` into the Rust binary via
tauri-build. The result is assembled into a `.deb` with `dpkg-deb`.

This is a local, reproducible alternative to the **released** `.deb`, which
release.yml builds with tauri-bundler in a `debian:12` container (see the
Targets table). There is **no** apt repository / PPA either way. Install a
built `.deb` with `apt install ./kappastream_*.deb` — apt resolves the
declared dependencies; `dpkg -i` alone does not.

## Targets

| Distro | Status | Why |
| --- | --- | --- |
| Debian 12 (bookworm) | ✅ release build host | the shipped `.deb` is built in a `debian:12` container (release.yml): glibc 2.36, `libmpv2`, webkit2gtk-4.1 |
| Debian 13 (trixie) | ✅ covered by the bookworm build | newer glibc runs the bookworm binary; t64 `Provides` satisfy the non-t64 `Depends` names |
| Ubuntu 24.04 (noble) | ✅ runs the release `.deb` | glibc 2.39 ≥ the 2.36 floor; also the base of the local Docker build below |
| Ubuntu 22.04 (jammy) | ❌ | glibc 2.35 is below the 2.36 floor, and jammy ships only libmpv1 (mpv 0.34, SONAME `.so.1`) while the package depends on `libmpv2`. The AppImage is no way out either — it needs glibc 2.39 (Ubuntu 24.04). Jammy is unsupported by every kappastream artifact. |

If a trixie box ever fails dependency resolution on the bookworm-built `.deb`,
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
current Rust/Node, which the Dockerfile provides). The command below runs it
as the invoking host user, with writable `HOME`/`CARGO_HOME`, so `node_modules/`,
`dist/`, `target/` and the output `.deb` are not left root-owned in the
checkout:

```bash
# from the repo root:
docker build -t kappastream-deb packaging/debian
docker run --rm -u "$(id -u):$(id -g)" -e HOME=/tmp -e CARGO_HOME=/tmp/cargo \
  -v "$PWD":/src kappastream-deb
# → packaging/debian/dist/kappastream_<version>_amd64.deb
```

If an earlier root-run already left root-owned `node_modules/` or `target/`
behind, remove them first — the unprivileged build cannot overwrite them.

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

The GitHub release `.deb` is built by release.yml (tauri-bundler, `debian:12`),
not by this directory — the local build is the reproducible alternative for
cases the shipped package doesn't cover (see the trixie note above). If a
locally built `.deb` ever needs to ship instead, publish it with a matching
SHA-256 in `SHA256SUMS`. GPG signing (debsigs) is optional and can be added
later without restructuring.
