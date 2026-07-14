#!/usr/bin/env bash
#
# Build a native kappastream .rpm — a standalone release artifact.
#
# Tars the source tree, generates the real .spec from kappastream.spec.in
# (@VERSION@ from package.json), and invokes `rpmbuild -bb`. The actual
# npm + cargo build runs inside the spec's %build (run by rpmbuild), exactly
# like the AUR PKGBUILD carries its build logic.
#
# Output: packaging/fedora/dist/kappastream-<version>-1.<dist>.x86_64.rpm
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
PKG="kappastream"

cd "$REPO_ROOT"

# Version: package.json is the single read source (kept in sync with
# src-tauri/Cargo.toml and src-tauri/tauri.conf.json — see AGENTS.md).
VERSION="$(node -p "require('./package.json').version")"
TARBALL="${PKG}-${VERSION}.tar.gz"
OUTDIR="$SCRIPT_DIR/dist"

echo "==> Building ${PKG}-${VERSION}-1.*.rpm (version $VERSION)"

# rpmbuild tree (outside the repo so the tarball isn't self-included).
TOPDIR="$(mktemp -d)"
trap 'rm -rf "$TOPDIR"' EXIT
mkdir -p "$TOPDIR"/{SOURCES,SPECS,BUILD,RPMS,SRPMS}

# --- 1. Source tarball -----------------------------------------------------
# rpmbuild's %setup unpacks Source0 into %{name}-%{version}/. Exclude build
# artifacts, VCS, and per-distro packaging output so the tarball is clean.
echo "==> Creating source tarball: $TARBALL"
tar \
    --exclude='./.git' \
    --exclude='./node_modules' \
    --exclude='./dist' \
    --exclude='./src-tauri/target' \
    --exclude='./packaging/*/dist' \
    --exclude='./packaging/aur/pkg' \
    --exclude='./packaging/aur/src' \
    --exclude='./packaging/aur/*.pkg.tar*' \
    --exclude='./packaging/aur/*.src.tar.gz' \
    --exclude='./packaging/aur/kappastream' \
    --exclude='./packaging/aur/kappastream-*' \
    --transform "s,^\.,${PKG}-${VERSION}," \
    -czf "$TOPDIR/SOURCES/$TARBALL" .

# --- 2. Generate the real .spec from the template --------------------------
sed "s/@VERSION@/$VERSION/g" \
    "$SCRIPT_DIR/kappastream.spec.in" > "$TOPDIR/SPECS/${PKG}.spec"

# --- 3. rpmbuild -----------------------------------------------------------
echo "==> rpmbuild -bb"
rpmbuild -bb \
    --define "_topdir $TOPDIR" \
    "$TOPDIR/SPECS/${PKG}.spec"

# --- 4. Collect the built .rpm --------------------------------------------
mkdir -p "$OUTDIR"
find "$TOPDIR/RPMS" -name "${PKG}-*.rpm" -print \
    -exec cp -f {} "$OUTDIR"/ \;

echo "==> Wrote .rpm(s) to $OUTDIR:"
ls -la "$OUTDIR"
echo "    Inspect:  rpm -qip $OUTDIR/${PKG}-*.rpm   (metadata)"
echo "              rpm -qlp $OUTDIR/${PKG}-*.rpm   (file list)"
echo "              rpmlint   $OUTDIR/${PKG}-*.rpm   (policy checks)"
