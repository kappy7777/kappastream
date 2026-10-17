#!/usr/bin/env bash
#
# Stage the shared libraries the AppImage must carry even though the pinned
# linuxdeploy build refuses to deploy them itself.
#
# Usage:
#   scripts/stage-appimage-libs.sh [staging-dir]
#     staging-dir defaults to src-tauri/appimage-staging/ (gitignored)
#
# Why: the embedded mpv engine links the build host's `libmpv.so.2`, whose
# hard DT_NEEDED entries include audio client libraries named on linuxdeploy's
# built-in excludelist (the pinned linuxdeploy revision added
# libpipewire-0.3.so.0 at the @tauri-apps/cli 2.12 bump; libjack.so.0 has been
# on it far longer). linuxdeploy deploys nothing on that list, so an AppImage
# built without this staging step dies in the dynamic loader on hosts that
# lack the lib — before main() ever runs. Shipping the lib through
# `bundle.linux.appimage.files` in src-tauri/tauri.conf.json pre-places it in
# the AppDir instead: linuxdeploy leaves pre-placed files alone (the
# excludelist only stops it copying the system copy in) and still deploys
# their dependencies.
#
# Each file is copied dereferenced (cp -L) under EXACTLY its SONAME. The
# SONAME spelling is load-bearing for libpipewire: compat.rs finds the
# bundled client in /proc/self/maps and looks the system twin up in the
# ldconfig cache BY THAT BASENAME — a versioned filename
# (libpipewire-0.3.so.0.1404) would never match, and the system-client swap
# would silently stop firing on PipeWire hosts.
#
# Each SONAME is resolved the way the BUILD HOST's loader resolves it for the
# system libmpv.so.2 (ldd), so the bundled bytes always match the libmpv the
# engine was linked against. Source path, owning package and GNU build-id are
# logged; the AppDir guard (scripts/check-appimage-libs.sh) later compares the
# build-ids. Exits non-zero whenever a lib cannot be resolved or lacks a
# build-id — fail closed, never stage a bundle the guard would reject.
set -euo pipefail

# The SONAMEs to stage. Keep this list, the `bundle.linux.appimage.files`
# entries in src-tauri/tauri.conf.json, and the host allowlist in
# scripts/check-appimage-libs.sh in sync.
sonames=(
  libpipewire-0.3.so.0
  libjack.so.0
)

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
staging="${1:-$repo_root/src-tauri/appimage-staging}"

# Locate the system libmpv.so.2 the embedded engine links against. The
# ldconfig cache is authoritative; the directory probes cover a cache that
# went stale (same fallback discipline as compat.rs's system_pipewire_path).
#
# The awk snippets in this script deliberately never exit early: under
# pipefail, a first-match `exit` closes the pipe mid-stream, the upstream
# tool dies on SIGPIPE, and set -e aborts the whole script at the assignment.
find_libmpv() {
  local hit
  hit="$(ldconfig -p 2>/dev/null | awk '!f && $1 == "libmpv.so.2" {sub(/.*=> /, ""); print; f = 1}')"
  if [ -n "$hit" ] && [ -f "$hit" ]; then
    printf '%s\n' "$hit"
    return
  fi
  local dir
  for dir in \
    /usr/lib/x86_64-linux-gnu /lib/x86_64-linux-gnu \
    /usr/lib64 /lib64 /usr/lib /lib; do
    if [ -f "$dir/libmpv.so.2" ]; then
      printf '%s\n' "$dir/libmpv.so.2"
      return
    fi
  done
  return 1
}

# Resolve a SONAME the way the loader does inside ldd's child: the first
# `soname => /abs/path` line for the system libmpv.so.2. A `=> not found`
# line yields nothing, which the caller treats as a hard failure.
resolve_via_libmpv() {
  local soname="$1" libmpv="$2"
  ldd "$libmpv" 2>/dev/null \
    | awk -v s="$soname" '!f && $1 == s && $2 == "=>" && $3 ~ /^\// {print $3; f = 1}'
}

# Human-readable owning package for the log: dpkg on the Debian/Ubuntu build
# hosts, rpm for local runs on Fedora-family machines, "unknown" elsewhere.
describe_package() {
  local real pkg
  real="$(readlink -f "$1")"
  if command -v dpkg >/dev/null 2>&1; then
    pkg="$(dpkg -S "$real" 2>/dev/null | sed -n '1s/:.*//p')"
    if [ -n "$pkg" ]; then
      printf 'dpkg %s %s\n' "$pkg" "$(dpkg-query -W -f='${Version}' "$pkg" 2>/dev/null || echo 'version?')"
      return
    fi
  fi
  if command -v rpm >/dev/null 2>&1; then
    pkg="$(rpm -qf "$real" 2>/dev/null || true)"
    if [ -n "$pkg" ]; then
      printf 'rpm %s\n' "$pkg"
      return
    fi
  fi
  echo 'unknown package owner'
}

build_id_of() {
  readelf -n "$1" 2>/dev/null | awk '!f && /Build ID/ {print $3; f = 1}'
}

libmpv="$(find_libmpv)" || {
  echo "error: no system libmpv.so.2 found (ldconfig -p + standard dirs) — cannot resolve the bundle libs" >&2
  exit 1
}
echo "resolving against system libmpv: $libmpv ($(describe_package "$libmpv"))"

mkdir -p "$staging"
staged_any=0
for soname in "${sonames[@]}"; do
  src="$(resolve_via_libmpv "$soname" "$libmpv")"
  if [ -z "$src" ] || [ ! -f "$src" ]; then
    echo "error: $soname does not resolve through the system libmpv.so.2 — refusing to build an AppImage that would fail the loader on hosts without it" >&2
    exit 1
  fi
  cp -L "$src" "$staging/$soname"
  bid="$(build_id_of "$staging/$soname")"
  if [ -z "$bid" ]; then
    echo "error: staged $soname has no GNU build-id (needed by the AppDir guard's staged-vs-bundled comparison)" >&2
    exit 1
  fi
  echo "staged $soname"
  echo "  source:   $src"
  echo "  package:  $(describe_package "$src")"
  echo "  build-id: $bid"
  staged_any=1
done

if [ "$staged_any" -eq 0 ]; then
  echo "error: empty staging list — nothing to stage" >&2
  exit 1
fi
echo "staging dir: $staging"
