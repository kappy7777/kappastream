#!/usr/bin/env bash
#
# Build a native kappastream .deb — a standalone release artifact.
#
# Mirrors packaging/aur/PKGBUILD: builds the frontend with Vite, then
# `cargo build --release` embeds it into the Rust binary via tauri-build, and
# the result is assembled into a .deb with `dpkg-deb`.
#
# Intended to run inside packaging/debian/Dockerfile (Ubuntu 24.04 noble).
# noble's glibc 2.39 is OLDER than Debian 13 trixie's 2.40, so the produced
# binary runs on both. The Depends list uses non-t64 package names, which
# trixie's t64 packages satisfy via Provides (the designed mechanism of the
# 64-bit time_t transition).
#
# Escape hatch: set KAPPASTREAM_PREBUILT_BINARY=/path/to/kappastream to skip
# the npm/cargo build and package an already-built binary (handy for CI that
# builds once and packages for several distros, or for testing this script).
#
# Output: packaging/debian/dist/kappastream_<version>_amd64.deb
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
SHARED="$REPO_ROOT/packaging/shared"
PKG="kappastream"

cd "$REPO_ROOT"

# Version: package.json is the single read source here (kept in sync with
# src-tauri/Cargo.toml and src-tauri/tauri.conf.json — see AGENTS.md).
VERSION="$(node -p "require('./package.json').version")"
OUT="${PKG}_${VERSION}_amd64.deb"

echo "==> Building $OUT (version $VERSION)"

# --- 1. Build the native binary (unless a prebuilt one is supplied) ---------
if [ -n "${KAPPASTREAM_PREBUILT_BINARY:-}" ]; then
	echo "==> Using prebuilt binary: $KAPPASTREAM_PREBUILT_BINARY"
	BIN="$KAPPASTREAM_PREBUILT_BINARY"
else
	echo "==> Frontend: npm ci + npm run build"
	npm ci --no-audit --no-fund
	npm run build

	echo "==> Rust host: cargo build --release"
	(
		cd src-tauri
		# The same three mandatory env tweaks as the AUR PKGBUILD — see that
		# file for the full rationale. Short version:
		#   1. drop the host's hardened toolchain flags (they break aws-lc-sys's
		#      static-archive link with hundreds of undefined aws_lc_0_42_0_*
		#      symbols)
		#   2. force aws-lc-sys to build AWS-LC from bundled source (never
		#      auto-link a host install lacking the symbol prefix)
		#   3. enable the embedded custom-protocol frontend (else no dist/)
		unset CFLAGS CXXFLAGS LDFLAGS RUSTFLAGS || true
		export AWS_LC_SYS_USE_SYSTEM=0
		cargo build --release --locked --features tauri/custom-protocol
	)
	BIN="$REPO_ROOT/src-tauri/target/release/${PKG}"
fi

if [ ! -x "$BIN" ]; then
	echo "error: binary not found or not executable: $BIN" >&2
	exit 1
fi

# --- 2. Assemble the .deb staging tree --------------------------------------
STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT

# DEBIAN/ control metadata (version substituted now; Installed-Size later).
mkdir -p "$STAGE/DEBIAN"
sed "s/@VERSION@/$VERSION/g" "$SCRIPT_DIR/control.in" > "$STAGE/DEBIAN/control"
install -m755 "$SCRIPT_DIR/postinst" "$STAGE/DEBIAN/postinst"
install -m755 "$SCRIPT_DIR/postrm"    "$STAGE/DEBIAN/postrm"

# Real binary → /usr/lib (kept out of $PATH). The wrapper at /usr/bin is now a
# thin launcher; NVIDIA EGL-Wayland explicit-sync compat is handled in the
# binary itself at startup (see packaging/shared/kappastream.sh, src/compat.rs).
install -Dm755 "$BIN"              "$STAGE/usr/lib/${PKG}/${PKG}"
install -Dm755 "$SHARED/${PKG}.sh" "$STAGE/usr/bin/${PKG}"

# Icons (hicolor theme). Sizes mirror the AUR layout.
ICONS="$REPO_ROOT/src-tauri/icons"
install -Dm644 "$ICONS/32x32.png"      "$STAGE/usr/share/icons/hicolor/32x32/apps/${PKG}.png"
install -Dm644 "$ICONS/64x64.png"      "$STAGE/usr/share/icons/hicolor/64x64/apps/${PKG}.png"
install -Dm644 "$ICONS/128x128.png"    "$STAGE/usr/share/icons/hicolor/128x128/apps/${PKG}.png"
install -Dm644 "$ICONS/128x128@2x.png" "$STAGE/usr/share/icons/hicolor/256x256/apps/${PKG}.png"
install -Dm644 "$ICONS/icon.png"       "$STAGE/usr/share/icons/hicolor/512x512/apps/${PKG}.png"

# Desktop entry + AppStream metainfo (shared with AUR/Fedora).
install -Dm644 "$SHARED/${PKG}.desktop" \
	"$STAGE/usr/share/applications/${PKG}.desktop"
install -Dm644 "$SHARED/dev.kappy.kappastream.metainfo.xml" \
	"$STAGE/usr/share/metainfo/dev.kappy.kappastream.metainfo.xml"

# License (Debian convention: /usr/share/doc/<pkg>/copyright) + changelog.
install -Dm644 "$REPO_ROOT/LICENSE" "$STAGE/usr/share/doc/${PKG}/copyright"
{
	printf '%s (%s-1) unstable; urgency=medium\n\n' "$PKG" "$VERSION"
	printf '  * Native Debian package build.\n\n'
	printf ' -- kappy <kappy777@proton.me>  %s\n' "$(date -R)"
} | gzip -n > "$STAGE/usr/share/doc/${PKG}/changelog.Debian.gz"

# Installed-Size (KiB of the installed payload, excluding DEBIAN/).
INSTALLED_SIZE="$(du -sk --exclude=DEBIAN "$STAGE" | cut -f1)"
sed -i "s/@INSTALLED_SIZE@/$INSTALLED_SIZE/" "$STAGE/DEBIAN/control"

# md5sums for every payload file (paths relative to /, no leading ./).
(
	cd "$STAGE"
	find . -type f ! -path './DEBIAN/*' -printf '%P\0' | sort -z | xargs -0 md5sum
) > "$STAGE/DEBIAN/md5sums"

# control + md5sums are data, not executable.
chmod 644 "$STAGE/DEBIAN/control" "$STAGE/DEBIAN/md5sums"
# Staging root perms become the package's ./ entry; mktemp makes it 0700.
chmod 755 "$STAGE"

# --- 3. Build the .deb ------------------------------------------------------
mkdir -p "$SCRIPT_DIR/dist"
rm -f "$SCRIPT_DIR/dist/$OUT"
dpkg-deb --build -Zzstd "$STAGE" "$SCRIPT_DIR/dist/$OUT"

echo "==> Wrote $SCRIPT_DIR/dist/$OUT"
echo "    Inspect:  dpkg-deb -I $SCRIPT_DIR/dist/$OUT"
echo "              dpkg-deb -c $SCRIPT_DIR/dist/$OUT"
