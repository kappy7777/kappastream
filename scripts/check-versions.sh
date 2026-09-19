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
# Also cross-checks the Linux runtime deps shared by more than one packaging
# file (streamlink, libmpv, the deb gst-libav dep, hicolor-icon-theme), so the
# tauri-bundler-generated deb/rpm metadata and the hand-maintained
# control.in / spec / AUR definitions cannot drift apart. tauri.conf.json is
# read with `node -p` (node is already required for package.json above and is
# installed by CI before this script runs; jq is NOT a dependency here).
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

# AUR template/snapshot pair identity (packaging drift, not version drift).
# packaging/aur/PKGBUILD + PKGBUILD-bin are the editable templates;
# submit/kappastream-{git,bin}/PKGBUILD are the published AUR snapshots. A
# pair must stay byte-identical — any difference means an edit landed on one
# side only, which is exactly how the -git pair once drifted to a stale
# pkgver with no mpv-embed while the published snapshot moved on. Re-publishing
# a snapshot (e.g. a bumped pkgver) must copy the file back over the template
# in the same commit.
for aur_pair in \
    "packaging/aur/PKGBUILD packaging/aur/submit/kappastream-git/PKGBUILD" \
    "packaging/aur/PKGBUILD-bin packaging/aur/submit/kappastream-bin/PKGBUILD"; do
    aur_template=${aur_pair%% *}
    aur_snapshot=${aur_pair##* }
    if ! cmp -s "$aur_template" "$aur_snapshot"; then
        fail "$aur_template and $aur_snapshot differ — keep each AUR template/snapshot pair byte-identical (copy one over the other in the same commit that changes either)"
    fi
done

# Linux runtime-dependency drift check (packaging integrity, like the AUR
# checks above — runs unconditionally, the invariants hold for every release).
#
# The binary's runtime deps are declared in six places that must agree:
# tauri.conf.json's bundle.linux.{deb,rpm}.depends (what the tauri-bundler
# deb/rpm carry) and the hand-maintained packaging/ definitions —
# debian/control.in's Depends: (the Docker-built deb), fedora/kappastream.spec.in's
# Requires: (the rpmbuild rpm), and the two AUR PKGBUILD depends=() arrays.
# Distro package names differ (libmpv2 vs libmpv.so.2()(64bit) vs mpv), so the
# matrix below lists the exact token each file must declare. A miss is drift:
# the gst-libav deb dep once landed in tauri.conf.json without control.in
# following, shipping a Docker-built deb without the WebKitGTK media pipeline's
# H.264 decoder.
#
# Deliberately NOT in the matrix:
#   - the codec-provider declarations (tauri.conf.json's rpm `recommends`
#     boolean, the spec's ffmpeg-libs, the AUR gst-plugins-* set) — which
#     package set provides H.264 is a per-distro decision tracked separately;
#   - the linked webkit/gtk/glib/soup libs — control.in and the PKGBUILDs
#     declare them by hand, the spec relies on rpmbuild's soname
#     auto-detection (see its header comment), and tauri-bundler resolves its
#     own from the binary, so their presence legitimately differs per build
#     pipeline.
tauri_deb_deps() {
    node -p '(require("./src-tauri/tauri.conf.json").bundle.linux.deb.depends || []).join("\n")'
}
tauri_rpm_deps() {
    node -p '(require("./src-tauri/tauri.conf.json").bundle.linux.rpm.depends || []).join("\n")'
}
control_depends() {
    sed -n 's/^Depends:[[:space:]]*//p' packaging/debian/control.in \
        | tr ',' '\n' | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//'
}
spec_requires() {
    # BuildRequires: never matches — the anchor requires the line to start
    # (after indentation) with literal `Requires:`.
    sed -n 's/^[[:space:]]*Requires:[[:space:]]*//p' packaging/fedora/kappastream.spec.in \
        | tr ',' '\n' | sed -e 's/[[:space:]]//g' -e '/^$/d'
}
aur_depends() {
    # $1 = PKGBUILD path. Prints each single-quoted depends=() entry, one per
    # line. grep -oE is line-scoped, so an apostrophe inside an array comment
    # cannot pair across lines.
    sed -n '/^depends=(/,/^[[:space:]]*)/p' "$1" | grep -oE "'[^']+'" | tr -d "'"
}
dep_list_for() {
    case $1 in
      tauri-deb) tauri_deb_deps ;;
      tauri-rpm) tauri_rpm_deps ;;
      control)   control_depends ;;
      spec)      spec_requires ;;
      aur-git)   aur_depends packaging/aur/PKGBUILD ;;
      aur-bin)   aur_depends packaging/aur/PKGBUILD-bin ;;
      *)         fail "dependency matrix references unknown slot '$1'" ;;
    esac
}
dep_file_for() {
    case $1 in
      tauri-deb) echo "src-tauri/tauri.conf.json (bundle.linux.deb.depends)" ;;
      tauri-rpm) echo "src-tauri/tauri.conf.json (bundle.linux.rpm.depends)" ;;
      control)   echo "packaging/debian/control.in (Depends:)" ;;
      spec)      echo "packaging/fedora/kappastream.spec.in (Requires:)" ;;
      aur-git)   echo "packaging/aur/PKGBUILD (depends)" ;;
      aur-bin)   echo "packaging/aur/PKGBUILD-bin (depends)" ;;
      *)         fail "dependency matrix references unknown slot '$1'" ;;
    esac
}

# One line per expected occurrence: <dep>|<slot>|<exact package token>.
cat <<'EOF' | while IFS='|' read -r dep slot pkg; do
streamlink|tauri-deb|streamlink
streamlink|tauri-rpm|streamlink
streamlink|control|streamlink
streamlink|spec|streamlink
streamlink|aur-git|streamlink
streamlink|aur-bin|streamlink
libmpv|tauri-deb|libmpv2
libmpv|control|libmpv2
libmpv|tauri-rpm|libmpv.so.2()(64bit)
libmpv|spec|libmpv.so.2()(64bit)
libmpv|aur-git|mpv
libmpv|aur-bin|mpv
gst-libav|tauri-deb|gstreamer1.0-libav
gst-libav|control|gstreamer1.0-libav
hicolor-icon-theme|control|hicolor-icon-theme
hicolor-icon-theme|spec|hicolor-icon-theme
hicolor-icon-theme|aur-git|hicolor-icon-theme
hicolor-icon-theme|aur-bin|hicolor-icon-theme
EOF
    if ! dep_list_for "$slot" | grep -Fxq -- "$pkg"; then
        echo "$(dep_file_for "$slot"): missing '$pkg' (runtime dep '$dep')" >> "$failures"
    fi
done

if [ -s "$failures" ]; then
    echo "check-versions: ERROR: Linux runtime-dependency drift detected:" >&2
    sed 's/^/    /' "$failures" >&2
    echo "    (every file in the matrix must declare its distro's name for the dep)" >&2
    exit 1
fi

echo "check-versions: OK — package.json, Cargo.toml and Cargo.lock all at $PKG_VER; no stale packaging versions; AUR -git builds are updater-off; AUR template/snapshot pairs identical; Linux runtime deps present in every packaging file."
