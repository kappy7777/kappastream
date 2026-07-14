# Fedora packaging for kappastream

Builds a **native** `.rpm` from source (not the AppImage): the frontend is built
with Vite, then `cargo build --release` embeds `dist/` into the Rust binary via
tauri-build, packaged with `rpmbuild` from `kappastream.spec.in`.

This is a standalone release artifact — there is **no** COPR repo. Users
install it with `rpm -i` or `dnf install ./kappastream-*.rpm`.

## Targets

Fedora ships current-enough `rust` and `nodejs` in its own repos (no rustup /
nodesource needed, unlike the Ubuntu LTS `.deb` build). The glibc-floor
principle applies: build on the **oldest** Fedora you want to support and the
binary runs on that release and all newer ones. The `Dockerfile` pins
`fedora:44`; lower it only if you must support older Fedoras.

## Contents

| File | Purpose |
| --- | --- |
| `kappastream.spec.in` | RPM spec template (`@VERSION@` substituted by `build.sh`). Build logic mirrors the AUR `PKGBUILD`. |
| `build.sh` | Tars the source, generates the spec, runs `rpmbuild -bb`, collects the `.rpm`. |
| `Dockerfile` | Fedora build host (dnf-installed toolchain + rpmbuild/rpmlint). |
| `.gitignore` | Excludes `dist/`. |
| `README.md` | This file. |

Shared assets (desktop entry, metainfo, Wayland-workaround wrapper) live in
`packaging/shared/` and ship inside the source tarball.

## Runtime dependencies

`rpmbuild` auto-detects the linked library deps as **soname** `Requires`
(`libwebkit2gtk-4.1.so.0`, `libgtk-3.so.0`, `libglib-2.0.so.0`,
`libsoup-3.0.so.0`, …) from the binary's `NEEDED` entries. These resolve to
whatever package owns each soname on the target Fedora, so they survive
Fedora's `webkit2gtk3` → `webkit2gtk4.1` package rename (F43+). Only the
non-linked runtime deps (`streamlink`, `hicolor-icon-theme`) are declared by
hand — do **not** hand-declare `webkit2gtk3`/`webkit2gtk4.1` by name, or the
`.rpm` breaks across the rename.

The spec also hard-`Requires: ffmpeg-libs` — see "H.264 video" below.

## H.264 video (why streams would otherwise be black)

Twitch streams are H.264, and **Fedora ships no H.264 decoder by default**
(patent reasons): it provides `ffmpeg-free`, a build with the patented codecs
stripped out. Without a decoder, kappastream plays the stream's *audio* but
the *video* surface stays black (WebKitGTK → GStreamer → libav has no
`avdec_h264`). Ubuntu ships working H.264, which is why the `.deb` "just
works" there.

The spec declares `Requires: ffmpeg-libs` so that installing the `.rpm`
auto-pulls RPM Fusion's **full** ffmpeg libraries (which carry the H.264
decoder). This needs the **rpmfusion-free** repo enabled, and — because
Fedora's `ffmpeg-free` split (`libav*-free`, `libswscale-free`) **Conflicts**
with `ffmpeg-libs` — the install must allow erasing those `-free` packages
(`--allowerasing`). Two failure modes otherwise:

- rpmfusion-free **not** enabled → *"nothing provides ffmpeg-libs"*.
- enabled but no `--allowerasing` → *"conflicting requests"* (libswscale-free
  vs ffmpeg-libs).

```bash
# one-time: enable RPM Fusion free (ffmpeg lives here)
sudo dnf install https://mirrors.rpmfusion.org/free/fedora/rpmfusion-free-release-$(rpm -E %fedora).noarch.rpm
# --allowerasing lets dnf swap the libav*-free / libswscale-free split for ffmpeg-libs
sudo dnf install --allowerasing ./kappastream-*.rpm
```

If you installed kappastream before enabling the codec requirement, fix an
existing system manually:

```bash
sudo dnf swap --allowerasing ffmpeg-free ffmpeg
gst-inspect-1.0 avdec_h264 | head -1     # confirms the decoder registered
```

(`gst-inspect` may print "no such element" immediately after the swap —
GStreamer caches its plugin registry; it refreshes on the next app launch.)

### VM note (GNOME Boxes / no GPU)

In a VM without 3D acceleration, Mesa may route GL through Zink and emit
`MESA: error: ZINK: failed to choose pdev` / `egl: failed to create dri2
screen`. These are usually non-fatal (video still renders once codecs are
present). If video is black *despite* `avdec_h264` being available, force
software GL for that session:

```bash
LIBGL_ALWAYS_SOFTWARE=1 kappastream
```

This is a VM/graphics-stack issue, not a packaging one — it's intentionally
**not** baked into the launcher (it would cripple rendering speed on real
hardware).

## Why a `.spec` and not raw assembly

There's no sane way to hand-assemble RPM metadata (unlike the `.deb`, whose
`ar`+`cpio` layout is tractable for `dpkg-deb`). A real `.spec` + `rpmbuild` is
the only robust path, and it carries the build logic the same way the AUR
`PKGBUILD` does.

## Local build & test

The build runs in the Docker container (it needs `webkit2gtk4.1-devel` and
`rpm-build`, which this repo's dev container does not provide):

```bash
# from the repo root:
docker build -t kappastream-rpm packaging/fedora
docker run --rm -v "$PWD":/src kappastream-rpm
# → packaging/fedora/dist/kappastream-<version>-1.fc41.x86_64.rpm
```

Then inspect and validate:

```bash
cd packaging/fedora
rpm -qip dist/kappastream-*.rpm    # metadata
rpm -qlp dist/kappastream-*.rpm    # file list
rpmlint   dist/kappastream-*.rpm   # policy checks
```

Install on a real Fedora box and smoke-test (video, chat, emotes,
notifications, external links, fullscreen, favorites persistence).

## Release

Ship `kappastream-<version>-1.fc<NN>.x86_64.rpm` as a GitHub release asset
alongside the AppImage and `.deb`, with a SHA-256 in `SHA256SUMS`. GPG signing
(`rpm --addsign`) is optional and can be added later without restructuring.

## TODO before first release

1. Bump the `Dockerfile` `FROM` tag to the oldest still-supported Fedora at
   release time (glibc-floor coverage).
