# AUR packaging for kappastream

Files for publishing kappastream to the [Arch User Repository](https://aur.archlinux.org).
Two packages ship from this directory:

- **`kappastream-git`** (`PKGBUILD`) — builds natively from the git tip (rust +
  cargo + node toolchain). Idiomatic on Arch; uses system webkit2gtk/gstreamer.
- **`kappastream-bin`** (`PKGBUILD-bin`) — repackages the upstream prebuilt
  native binary. No compilation; fast install from the release artifact.

## Contents

| File | Purpose |
| --- | --- |
| `PKGBUILD` | `kappastream-git` makepkg recipe (builds frontend + `cargo build --release`). |
| `PKGBUILD-bin` | `kappastream-bin` makepkg recipe (downloads the prebuilt release tarball, no toolchain). |
| `build-release-tarball.sh` | Builds the self-contained release tarball `PKGBUILD-bin` downloads (binary + shared assets + icons). |
| `.gitignore` | Excludes makepkg output, local clones, and `dist/`. |
| `README.md` | This file. |

Shared assets (also used by the Debian/Fedora packages, live in
`packaging/shared/`):

| File | Purpose |
| --- | --- |
| `kappastream.desktop` | Desktop entry (native, not the AppImage one). |
| `dev.kappy.kappastream.metainfo.xml` | AppStream metadata for GNOME Software / KDE Discover. |
| `kappastream.sh` | Runtime launcher that applies the WebKitGTK Wayland workaround. |

## `-git` vs `-bin`

- **`kappastream-git`** — builds from source. Idiomatic on Arch, no opaque
  AppImage, uses system webkit2gtk/gstreamer. Heavier install (compiles Rust).
- **`kappastream-bin`** — repackages the prebuilt native release binary. No
  toolchain needed; fast install. Same native ELF as `-git` (NOT the AppImage),
  just precompiled by the maintainer into a release tarball. Requires a
  published release (see `build-release-tarball.sh`) for `PKGBUILD-bin`'s
  `source=()` to fetch.

Both `provides=('kappastream')` and `conflict` with each other, so only one is
installed at a time. Publish `-git` first; add `-bin` once you cut a tagged
release with the prebuilt tarball attached.

## Prerequisites (on an Arch host)

```bash
sudo pacman -S base-devel git
# Validation tools (recommended):
sudo pacman -S appstream-glib desktop-file-utils namcap
```

## Local build & test

From this directory:

```bash
# 1. Build and install into a clean build dir:
cd packaging/aur
makepkg -si            # builds + installs + pulls streamlink/webkit2gtk deps

# 2. Validate the metadata (do this before every upload):
desktop-file-validate kappastream.desktop
appstream-util validate-relax dev.kappy.kappastream.metainfo.xml
namcap PKGBUILD
namcap kappastream-*.pkg.tar.zst

# 3. Smoke-test:
kappastream
```

If `makepkg` complains about missing deps, install them — they're the same
ones listed in the `PKGBUILD` `depends=`/`makedepends=`.

### `-bin` (prebuilt, no toolchain)

`PKGBUILD-bin` needs the release tarball to exist before `makepkg` can fetch
it. Build it from the prebuilt binary first:

```bash
# from the repo root — produces packaging/aur/dist/kappastream-<ver>-x86_64.tar.gz:
bash packaging/aur/build-release-tarball.sh

# then build the -bin package (point _release at the local file:// URL, or
# publish the tarball to a release and use the real URL):
cd packaging/aur
makepkg -p PKGBUILD-bin -si
kappastream
```

## Publish to AUR

The AUR is a per-package git repo. You push the `PKGBUILD` (+ `.SRCINFO`), not a binary.

### `kappastream-git`

```bash
# One-time: set up an AUR account + add your SSH key at https://aur.archlinux.org
# Clone the (empty) package repo (create it first via the AUR web UI if it doesn't exist):
git clone ssh://aur@aur.archlinux.org/kappastream-git.git
cd kappastream-git

# Copy in your reviewed files:
cp /path/to/packaging/aur/PKGBUILD .
cp /path/to/packaging/aur/README.md .
cp /path/to/packaging/aur/.gitignore .
cp /path/to/packaging/shared/kappastream.desktop .
cp /path/to/packaging/shared/dev.kappy.kappastream.metainfo.xml .
cp /path/to/packaging/shared/kappastream.sh .

# Generate .SRCINFO (AUR indexes from this, not the PKGBUILD):
makepkg --printsrcinfo > .SRCINFO

git add .gitignore PKGBUILD .SRCINFO README.md kappastream.desktop kappastream.sh dev.kappy.kappastream.metainfo.xml
git commit -m "Initial import: kappastream-git 0.1.0"
git push origin master
```

Within a minute the package appears at `https://aur.archlinux.org/packages/kappastream-git`.

### `kappastream-bin`

Needs a published release tarball (attached to a GitHub release) so
`PKGBUILD-bin`'s `source=()` resolves. After attaching the tarball from
`build-release-tarball.sh` to the release:

```bash
git clone ssh://aur@aur.archlinux.org/kappastream-bin.git
cd kappastream-bin
cp /path/to/packaging/aur/PKGBUILD-bin PKGBUILD   # AUR expects the file named PKGBUILD
# fill in _release (real URL prefix) + the sha256sum (makepkg -g)
makepkg --printsrcinfo > .SRCINFO
git add PKGBUILD .SRCINFO
git commit -m "Initial import: kappastream-bin 0.1.0"
git push origin master
```

## Updating on a new release

1. Tag the release in the source repo (`git tag v0.2.0`).
2. (Optional) switch `pkgver()` to the `git describe` variant noted in the PKGBUILD.
3. In the AUR repo: update the `PKGBUILD` (bump `pkgrel` to 1, adjust anything that changed), regenerate `.SRCINFO`, commit, push.

## Notes

- **Runtime dep: `streamlink`** is in `depends=`, so `makepkg -si` / `yay` pulls it
  automatically. Users who installed without deps must `pacman -S streamlink` themselves.
- **App ID:** the desktop file and metainfo use `dev.kappy.kappastream`. AUR does not
  verify domain ownership, so this is fine for AUR. If you later target Flathub, you'd
  need an ID under a domain you control.
- **The desktop file is native** (`Exec=kappastream`, no AppImage runtime) — it matches
  the binary the PKGBUILD installs to `/usr/bin/kappastream`.
