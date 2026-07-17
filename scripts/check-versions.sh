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

# Hardcoded-semver scan. A semver anywhere in a scanned file must equal the
# current version; anything else (a stale release number) is drift. READMEs
# avoid this entirely by using `<version>` placeholders or dynamic commands.
SEMVER_RE='[0-9]+\.[0-9]+\.[0-9]+'
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

echo "check-versions: OK — package.json, Cargo.toml and Cargo.lock all at $PKG_VER; no stale packaging versions."
