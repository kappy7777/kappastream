#!/usr/bin/env bash
# macOS-only libmpv bundling (runs as tauri.conf.json's beforeBundleCommand,
# i.e. between the cargo build and the .app/.dmg bundling).
#
# The binary links libmpv.dylib from Homebrew, whose install-name references
# (/opt/homebrew/...) only resolve on machines with the exact brew prefix.
# dylibbundler collects libmpv + its ENTIRE non-system dependency closure
# (ffmpeg, libplacebo, libass, …) into mac-mpv-libs/ and rewrites every load
# command — in the main binary AND between the copied dylibs — to
# @executable_path/../Resources/mpv-libs/<name>, where tauri.macos.conf.json
# ships them as bundle resources. The result: the distributed .app runs with
# NO Homebrew install (owner decision 2026-09-16: every platform bundles).
#
# install_name_tool invalidates code signatures, so every touched image is
# re-signed ad-hoc here (arm64 requires a valid signature per dylib; tauri's
# own ad-hoc app signing runs later, during bundling).
#
# Non-Darwin builds (this hook runs for every `tauri build`) exit 0 — the
# script is a no-op on Linux/Windows.
set -euo pipefail
cd "$(dirname "$0")/../.."

if [ "$(uname)" != "Darwin" ]; then
  exit 0
fi

if ! command -v dylibbundler >/dev/null 2>&1; then
  echo "packaging/macos/bundle-libmpv.sh: dylibbundler not found." >&2
  echo "  brew install dylibbundler   (brew install mpv provides the lib itself)" >&2
  exit 1
fi

BIN=src-tauri/target/release/kappastream
STAGING=mac-mpv-libs
DEST='@executable_path/../Resources/mpv-libs/'

rm -rf "$STAGING"
mkdir -p "$STAGING"

dylibbundler -b -x "$BIN" -d "$STAGING" -p "$DEST"

codesign --force --sign - "$BIN"
find "$STAGING" -name '*.dylib' -print0 | xargs -0 -n1 codesign --force --sign -

du -sh "$STAGING" | tee /tmp/ks-mac-mpv-libs-size.txt
echo "bundled $(find "$STAGING" -name '*.dylib' | wc -l | tr -d ' ') libmpv dependency dylibs"
