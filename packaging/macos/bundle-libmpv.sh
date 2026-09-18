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
# own ad-hoc app signing runs later, during bundling). The codesign pass MUST
# run AFTER the rpath dedupe below — the dedupe's install_name_tool calls
# invalidate whatever signatures existed before it.
#
# NOTE on the FINAL signing (tauri-bundler, after this hook): it re-signs the
# .app's main executable ad-hoc WITH hardened runtime (bundle.macOS
# .hardenedRuntime defaults true) — library validation then rejects these
# separately ad-hoc-signed dylibs at launch (no team identity to match;
# hardware-verified macOS 26.6, 2026-09-18). tauri.macos.conf.json therefore
# points bundle.macOS.entitlements at packaging/macos/Entitlements.plist
# (disable-library-validation), which rides that final pass. Nothing here
# needs to change for it; release.yml's signing gate verifies the result.
# (Path gotcha: the entitlements value resolves against src-tauri/ — the
# bundler's cwd — hence the ../ prefix, like the ../mac-mpv-libs/ resource.)
#
# LC_RPATH DEDUPE + GATE (2026-09-18): dylibbundler rewrites EACH LC_RPATH of
# a copied dylib's ORIGINAL Homebrew build to the -p value — ONE
# `install_name_tool -rpath <old> <prefix>` per ORIGINAL entry (its
# DylibBundler.cpp fixRpathsOnFile, driven by the rpaths it parsed out of the
# ORIGINAL dylib's `otool -l`). An original that carries two rpaths —
# Homebrew's libmpv.2.dylib does — therefore ships the prefix TWICE, and
# dyld4 on macOS 26 refuses the whole image at load ("duplicate LC_RPATH
# '@executable_path/../Resources/mpv-libs/'" — the first .app tested on
# hardware died before main()). Not a doubled-hook artifact: tauri runs
# beforeBundleCommand once per job (verified in the release.yml run logs),
# and this script rm -rf's the staging dir anyway. Fix: reduce every
# duplicate to exactly ONE entry — never strip the last one (the entries are
# unused today, but a future dependency with @rpath references resolves
# through them) — then hard-fail the build if ANY bundled image (dylib OR
# the main binary) still carries a duplicate LC_RPATH, or if the staging dir
# contains zero dylibs. A build that would ship an unlaunchable .app must
# fail CI instead of producing an artifact.
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

# LC_RPATH values of a Mach-O image, one per line (otool -l prints each
# rpath as `path <value> (offset <n>)`; the `path ` prefix only appears in
# LC_RPATH load commands — dependency names use `name `).
rpaths_of() {
  otool -l "$1" | sed -n 's/^ *path \(.*\) (offset .*)$/\1/p'
}

# Reduce any duplicated LC_RPATH value in one image to exactly ONE entry.
# install_name_tool -delete_rpath removes a single instance per call (not
# man-page-documented, but established behavior — hence the loop); the loop
# recounts and the final assertion demands exactly one survivor, so the
# build fails LOUDLY if the tool ever behaved differently instead of
# silently stripping the last entry.
dedupe_rpaths_in() {
  local f="$1" val count post
  while IFS= read -r val; do
    [ -n "$val" ] || continue
    count=$(rpaths_of "$f" | grep -cxF "$val" || true)
    if [ "$count" -le 1 ]; then
      continue
    fi
    echo "  $f: $count duplicate LC_RPATH '$val' — reducing to one"
    while [ "$count" -gt 1 ]; do
      install_name_tool -delete_rpath "$val" "$f"
      count=$((count - 1))
    done
    post=$(rpaths_of "$f" | grep -cxF "$val" || true)
    if [ "$post" -ne 1 ]; then
      echo "ERROR: $f: expected exactly 1 LC_RPATH '$val' after dedupe, found $post" >&2
      return 1
    fi
  done < <(rpaths_of "$f" | sort -u)
}

rm -rf "$STAGING"
mkdir -p "$STAGING"

dylibbundler -b -x "$BIN" -d "$STAGING" -p "$DEST"

# --- rpath dedupe BEFORE signing: install_name_tool invalidates signatures,
# so the codesign pass below must be the LAST thing that touches the images.
echo "* Deduping LC_RPATH entries (dylibbundler preserves the original's rpath COUNT — see header)"
dedupe_rpaths_in "$BIN"
while IFS= read -r dylib; do
  dedupe_rpaths_in "$dylib"
done < <(find "$STAGING" -name '*.dylib' | sort)

codesign --force --sign - "$BIN"
find "$STAGING" -name '*.dylib' -print0 | xargs -0 -n1 codesign --force --sign -

# --- hard verification gate: a bundle with a duplicate LC_RPATH anywhere is
# unlaunchable on macOS 26 (dyld rejects the image) — fail the build instead
# of shipping it. Walk EVERY bundled dylib plus the main binary; the main
# binary alone is NOT enough (it was clean in the crash this gate exists
# for). Also prints every image's rpath count for the build log.
echo "* LC_RPATH verification gate"
dylib_total=$(find "$STAGING" -name '*.dylib' | wc -l | tr -d ' ')
if [ "$dylib_total" -eq 0 ]; then
  echo "ERROR: $STAGING contains zero dylibs — the bundling produced nothing" >&2
  exit 1
fi
dups_found=0
check_dup_rpaths() {
  local f="$1" dup n
  dup=$(rpaths_of "$f" | sort | uniq -d)
  if [ -n "$dup" ]; then
    echo "  ERROR: duplicate LC_RPATH in $f:" >&2
    echo "$dup" | sed 's/^/         /' >&2
    return 1
  fi
  n=$(rpaths_of "$f" | grep -c . || true)
  if [ "$n" -gt 0 ]; then
    echo "  $f: $n LC_RPATH entries"
  fi
  return 0
}
if ! check_dup_rpaths "$BIN"; then
  dups_found=$((dups_found + 1))
fi
while IFS= read -r dylib; do
  if ! check_dup_rpaths "$dylib"; then
    dups_found=$((dups_found + 1))
  fi
done < <(find "$STAGING" -name '*.dylib' | sort)
if [ "$dups_found" -gt 0 ]; then
  echo "ERROR: $dups_found image(s) carry duplicate LC_RPATH entries — dyld on macOS 26 rejects such images at launch" >&2
  exit 1
fi
echo "LC_RPATH gate passed: no duplicates across $dylib_total dylibs + the main binary"

du -sh "$STAGING" | tee /tmp/ks-mac-mpv-libs-size.txt
echo "bundled $(find "$STAGING" -name '*.dylib' | wc -l | tr -d ' ') libmpv dependency dylibs" | tee -a /tmp/ks-mac-mpv-libs-size.txt
