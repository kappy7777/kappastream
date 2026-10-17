#!/usr/bin/env bash
#
# Guard an AppDir against dynamic-loader regressions.
#
# Usage:
#   scripts/check-appimage-libs.sh <kappastream.AppDir> <staging-dir>
#
# Two checks, both fail-closed:
#
#   1. Every library staged by scripts/stage-appimage-libs.sh must be in the
#      AppDir's usr/lib/ as a REGULAR file named exactly by its SONAME, with
#      the same GNU build-id as the staged original. Build-ids, not sha256:
#      linuxdeploy appends `$ORIGIN` to the RUNPATH of every library it finds
#      in the AppDir, so bundled copies legitimately differ byte-wise from the
#      staged files, while .note.gnu.build-id survives the patch. A mismatch
#      still catches the real failures — linuxdeploy dropping or replacing
#      the file.
#
#   2. The DT_NEEDED closure of usr/bin/kappastream, walked recursively and
#      resolved against the AppDir's own usr/lib/, may only leave the
#      explicitly host-provided allowlist below unresolved. Anything else
#      unresolved means some host is guaranteed a loader death before
#      main() ("error while loading shared libraries: …").
#
# The allowlist is exactly the set of libraries the AppImage deliberately
# takes from the host at runtime (the graphics/X11 stack and the glibc
# group). libpipewire-0.3.so.0 must NEVER be on it: the embedded engine
# links it, the pinned linuxdeploy excludelists it, and a build that neither
# bundles it nor may take it from the host dies on PipeWire-less systems —
# the exact v1.0.6/v1.0.7 regression this guard exists to catch. The assert
# below turns a future careless allowlist edit into a build failure.
set -euo pipefail

if [ "$#" -ne 2 ]; then
  echo "usage: $0 <kappastream.AppDir> <staging-dir>" >&2
  exit 2
fi

appdir="$1"
staging="$2"
usrlib="$appdir/usr/lib"
binary="$appdir/usr/bin/kappastream"

for f in "$usrlib" "$binary" "$staging"; do
  if [ ! -e "$f" ]; then
    echo "error: required path missing: $f" >&2
    exit 1
  fi
done

# No early awk exits anywhere in this script: under pipefail a first-match
# `exit` SIGPIPEs the upstream tool and set -e aborts the guard spuriously.
build_id_of() {
  readelf -n "$1" 2>/dev/null | awk '!f && /Build ID/ {print $3; f = 1}'
}

fail=0

# ---- 1. staged libs: present, regular, SONAME-named, same build-id --------
staged_count=0
for staged in "$staging"/*; do
  [ -f "$staged" ] || continue
  staged_count=$((staged_count + 1))
  soname="$(basename "$staged")"
  bundled="$usrlib/$soname"
  if [ ! -e "$bundled" ]; then
    echo "ERROR: $soname was staged but is missing from the AppDir ($bundled)" >&2
    fail=1
    continue
  fi
  if [ -L "$bundled" ] || [ ! -f "$bundled" ]; then
    echo "ERROR: $bundled must be a regular file named by its SONAME — compat.rs keys the pipewire swap off the mapped file's basename" >&2
    fail=1
    continue
  fi
  staged_id="$(build_id_of "$staged")"
  bundled_id="$(build_id_of "$bundled")"
  if [ -z "$staged_id" ] || [ "$staged_id" != "$bundled_id" ]; then
    echo "ERROR: $soname build-id mismatch — staged ${staged_id:-<none>} vs bundled ${bundled_id:-<none>}" >&2
    fail=1
  else
    echo "OK: $soname present as a regular file, build-id $bundled_id"
  fi
done
if [ "$staged_count" -eq 0 ]; then
  echo "ERROR: staging dir has no staged libraries — run scripts/stage-appimage-libs.sh first" >&2
  exit 1
fi

# ---- 2. the host-provided allowlist ---------------------------------------
# Libraries the AppImage intentionally resolves from the host at runtime.
# libpipewire-0.3.so.0 and libjack.so.0 are deliberately absent: both are
# staged+bundled by scripts/stage-appimage-libs.sh (the pinned linuxdeploy
# excludelists them), and a regression to "take them from the host" must
# fail this guard, not pass silently.
host_allowlist="$(cat <<'EOF'
ld-linux-x86-64.so.2
libc.so.6
libm.so.6
libresolv.so.2
libgcc_s.so.1
libstdc++.so.6
libz.so.1
libexpat.so.1
libgmp.so.10
libgpg-error.so.0
libcom_err.so.2
libusb-1.0.so.0
libasound.so.2
libdrm.so.2
libgbm.so.1
libEGL.so.1
libGL.so.1
libX11.so.6
libX11-xcb.so.1
libxcb.so.1
libxcb-dri3.so.0
libwayland-client.so.0
libfontconfig.so.1
libfreetype.so.6
libharfbuzz.so.0
libfribidi.so.0
EOF
)"

# libpipewire is bundled precisely so PipeWire-less hosts can resolve it;
# allowing it from the host would silently re-enable the regression.
if printf '%s\n' "$host_allowlist" | grep -q 'libpipewire'; then
  echo "ERROR: libpipewire-0.3.so.0 must never be on the host allowlist — bundle it instead" >&2
  exit 1
fi

# ---- 3. DT_NEEDED closure of the startup binary ---------------------------
# Iterative worklist: resolve each DT_NEEDED name against the AppDir's own
# usr/lib (the bundled libs' RUNPATH is $ORIGIN, i.e. that directory), recurse
# into bundled hits, and collect the misses.
declare -A visited=()
queue=("$binary")
unresolved=()
while [ "${#queue[@]}" -gt 0 ]; do
  elf="${queue[0]}"
  queue=("${queue[@]:1}")
  [ -n "${visited[$elf]:-}" ] && continue
  visited[$elf]=1
  while IFS= read -r dep; do
    [ -z "$dep" ] && continue
    if [ -e "$usrlib/$dep" ]; then
      queue+=("$usrlib/$dep")
    else
      unresolved+=("$dep")
    fi
  done < <(readelf -d "$elf" 2>/dev/null | awk '/NEEDED/ {gsub(/[][]/, "", $5); print $5}')
done

echo "closure: ${#visited[@]} ELF files walked from usr/bin/kappastream"

extra="$(printf '%s\n' "${unresolved[@]}" | sort -u | comm -23 - <(printf '%s\n' "$host_allowlist" | sort))"
if [ -n "$(printf '%s' "$extra" | tr -d '[:space:]')" ]; then
  echo "ERROR: startup closure leaves libraries unresolved outside the host allowlist:" >&2
  printf '%s\n' "$extra" | sed 's/^/       /' >&2
  fail=1
else
  echo "OK: unresolved DT_NEEDED entries are all on the host allowlist ($(printf '%s\n' "${unresolved[@]}" | sort -u | grep -c .) distinct)"
fi

if [ "$fail" -ne 0 ]; then
  exit 1
fi
echo "OK: AppDir lib guard passed"
