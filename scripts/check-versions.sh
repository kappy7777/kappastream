#!/bin/sh
# check-versions.sh — fail if kappastream's version sources have drifted.
#
# Asserts that the version is identical across the three authoritative sources:
#   - package.json            (read with `node -p`)
#   - src-tauri/Cargo.toml    (the [package] version)
#   - src-tauri/Cargo.lock    (the kappastream package entry)
# and that no tracked packaging README.md or packaging/aur/PKGBUILD-bin carries
# a hardcoded semver other than the current version. (READMEs should use a
# `<version>` placeholder or derive the version dynamically; PKGBUILD-bin's
# `pkgver` is the one place a literal version is expected and must track
# package.json.)
#
# Exits non-zero with file:line on any mismatch. Wired into CI (ci.yml, before
# the type-check) and the release checklist (CONTRIBUTING.md).
#
# POSIX sh. Uses `grep -oE` (GNU/BSD) to extract individual semver tokens, and
# `git ls-files` so build artifacts (packaging/aur/{src,dist}, which are
# gitignored) are never scanned.
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
ROOT=$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)
cd "$ROOT"

PKG_VER=$(node -p 'require("./package.json").version')

# A prerelease version (e.g. 0.2.6-rc1, anything with a `-` pre-release tail)
# is a throwaway release-channel tag used for updater smoke-tests. The metainfo
# <releases> block and the AUR -bin PKGBUILD track STABLE releases only, so
# during a prerelease they legitimately still carry the previous stable version
# — those drift checks are skipped below. The three authoritative-source
# equality checks (package.json == Cargo.toml == Cargo.lock) ALWAYS run.
case "$PKG_VER" in
  *-*) IS_PRERELEASE=true ;;
  *)   IS_PRERELEASE=false ;;
esac

# [package] version = first unindented `version = "..."` in Cargo.toml. Dependency
# versions live inside `name = { version = "..." }` (indented / not at col 0) or
# after `rust-version =`, neither of which matches the anchored pattern.
CARGO_VER=$(sed -n 's/^version = "\([^"]*\)".*/\1/p' src-tauri/Cargo.toml | head -n 1)

