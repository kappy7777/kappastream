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
# Needs: python3 (>=3.11, with venv/ensurepip), network, node on PATH.
# The single-file generators are fetched at the pinned commit below
# (flatpak/flatpak-builder-tools) and verified against a sha256; the pip
# packages run from a throwaway venv at pinned versions — the versions
# that produced the committed sources — so regeneration never depends on
# whatever happens to be installed on the host.
set -eu

repo="$(cd "$(dirname "$0")/.." && pwd)"
cd "$repo"

FBT_COMMIT=9d86d336a39b9af38b86f114b6ce5820fe260f91
FBT_BASE="https://raw.githubusercontent.com/flatpak/flatpak-builder-tools/${FBT_COMMIT}"
# sha256 of the two generator scripts at that commit; the fetch below
# fails the run when the pinned commit serves different bytes.
CARGO_GEN_SHA256=0a2db6be87d75910facef28ab46d4d6460802e8419ab850d0caa6a364d26b380
PIP_GEN_SHA256=b69db8f3b506ec471274a75aaf3f40989afd8670df132467b1d44d38700dd62f
OUT="$repo/packaging/flatpak/sources"
MANIFEST="$repo/packaging/flatpak/io.github.kappy7777.kappastream.json"
# The pip wheels must resolve against the runtime the manifest pins (they
# carry the runtime's python ABI), so read runtime-version from the
# manifest instead of hard-coding it here — the two must never drift.
# (The path is passed through the environment: splicing it into the
# python source would break on quotes in the checkout path.)
RUNTIME_VERSION="$(MANIFEST="$MANIFEST" python3 -c 'import json, os; print(json.load(open(os.environ["MANIFEST"]))["runtime-version"])')"
RUNTIME="org.gnome.Sdk//${RUNTIME_VERSION}"
# The streamlink pin lives in the generated module itself (the manifest
# only includes the file), so read it back from the committed copy.
STREAMLINK_VERSION="$(python3 -c 'import json,re; m=re.search(r"streamlink==([0-9.]+)", open("packaging/flatpak/sources/streamlink-sources.json").read()); assert m; print(m.group(1))')"

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

curl -fsSL "${FBT_BASE}/cargo/flatpak-cargo-generator.py" -o "$work/cargo.py"
curl -fsSL "${FBT_BASE}/pip/flatpak-pip-generator.py" -o "$work/pip.py"
printf '%s  %s\n' "$CARGO_GEN_SHA256" "$work/cargo.py" >"$work/generators.sha256"
printf '%s  %s\n' "$PIP_GEN_SHA256" "$work/pip.py" >>"$work/generators.sha256"
sha256sum -c "$work/generators.sha256"

# tomlkit is the cargo generator's one dependency; requirements-parser
# the pip generator's. Pinned to the versions that produced the committed
# sources, in a throwaway venv (also sidesteps PEP 668 --user installs).
venv="$work/venv"
python3 -m venv "$venv"
"$venv/bin/pip" install --quiet tomlkit==0.15.2 requirements-parser==0.13.1 flatpak-node-generator==0.1.1

# --runtime resolves wheels against the SDK's python (the wheels must match
# the runtime, not the generator host's interpreter).
"$venv/bin/python" "$work/cargo.py" src-tauri/Cargo.lock -o "$OUT/cargo-sources.json"

# The node generator MUST run where no node_modules/ exists: it treats any
# lockfile package that is physically present next to the lockfile as a
# local/workspace source and emits nothing for it, so a populated repo
# checkout yields a cache missing most packages. Copy the manifests to a
# clean dir and generate from there.
nodegen_dir="$work/nodegen"
mkdir -p "$nodegen_dir"
cp package.json package-lock.json "$nodegen_dir/"
(cd "$nodegen_dir" && "$venv/bin/flatpak-node-generator" npm package-lock.json -o "$OUT/node-sources.json")
"$venv/bin/python" "$work/pip.py" --runtime "$RUNTIME" "streamlink==${STREAMLINK_VERSION}" -o "$OUT/streamlink-sources.json"

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
