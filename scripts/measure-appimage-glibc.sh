#!/usr/bin/env bash
#
# Measure the highest GLIBC_* symbol-version requirement across the ELF
# binaries/shared-objects inside a Tauri AppImage (or an extracted AppDir).
#
# Usage:
#   scripts/measure-appimage-glibc.sh path/to/kappastream_x.y.z_amd64.AppImage
#   scripts/measure-appimage-glibc.sh path/to/kappastream.AppDir
#
# Why: an AppImage built on Ubuntu 24.04 links against 24.04's glibc, so it may
# require a higher GLIBC symbol version than older distros (Debian 11, Ubuntu
# 20.04) provide. This reports the actual highest requirement so the AppImage
# compatibility window can be documented honestly instead of guessed from the
# build-runner name.
#
# Extraction of an .AppImage uses the AppImage runtime's `--appimage-extract`
# mode, which writes ./squashfs-root/ WITHOUT launching the GUI payload (it is
# extraction-only; it never runs the application).
set -euo pipefail

if [ "$#" -ne 1 ]; then
	echo "usage: $0 <kappastream*.AppImage | kappastream.AppDir>" >&2
	exit 2
fi

target="$1"

if [ -d "$target" ]; then
	root="$target"
elif [ -f "$target" ]; then
	workdir="$(mktemp -d)"
	trap 'rm -rf "$workdir"' EXIT
	# `--appimage-extract` writes squashfs-root/ next to the cwd it runs in.
	# Some AppImage runtimes exit non-zero even after a successful extraction
	# (and a missing FUSE/device can abort it outright), so judge success by
	# whether squashfs-root/ was actually produced, not by the exit code.
	( cd "$workdir" && bash "$target" --appimage-extract >/dev/null 2>&1 ) || true
	root="$workdir/squashfs-root"
	if [ ! -d "$root" ]; then
		echo "error: --appimage-extract produced no squashfs-root/ for $target" >&2
		echo "       (pass an already-extracted AppDir to inspect it directly)" >&2
		exit 1
	fi
else
	echo "error: '$target' is not a file or directory" >&2
	exit 2
fi

echo "Scanning ELF files under: $root"

# Collect ELF files in one pass (spawns `file` once per file, no per-line shell).
elf_files="$(
	find "$root" -type f -exec sh -c '
		for f; do
			if file "$f" 2>/dev/null | grep -q "ELF"; then
				printf "%s\n" "$f"
			fi
		done
	' _ {} +
)"
elf_count="$(printf '%s\n' "$elf_files" | grep -c . || true)"
echo "ELF files found: $elf_count"

# readelf -V prints version-need entries whose lines contain:
#   Name: GLIBC_2.34  Flags: none  Version: 7
versions="$(
	printf '%s\n' "$elf_files" \
		| while IFS= read -r f; do
			[ -n "$f" ] && readelf -V "$f" 2>/dev/null || true
		done \
		| grep -oE 'GLIBC_[0-9]+\.[0-9]+(\.[0-9]+)?' \
		| sort -V \
		|| true
)"

if [ -z "$versions" ]; then
	echo "error: no GLIBC_* requirements found (unexpected for a Tauri AppImage)" >&2
	exit 1
fi

echo
echo "GLIBC symbol-version requirements (count | version):"
printf '%s\n' "$versions" | uniq -c | sort -k2 -V

max="$(printf '%s\n' "$versions" | tail -n1)"
echo
echo "Highest GLIBC requirement: $max"
