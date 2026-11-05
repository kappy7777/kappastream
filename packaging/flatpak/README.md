# Flatpak packaging

Single-file `.flatpak` bundle for kappastream, built by `flatpak-builder`
from `io.github.kappy7777.kappastream.json`. The release workflow's
`build-flatpak` job builds and publishes it alongside the AppImage/deb/rpm
artifacts; everything below is the local equivalent.

## Layout

- `io.github.kappy7777.kappastream.json` — the flatpak-builder manifest
  (GNOME 50 runtime + SDK, `rust-stable` + `node22` SDK extensions).
- `shared-modules/` — vendored copy of the three modules the app needs
  from Flathub's [shared-modules] repo (pinned at commit
  `fb3a4070f1f1b8a14ba8e5bc088ea9665f795550`):
  `intltool`, `dbus-glib`, and `libappindicator` (+ its patches).
  Kept in the upstream directory layout so the relative `../`-includes
  inside them resolve. One deliberate deviation from that commit:
  `dbus-glib` is bumped 0.114 → 0.116 (upstream made the same bump in its
  copy afterwards); refreshing by copying the same paths over from a newer
  pinned commit must re-apply that bump or take upstream's newer
  dbus-glib file wholesale — copying the old pinned file back would
  silently downgrade to 0.114.
- `sources/` — GENERATED offline dependency sources (committed): the
  cargo vendor tree, the npm cache, and the pip wheels for streamlink.
  flatpak-builder disables networking inside build steps, so npm/cargo/pip
  cannot fetch — everything is declared as manifest sources instead
  (flatpak-builder's source-download phase has network). Regenerate with
  `sh scripts/flatpak-gen-sources.sh` whenever `package-lock.json`,
  `src-tauri/Cargo.lock`, or the streamlink pin changes — a stale file is
  not silent: the offline build fails loudly (npm `ENOTCACHED`, cargo
  vendor-vs-lockfile mismatch, pip resolution error).

## Why each bundled piece exists

- **libappindicator (shared-modules)**: the tray (`libappindicator-sys`)
  dlopens `libayatana-appindicator3.so.1` or `libappindicator3.so.1` at
  startup and the process panics when neither loads. No flatpak runtime
  ships one, so the manifest bundles it — the same module most Flathub
  apps with a tray use.
- **Tray icon transport (why the tray can render blank)**: this
  libappindicator predates the `IconPixmap` DBus property — the ONLY
  icon channel is the `IconName` string, which tray-icon fills with an
  absolute path to a PNG it writes under `$XDG_RUNTIME_DIR/tray-icon`.
  Inside the sandbox that directory is a PRIVATE tmpfs over the
  desktop's `/run/user/<uid>` (the PNG is visible through
  `/proc/<pid>/root` but absent on the host), so the desktop gets a
  path it cannot read and shows an empty slot. `tray.rs` therefore
  redirects the PNG to `$XDG_CACHE_HOME/tray-icon` when `FLATPAK_ID` is
  set — that per-app directory exists at the SAME absolute path inside
  and outside the sandbox. Do not remove the `temp_dir_path` call.
- **`rename-icon: kappastream`**: flatpak exports `share/icons` to the
  host ONLY for icons named after the app ID. The icons are installed
  as `kappastream.png` (shared with the AUR/native packaging), so the
  key renames them to `io.github.kappy7777.kappastream.png` and rewrites
  the exported desktop file's `Icon=` (including localized variants) —
  without it the launcher icon silently resolves to nothing host-side
  and flatpak-builder warns `Icon referenced in desktop file but not
  exported` on every build.
- **nv-codec-headers**: NVIDIA's CUVID header set, build-time only — the
  GNOME SDK does not ship it. ffmpeg compiles its nvdec decoders against
  it; at runtime those decoders load the host driver's `libnvcuvid`,
  which flatpak's NVIDIA GL extension injects into the sandbox. Without
  these headers the app's `nvdec` hardware-decode setting would silently
  fall back to software decode. The global cleanup strips the headers
  from `/app`; only the compiled decoders ship.
