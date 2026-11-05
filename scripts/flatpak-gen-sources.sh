#!/bin/sh
# Regenerate packaging/flatpak/sources/*.json from the lockfiles.
#
# flatpak-builder runs every build command with networking disabled, so the
# flatpak manifest consumes offline dep sources instead of fetching: the
# cargo vendor tree + npm cache + pip wheels are declared as SOURCES
# (downloaded by flatpak-builder's own network-enabled source phase).
# Those generated files are COMMITTED, so they must be regenerated whenever
# package-lock.json, src-tauri/Cargo.lock, or the streamlink pin in the
# manifest changes. A stale file is not silent: the offline build fails
# loudly (npm ENOTCACHED, cargo vendor-vs-lockfile mismatch, pip
# resolution error).
#
# Needs: python3 (>=3.11), network, node on PATH. The single-file
# generators are fetched at the pinned commit below
# (flatpak/flatpak-builder-tools); flatpak-node-generator is a python
# package and is pip-installed if missing. On PEP 668 systems (stock
# Fedora, Debian 12+) those pip3 --user bootstraps need
# --break-system-packages appended.
set -eu

repo="$(cd "$(dirname "$0")/.." && pwd)"
cd "$repo"

FBT_COMMIT=9d86d336a39b9af38b86f114b6ce5820fe260f91
FBT_BASE="https://raw.githubusercontent.com/flatpak/flatpak-builder-tools/${FBT_COMMIT}"
OUT="$repo/packaging/flatpak/sources"
RUNTIME="org.gnome.Sdk//50"
# The streamlink pin lives in the generated module itself (the manifest
# only includes the file), so read it back from the committed copy.
STREAMLINK_VERSION="$(python3 -c 'import json,re; m=re.search(r"streamlink==([0-9.]+)", open("packaging/flatpak/sources/streamlink-sources.json").read()); assert m; print(m.group(1))')"

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

curl -fsSL "${FBT_BASE}/cargo/flatpak-cargo-generator.py" -o "$work/cargo.py"
curl -fsSL "${FBT_BASE}/pip/flatpak-pip-generator.py" -o "$work/pip.py"

# tomlkit is the cargo generator's one dependency; requirements-parser the
# pip generator's (plus whatever flatpak-node-generator installs).
python3 -c 'import tomlkit' 2>/dev/null || pip3 install --user tomlkit
python3 -c 'import requirements_parser' 2>/dev/null || pip3 install --user requirements-parser
command -v flatpak-node-generator >/dev/null || pip3 install --user flatpak-node-generator

# --runtime resolves wheels against the SDK's python (the wheels must match
# the runtime, not the generator host's interpreter).
python3 "$work/cargo.py" src-tauri/Cargo.lock -o "$OUT/cargo-sources.json"

# The node generator MUST run where no node_modules/ exists: it treats any
# lockfile package that is physically present next to the lockfile as a
# local/workspace source and emits nothing for it, so a populated repo
# checkout yields a cache missing most packages. Copy the manifests to a
# clean dir and generate from there.
nodegen_dir="$work/nodegen"
mkdir -p "$nodegen_dir"
cp package.json package-lock.json "$nodegen_dir/"
(cd "$nodegen_dir" && flatpak-node-generator npm package-lock.json -o "$OUT/node-sources.json")
python3 "$work/pip.py" --runtime "$RUNTIME" "streamlink==${STREAMLINK_VERSION}" -o "$OUT/streamlink-sources.json"

# The generated pip command must --ignore-installed: the SDK's python ships
# some of streamlink's dependencies (e.g. lxml) in /usr site-packages, so
# pip would consider them satisfied and skip installing them into /app —
# but the app runs against the PLATFORM, whose python does not have them.
# The pip generator's own --ignore-installed flag is per-package (it takes
# package NAMES), not global, so the command string is rewritten here —
# and the rewrite asserts it actually applied: a silent no-op would only
# surface as streamlink breaking inside the installed bundle, not at
# build time.
python3 - "$OUT/streamlink-sources.json" <<'PYEOF'
import json, sys
path = sys.argv[1]
with open(path) as f:
    module = json.load(f)
cmds = module["build-commands"]
before = cmds[0]
cmds[0] = cmds[0].replace(
    "pip3 install --verbose",
    "pip3 install --ignore-installed --verbose",
)
assert cmds[0] != before, (
    "pip command shape changed upstream; update the --ignore-installed rewrite"
)
with open(path, "w") as f:
    json.dump(module, f, indent=4)
    f.write("\n")
PYEOF

echo "Regenerated: $OUT/{cargo,node,streamlink}-sources.json (streamlink ${STREAMLINK_VERSION})"
