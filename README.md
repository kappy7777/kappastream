<div align="center">

<img src="public/kappastream-wordmark.svg" alt="kappastream" width="520">

### A lightweight, private Twitch viewer for Linux and Windows

**No account. No ads. No tracking. No recommendations.**  
Just the stream and the chat.

[Download](../../releases/latest) ·
[Changelog](CHANGELOG.md) ·
[Report a bug](../../issues/new?template=bug_report.yml) ·
[Request a feature](../../issues/new?template=feature_request.yml)

[![CI](https://github.com/kappy7777/kappastream/actions/workflows/ci.yml/badge.svg)](https://github.com/kappy7777/kappastream/actions/workflows/ci.yml)
[![Latest release](https://img.shields.io/github/v/release/kappy7777/kappastream?label=release)](../../releases/latest)
[![License](https://img.shields.io/github/license/kappy7777/kappastream)](LICENSE)
![Platform](https://img.shields.io/badge/platform-Linux%20%26%20Windows-1793d1)

</div>

> [!IMPORTANT]
> **kappastream is early-alpha software.** It is already usable, but bugs and rough edges should be expected. Only the latest release is supported.

## About

kappastream is a native desktop client for watching Twitch without signing in or handing an application your Twitch credentials.

It is designed for people who want to open a stream, read the real chat, and get out of the way. There is no login flow, social feed, recommendation engine, account integration, or kappastream backend.

Chat is read anonymously through Twitch IRC. Stream playback is resolved locally with [streamlink](https://streamlink.github.io/) and played through `hls.js`. Favorites, settings, notifications, themes, and cached state remain on your device.

<p align="center">
  <img src="docs/screenshots/1.png" alt="kappastream interface using a purple theme" width="100%">
</p>

<details>
<summary><strong>More theme previews</strong></summary>
<br>
<p align="center">
  <img src="docs/screenshots/2.png" alt="kappastream interface using a dark neutral theme" width="49%">
  <img src="docs/screenshots/3.png" alt="kappastream interface using a light theme" width="49%">
</p>
</details>

## Features

| | |
|---|---|
| **Live playback** | HLS playback with quality selection, fullscreen, theater mode, per-channel quality preferences, and an optional low-latency mode. |
| **VODs and clips** | Browse a channel's past broadcasts, highlights, recent and popular clips, and play them in the main player — with mpv handoff and Picture-in-Picture support. A Back-to-live control returns to the stream. |
| **Anonymous chat** | Read-only Twitch IRC chat with native Twitch emotes, 7TV, BTTV and FFZ emotes, badges, colored usernames, timestamps, and mention highlighting. |
| **Favorites** | Save channels locally, drag to reorder them, and see live status, viewer count, game, and stream title at a glance. |
| **Channel discovery** | Search for live channels and browse top streams and categories, all anonymously via Twitch GQL. Selecting a result joins the channel. |
| **Notifications** | Opt in per channel for go-live notifications and receive desktop alerts for chat mentions. |
| **Picture-in-Picture** | A borderless floating player that maintains a 16:9 aspect ratio and remembers its position. |
| **mpv handoff** | Open the current stream in a standalone `mpv` player through streamlink. |
| **System tray** | Show, hide, or quit from the tray, with optional close-to-tray behavior. |
| **Customization** | 29 themes and interface scaling from 0.5× to 4×. |
| **Import and export** | Back up and restore favorites and settings as local JSON files. |
| **Resilient status checks** | Cached state, retry backoff, and rate-limit protection keep temporary API failures from disrupting playback or chat. |

## Installation

### Arch Linux

Install the prebuilt package from the AUR:

```bash
yay -S kappastream-bin
```

To build the latest development version from source instead:

```bash
yay -S kappastream-git
```

Other AUR helpers can be used in place of `yay`.

### AppImage

1. Install `streamlink` using your distribution's package manager.
2. Download the AppImage and `SHA256SUMS` from the [latest release](../../releases/latest).
3. Make the AppImage executable and launch it:

```bash
chmod +x kappastream*.AppImage
./kappastream*.AppImage
```

> [!NOTE]
> **For the best experience, use a native package whenever your distribution is supported.**
>
> The AppImage is provided as a portable fallback, but it may offer worse startup time, UI responsiveness, video performance, desktop integration, and hardware compatibility than the native AUR, DEB, or RPM packages. This is because it bundles its own WebKitGTK and GStreamer runtime while still interacting with the host system’s graphics drivers and desktop environment.
>
> Arch Linux, Debian/Ubuntu, and Fedora users are therefore strongly encouraged to install the corresponding native package below. Use the AppImage mainly when no suitable native package is available or when you specifically need a portable build.

### Debian and Ubuntu

Download the `.deb` package from the [latest release](../../releases/latest), then install it with:

```bash
sudo apt install ./kappastream_*_amd64.deb
```

The package declares `streamlink` as a dependency.

### Fedora

Twitch streams use H.264 video. Fedora's default `ffmpeg-free` packages do not include the required H.264 decoder, so the **RPM Fusion Free** repository must be enabled first.

Enable RPM Fusion Free once:

```bash
sudo dnf install https://mirrors.rpmfusion.org/free/fedora/rpmfusion-free-release-$(rpm -E %fedora).noarch.rpm
```

Then download the `.rpm` package from the [latest release](../../releases/latest) and install it with:

```bash
sudo dnf install --allowerasing ./kappastream-*.x86_64.rpm
```

The `--allowerasing` option allows DNF to replace Fedora's codec-stripped `ffmpeg-free` libraries with RPM Fusion's `ffmpeg-libs`, which provides H.264 playback. Without the codec, streams may play audio over a black video surface.

The package also declares `streamlink` as a dependency.

If kappastream was installed before the codec dependency was added, repair the existing installation with:

```bash
sudo dnf swap --allowerasing ffmpeg-free ffmpeg
```

### Windows

Download the `*-setup.exe` installer from the [latest release](../../releases/latest) and run it. It installs per-user (no administrator prompt) and provides an NSIS uninstaller.

The [WebView2 runtime](https://developer.microsoft.com/microsoft-edge/webview2/) is required (preinstalled on Windows 11 and recent Windows 10); the installer will prompt you to install it if it is missing.

Install [streamlink](https://streamlink.github.io/install.html#windows-binaries) separately — kappastream needs it to resolve streams:

```bash
pip install --user streamlink
```

If `streamlink` is not on your `PATH`, set it before launching kappastream:

```powershell
$env:STREAMLINK_BIN = "C:\path\to\streamlink.exe"
```

## streamlink

kappastream uses [streamlink](https://streamlink.github.io/) as a local helper to resolve Twitch streams.

The `.deb` and `.rpm` packages install it as a dependency. AppImage and Windows users must install it separately:

```bash
sudo pacman -S streamlink       # Arch Linux
sudo apt install streamlink     # Debian / Ubuntu
sudo dnf install streamlink     # Fedora
pip install --user streamlink   # Python fallback
```

If `streamlink` is installed outside your normal `PATH`, set its location before starting kappastream:

```bash
STREAMLINK_BIN=/opt/bin/streamlink ./kappastream.AppImage
```

kappastream reports a clear error when the binary cannot be found.

## Privacy

kappastream has no server, account system, analytics, telemetry, advertising SDK, cloud sync, or crash-reporting service.

Your favorites, settings, notification preferences, cached status, and other application state are stored locally. Nothing is uploaded to a kappastream service because no such service exists.

### Network access

The application contacts only the services required for playback, chat, metadata, and emotes:

| Component or service | Purpose |
|---|---|
| **Twitch IRC** — `irc-ws.chat.twitch.tv` | Read anonymous chat messages |
| **streamlink** — local process | Resolve the selected Twitch stream |
| **Twitch video infrastructure** — `twitch.tv`, `ttvnw.net`, `*.cloudfront.net` | Deliver live video, and VOD/clip media (CloudFront) |
| **Twitch static CDN** — `static-cdn.jtvnw.net` | Load native emotes and chat badges |
| **Twitch GQL** — `gql.twitch.tv` | Primary source for favorites live status, viewer count, title, game, avatar, and Twitch user-ID lookup |
| **7TV, BTTV and FFZ** | Load third-party emotes |
| **DecAPI** | Fallback for live status when GQL is unreachable (network error / non-2xx / timeout) |

These third-party services can see normal request info like your IP address — never your Twitch account, an OAuth token, or your profile.

**Data sources.** Favorites load through one batched, anonymous Twitch request per refresh. DecAPI is only used if that fails.

**VODs and clips.** Past broadcasts and clips are served from Twitch's CloudFront CDN. Because CloudFront sends no CORS headers, past-broadcast HLS is fetched through a small in-app proxy (the `ksvod` URI scheme) and handed to the player; clips play directly. The proxy contacts only Twitch's own media hosts.

kappastream does not use Twitch Helix or Kraken and cannot authenticate as you.

## Verifying releases

Release packages are built by GitHub Actions from the repository source. The [release workflow](.github/workflows/release.yml) and its [public build logs](../../actions) can be inspected directly.

Each release includes a `SHA256SUMS` file covering every published artifact: the AppImage, Debian package, RPM package, Windows installer, and source tarball.

Download the artifacts into the same directory and verify them with:

```bash
sha256sum -c SHA256SUMS
```

A successful result confirms that the downloaded file matches the checksum published with the release. Checksums detect corruption or replacement after publication; they are not a substitute for reviewing the source and build workflow.


## Known limitations

- **streamlink is required.** Playback cannot be resolved without the local helper binary.
- **Read-only by design.** Sending chat messages, following, subscribing, redeeming channel points, and other authenticated Twitch features are intentionally outside the project's scope.

## Build from source

### Requirements

- Node.js 22 or a compatible current release
- Rust stable
- `streamlink`

#### Linux

- The [Tauri 2 Linux prerequisites](https://v2.tauri.app/start/prerequisites/)
- WebKitGTK 4.1, GTK 3, Soup 3, librsvg, and Ayatana AppIndicator development packages

On Debian or Ubuntu, the build dependencies used by CI are:

```bash
sudo apt update
sudo apt install \
  libwebkit2gtk-4.1-dev \
  libsoup-3.0-dev \
  librsvg2-dev \
  libgtk-3-dev \
  libayatana-appindicator3-dev \
  patchelf
```

#### Windows

- Windows 10 or 11
- [Microsoft Visual Studio C++ Build Tools](https://visualstudio.microsoft.com/visual-cpp-build-tools/)
- [WebView2](https://developer.microsoft.com/microsoft-edge/webview2/)

### Build

```bash
git clone https://github.com/kappy7777/kappastream.git
cd kappastream

npm ci
npm run check
npm run build
npm run tauri -- build --bundles appimage   # Linux (use --bundles nsis on Windows)
```

The bundles are written to:

```text
src-tauri/target/release/bundle/<appimage|nsis>/
```

The first Rust build can take considerably longer than subsequent builds.

## Technology

- **Tauri 2 and Rust** — native shell, window management, subprocess handling, notifications, tray integration, and native packaging
- **Svelte 5 and TypeScript** — user interface and local application state
- **Vite** — frontend compilation
- **hls.js** — HLS playback
- **Twitch IRC over WebSocket** — anonymous, read-only chat
- **streamlink** — local stream resolution
- **System webview** — WebKitGTK on Linux and WebView2 on Windows, avoiding a bundled Chromium runtime

## Repository structure

```text
.
├── src/                    # Svelte application
│   ├── App.svelte          # Top-level application orchestration
│   └── lib/                # UI components, state, IRC and emote logic
├── src-tauri/
│   └── src/                # Rust commands and native integrations
├── packaging/              # AUR, Debian and Fedora packaging
├── docs/screenshots/       # README screenshots
├── .github/workflows/      # CI and release automation
├── CHANGELOG.md
├── CONTRIBUTING.md
└── SECURITY.md
```

## Contributing

Bug reports and focused pull requests are welcome.

Before contributing, read [CONTRIBUTING.md](CONTRIBUTING.md). When reporting a bug, include:

- your operating system and version (Linux distribution or Windows release);
- on Linux, your desktop environment or compositor, and whether you are using X11 or Wayland;
- the kappastream version;
- your `streamlink --version` output;
- clear reproduction steps.

Please report security-sensitive issues privately according to [SECURITY.md](SECURITY.md), rather than opening a public issue.

## License

kappastream is licensed under the [GNU General Public License v3.0 only](LICENSE).

Anyone distributing a modified version must provide the corresponding source under the same license. Private modifications do not need to be published.

## Disclaimer

kappastream is not affiliated with, endorsed by, or connected to Twitch Interactive, Inc.

“Twitch” and related names and marks are the property of their respective owners. This project does not authenticate with Twitch, use Twitch Helix or Kraken, or contain Twitch credentials.