- **ffmpeg / libplacebo / libass / mpv**: the embedded-libmpv engine. mpv
  ≥0.37 hard-requires libplacebo (built GL-only — the engine drives the
  classic render API, not gpu-next) and libass; ffmpeg is a decoder-only
  build (encoders/muxers/programs/devices off; decoders, demuxers and
  network protocols stay) built WITH gnutls TLS — load-bearing: mpv opens
  the master playlist through its own libcurl https layer, and
  libavformat fetches every HLS segment itself, so a TLS-less ffmpeg
  (or an mpv without libcurl) makes every https load fail with
  `MPV_ERROR_LOADING_FAILED`. The mpv build disables everything the
  engine never uses — lua/javascript (the engines load no scripts),
  uchardet, DVD/DVB/cdda/bluray/archive inputs, the CLI player
  (`-Dcplayer=false`, libmpv only) — but NOT libcurl: that is mpv's
  http/https stream layer, not a removable input. Both hardware-decode
  paths are force-enabled as assertions in the same spirit as the
  protocol one (`--enable-vaapi`, `--enable-nvdec`): if the SDK ever
  drops libva or the ffnvcodec headers stop resolving, configure fails
  the build instead of silently shipping a software-only stack — the
  app's hwdec dropdown offers `vaapi` and `nvdec`, and every other Linux
  artifact's ffmpeg carries both.
- **streamlink**: pip-installed into `/app` (the runtime's python3). The
  app resolves streamlink through `PATH` (or `STREAMLINK_BIN`), and
  `/app/bin` is on `PATH` inside the sandbox — no code changes needed.
- **gst-libav**: WebKitGTK plays media through GStreamer, and the
  runtime's own libavcodec is built WITHOUT `h264`/`hevc` decoders
  (verified in its embedded build-configuration string), so hls.js
  playback would be black video without help. `gst-libav` is built
  in-manifest against the same in-manifest ffmpeg and installs its plugin
  into `/app/lib/gstreamer-1.0`, which the runtime's
  `GST_PLUGIN_SYSTEM_PATH` lists FIRST — no codec extension download, no
  runtime-version coupling. Verify with
  `flatpak run --command=gst-inspect-1.0 io.github.kappy7777.kappastream avdec_h264`.

The app itself builds exactly like the AUR packages
(`packaging/aur/PKGBUILD`): `npm ci && npm run build`, then
`cargo build --release --locked --no-default-features --features
"mpv-embed,tauri/custom-protocol"` — the in-app updater is NOT registered
(flatpak installs update through their repo, never in-app), so the bundle
is not a tauri updater target and ships without a `.sig`. One sandbox-only
difference from the AUR build: `RUSTFLAGS=-L/app/lib`, because
`libmpv2-sys` emits a bare `-lmpv` link flag with no pkg-config lookup, so
the in-manifest libmpv under `/app/lib` is otherwise off the link path
(at runtime `/app/lib` is on `LD_LIBRARY_PATH` automatically).

## Local build

Requires `flatpak-builder` (Fedora: `sudo dnf install flatpak-builder`;
`flatpak` alone is not enough). From this directory:

```sh
flatpak-builder --user --install-deps-from=flathub --ccache --force-clean \
  --repo=repo build io.github.kappy7777.kappastream.json
```

First run downloads the GNOME 50 SDK + extensions (~1.5 GB) and compiles
the C stack (ffmpeg/libplacebo/mpv) plus the Rust app — expect 25-40 min.
Later runs reuse `build/` and the ccache.

## Verify via the actual artifact (the bundle)

The release artifact is a single-file bundle, so test installs from it —
not from the local repo — to exercise the path users take:

```sh
flatpak build-bundle --runtime-repo=https://flathub.org/repo/flathub.flatpakrepo \
  repo /tmp/kappastream-<version>-x86_64.flatpak io.github.kappy7777.kappastream
flatpak install --user /tmp/kappastream-<version>-x86_64.flatpak
flatpak run io.github.kappy7777.kappastream
```

Build the bundle OUTSIDE the checkout (here `/tmp`): the manifest's dir
source copies the repo tree into the build dir and its skip list takes
exact paths only — a `.flatpak` parked inside the tree would ride along
on every rebuild as hundreds of megabytes of dead weight.

`--runtime-repo` stamps the bundle with a working origin so flatpak can
fetch the GNOME runtime the bundle depends on (and future updates of it)
from flathub; without it the origin remote is empty and the install only
works where the runtime is already present. The URL must be the
`.flatpakrepo` FILE — passing the repo directory 403s at install time.

Quick structural checks without launching the GUI:

```sh
flatpak run --command=ls io.github.kappy7777.kappastream /app/bin   # kappastream + streamlink
flatpak info io.github.kappy7777.kappastream                        # permissions
```

[shared-modules]: https://github.com/flathub/shared-modules
