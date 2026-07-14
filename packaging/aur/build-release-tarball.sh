#!/usr/bin/env bash
#
# Build the prebuilt release tarball consumed by the kappastream-bin AUR
# package (packaging/aur/PKGBUILD-bin). Bundles the prebuilt native binary
# with the shared desktop/metainfo/wrapper assets, icons, and license into a
# single self-contained archive the -bin PKGBUILD fetches via source=().
#
# Input binary: src-tauri/target/release/kappastream by default (build it
# first via the AppImage flow, `npx tauri build`, or
# `cargo build --release --features tauri/custom-protocol`). Override with
# KAPPASTREAM_PREBUILT_BINARY=/path for an already-built binary.
#
# Output: packaging/aur/dist/kappastream-<version>-x86_64.tar.gz
# Includes install.sh (a `sudo ./install.sh` convenience for manual-tarball
# users; the AUR PKGBUILD-bin ignores it).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
SHARED="$REPO_ROOT/packaging/shared"
PKG="kappastream"

cd "$REPO_ROOT"

VERSION="$(node -p "require('./package.json').version")"
# The archive stem is also the single top-level dir inside the tarball, so a
# plain `tar xf` extracts into ./kappastream-<ver>-x86_64/ (conventional, and
# what PKGBUILD-bin's package() cds into). Avoids the earlier foot-gun where a
# flat archive scattered files into whatever dir it was unpacked in.
ARCHIVE_STEM="${PKG}-${VERSION}-x86_64"
OUT="${ARCHIVE_STEM}.tar.gz"

BIN="${KAPPASTREAM_PREBUILT_BINARY:-$REPO_ROOT/src-tauri/target/release/${PKG}}"
if [ ! -x "$BIN" ]; then
	echo "error: prebuilt binary not found at $BIN" >&2
	echo "       build it first:  npm run build &&" >&2
	echo "       (cd src-tauri && cargo build --release --features tauri/custom-protocol)" >&2
	echo "       or set KAPPASTREAM_PREBUILT_BINARY=/path" >&2
	exit 1
fi

echo "==> Building $OUT (version $VERSION) from $BIN"

STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT

# Staged at the archive root; the tar step below nests them under one
# top-level dir ($ARCHIVE_STEM) so extraction is self-contained.
install -m755 "$BIN"                                            "$STAGE/${PKG}"
install -m755 "$SHARED/${PKG}.sh"                               "$STAGE/${PKG}.sh"
# Manual-install helper for users who extract the tarball by hand instead of
# going through the AUR PKGBUILD. Ignored by PKGBUILD-bin (it doesn't reference
# it) — only used by people running `sudo ./install.sh` from an extraction.
install -m755 "$SCRIPT_DIR/install.sh"                          "$STAGE/install.sh"
install -m644 "$SHARED/${PKG}.desktop"                          "$STAGE/${PKG}.desktop"
install -m644 "$SHARED/dev.kappy.kappastream.metainfo.xml"      "$STAGE/dev.kappy.kappastream.metainfo.xml"
install -m644 "$REPO_ROOT/LICENSE"                              "$STAGE/LICENSE"
ICONS="$REPO_ROOT/src-tauri/icons"
install -m644 "$ICONS/32x32.png"      "$STAGE/32x32.png"
install -m644 "$ICONS/64x64.png"      "$STAGE/64x64.png"
install -m644 "$ICONS/128x128.png"    "$STAGE/128x128.png"
install -m644 "$ICONS/128x128@2x.png" "$STAGE/128x128@2x.png"
install -m644 "$ICONS/icon.png"       "$STAGE/icon.png"

mkdir -p "$SCRIPT_DIR/dist"
# --transform rewrites the leading "." of every staged path to $ARCHIVE_STEM,
# so the archive root is a single kappastream-<ver>-x86_64/ dir. Same trick
# packaging/fedora/build.sh uses for its source tarball.
tar -C "$STAGE" --transform "s,^\.,${ARCHIVE_STEM}," -czf "$SCRIPT_DIR/dist/$OUT" .

echo "==> Wrote $SCRIPT_DIR/dist/$OUT"
echo "    sha256: $(sha256sum "$SCRIPT_DIR/dist/$OUT" | cut -d' ' -f1)"
echo "    Feed this hash into PKGBUILD-bin's sha256sums before publishing."
echo "    Manual install:  tar xf $OUT && cd kappastream-*-x86_64 && sudo ./install.sh"