# kappastream entry in Cargo.lock: the version line immediately following its
# exact `name = "kappastream"` line.
LOCK_VER=$(awk '
    /^name = "kappastream"$/ { found = 1; next }
    found && /^version = "/  { sub(/^version = "/, ""); sub(/"$/, ""); print; exit }
' src-tauri/Cargo.lock)

fail() { echo "check-versions: ERROR: $1" >&2; exit 1; }

[ -n "$PKG_VER" ]  || fail "could not read version from package.json (is node on PATH?)"
[ -n "$CARGO_VER" ] || fail "could not read [package] version from src-tauri/Cargo.toml"
[ -n "$LOCK_VER" ]  || fail "could not read kappastream version from src-tauri/Cargo.lock"

if [ "$CARGO_VER" != "$PKG_VER" ]; then
    fail "src-tauri/Cargo.toml ($CARGO_VER) != package.json ($PKG_VER)"
fi
if [ "$LOCK_VER" != "$PKG_VER" ]; then
    fail "src-tauri/Cargo.lock ($LOCK_VER) != package.json ($PKG_VER)"
fi

# Metainfo latest <release> must equal the current version. The <releases>
# block is newest-first, so the first <release version="..."> is the latest.
# Older history entries are legitimate, so the metainfo is deliberately NOT
# included in the generic scan_file semver scan below.
#
# Skipped for prereleases: the metainfo tracks stable releases only, so a
# prerelease current version is allowed to differ from the latest metainfo
# <release> (which stays at the prior stable).
METAINFO_PATH="packaging/shared/dev.kappy.kappastream.metainfo.xml"
if [ "$IS_PRERELEASE" = "true" ]; then
  echo "check-versions: prerelease ($PKG_VER) — skipping metainfo <release> equality check"
else
  METAINFO_VER=$(grep -oE '<release version="[^"]+"' "$METAINFO_PATH" 2>/dev/null \
      | head -n 1 | sed -E 's/.*version="([^"]+)".*/\1/')
  [ -n "$METAINFO_VER" ] \
      || fail "could not read latest <release> version from $METAINFO_PATH"
  if [ "$METAINFO_VER" != "$PKG_VER" ]; then
      fail "$METAINFO_PATH latest <release> ($METAINFO_VER) != package.json ($PKG_VER)"
  fi
fi

# Hardcoded-semver scan. A semver anywhere in a scanned file must equal the
# current version; anything else (a stale release number) is drift. READMEs
# avoid this entirely by using `<version>` placeholders or dynamic commands.
#
# The regex captures an OPTIONAL SemVer pre-release tail (`-rc1`, `-beta.2`)
# so a prerelease version in a scanned file is matched whole rather than
# truncated to its numeric core (which would then mismatch the prerelease
# PKG_VER). Skipped entirely for prerelease current versions: the AUR -bin
# PKGBUILD (and packaging READMEs) legitimately carry the previous STABLE
# version during a prerelease, which is not drift.
SEMVER_RE='[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?'
failures=$(mktemp)
trap 'rm -f "$failures"' EXIT INT TERM HUP

scan_file() {
    path=$1
    grep -nE "$SEMVER_RE" "$path" 2>/dev/null | while IFS= read -r hit; do
        lineno=${hit%%:*}
        rest=${hit#*:}
        for ver in $(printf '%s\n' "$rest" | grep -oE "$SEMVER_RE"); do
            if [ "$ver" != "$PKG_VER" ]; then
                echo "$path:$lineno: found '$ver', expected '$PKG_VER' (use a <version> placeholder, or \$pkgver)" >> "$failures"
            fi
        done
    done
}

if [ "$IS_PRERELEASE" = "true" ]; then
  echo "check-versions: prerelease ($PKG_VER) — skipping packaging semver-drift scan"
else
  # Tracked README.md files under packaging/ (git ls-files skips the gitignored
  # makepkg artifacts in packaging/aur/{src,dist} that hold nested stale copies).
  git ls-files packaging | grep -E '(^|/)README\.md$' | while IFS= read -r f; do
      scan_file "$f"
  done
  # Plus the one PKGBUILD whose pkgver must track the current version.
  scan_file "packaging/aur/PKGBUILD-bin"

  if [ -s "$failures" ]; then
      echo "check-versions: ERROR: hardcoded version drift detected:" >&2
      sed 's/^/    /' "$failures" >&2
      echo "    (bump the stale files to $PKG_VER, or replace the literal with a <version> placeholder)" >&2
      exit 1
  fi
fi

# AUR updater opt-out guard (packaging integrity, not version drift).
#
# kappastream's default `updater` Cargo feature (src-tauri/Cargo.toml
# [features] default = ["updater"]) registers tauri-plugin-updater +
# tauri-plugin-process in lib.rs. pacman owns updates on Arch, so an AUR
# install must NEVER register them — both kappastream-git PKGBUILDs build with
# --no-default-features so the feature is off. These two files drifted apart in
# the v0.1.3→v0.2.6 window (the top-level template kept the old updater-ON
# cargo line while submit/ was fixed); this assertion makes a silent reversion
# fail CI instead of shipping a pacman-conflicting package. Runs unconditionally
# — the invariant holds for every release, prerelease or not.
for aur_pkgbuild in \
    "packaging/aur/PKGBUILD" \
    "packaging/aur/submit/kappastream-git/PKGBUILD"; do
    # Match the actual cargo command line (indented inside build()), not the
    # explanatory comment, so the flag can't be "present" only in prose.
    if ! grep -qE '^[[:space:]]*cargo build .*--no-default-features' "$aur_pkgbuild"; then
        fail "$aur_pkgbuild: AUR -git build is missing --no-default-features — the updater plugins would be registered on an Arch install (pacman owns updates). See src-tauri/Cargo.toml [features] default = [\"updater\"] and src-tauri/src/lib.rs."
    fi
done

echo "check-versions: OK — package.json, Cargo.toml and Cargo.lock all at $PKG_VER; no stale packaging versions; AUR -git builds are updater-off."
