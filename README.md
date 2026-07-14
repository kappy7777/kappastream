# kappastream

**Twitch, without Twitch.**

A native Linux Twitch client that doesn't want your account, doesn't want your data, and doesn't want your attention any longer than you choose to give it.

No login. No ads. No tracking. No algorithm. Just the stream and the chat.

---

## The pitch

Some people want to chat, subscribe, follow, and be part of the community.

Some people want to put a stream on a second monitor and be left completely alone.

kappastream is for the second kind. If you've used FreeTube, you already know the shape of this: watch the thing, skip the platform. This is that, for Twitch — a native Linux client with live streams, real chat, 7TV/BTTV/FFZ emotes, favorites with live status, and picture-in-picture, requiring exactly zero interaction with a Twitch account.

You connect to chat anonymously — not as a lurker with a username, not as a user with a profile. Just as somebody who happens to be watching.

No login. No ads. No tracking. No algorithm. No backend. The app doesn't know who you are.

---

## Screenshots

<table>
  <tr>
    <td align="center"><img src="Screenshots/1.png" alt="kappastream"></td>
    <td align="center"><img src="Screenshots/2.png" alt="kappastream"></td>
    <td align="center"><img src="Screenshots/3.png" alt="kappastream"></td>
  </tr>
</table>

---

## What you *don't* get

The absences are the product.

| | |
|---|---|
| 🚫 **No account** | No login, no OAuth, no client_id, no Twitch API keys. There is no sign-up flow because there is nothing to sign up for. |
| 🚫 **No ads** | No pre-roll. No mid-roll. No purple screen. Ever. |
| 🚫 **No tracking** | No analytics, no telemetry, no crash reporting, no fingerprinting, no "anonymous usage statistics." Nothing phones home, because there's no home to phone. |
| 🚫 **No algorithm** | Nothing is recommended to you. Nothing is promoted at you. You see the channels you added. That's the whole feed. |
| 🚫 **No watch history** | Nobody is building a profile of what you watch, because nobody is watching you watch. |
| 🚫 **No backend** | There is no kappastream server. There is no kappastream database. There is no kappastream company. Your data physically cannot be collected — there's nowhere to put it. |

Chat connects **anonymously** — Twitch's own IRC gateway lets you read a channel without identifying yourself at all. You're not a lurker with a username. You're not a user. You're just... there.

---

## What you *do* get

**🎥 The stream** — live HLS playback, quality selection, theater mode, fullscreen. No embed, no player skin, no overlay begging you to follow.

**💬 Real chat** — full IRC chat with Twitch, 7TV, BTTV and FFZ emotes, badges, colored names, timestamps, mention highlighting. The chat experience the web client wishes it had.

**⭐ Favorites that make sense** — a proper sidebar with live status, viewer counts, current game and title. Drag to reorder. Export and import as JSON. It's *your* list, on *your* disk.

**🔔 Notifications you asked for** — opt in per channel with a single click. Get pinged when someone you actually care about goes live, or when your name shows up in chat. Nothing else will ever notify you.

**🖼️ Picture-in-Picture** — pop the stream into a floating, always-on-top window and go do something else. Snaps to 16:9, remembers where you left it. Play a game, watch a stream. That's the whole point.

**🎨 29 themes** — warm palettes, dark palettes, Dracula, Nord, Midnight, Forest, and yes, a Twitch-purple one if you're feeling nostalgic. Plus a UI scale slider from 0.5× to 4×, because your monitor is your business.

**🛡️ It doesn't fall over** — failed status checks keep showing the last known state and retry with backoff. Rate-limited? A circuit breaker backs off gracefully instead of hammering. It degrades politely instead of breaking loudly.

---

## Radical transparency

Most apps say "we respect your privacy" and then hand you a 4,000-word policy.

Here is the complete, exhaustive list of every network request kappastream makes:

| Service | What it's for |
|---|---|
| **Twitch IRC** (`irc-ws.chat.twitch.tv`) | Reading chat. Anonymously. |
| **streamlink** (local binary) | Resolving the stream URL |
| **Twitch video CDN** (`ttvnw.net`, `twitch.tv`) | The actual video |
| **Twitch CDN** (`static-cdn.jtvnw.net`) | Chat badges and native emotes |
| **7TV / BTTV / FFZ** | Third-party emotes |
| **DecAPI** | Live status, viewer count, title, game |

That's it. That's the list.

These services see what any web request shows them — an IP address and a request. **kappastream sends them nothing about you, because it doesn't know anything about you.** Your favorites, settings, notification preferences and cached state live in local storage on your machine and go nowhere unless you export them yourself.

No Helix. No Kraken. No OAuth token sitting in a config file waiting to leak. The app is architecturally incapable of authenticating with Twitch, and that's on purpose.

---

## Install

**AppImage** — grab it from [Releases](../../releases), `chmod +x`, run it.

**Arch / AUR** — `yay -S kappastream-bin` (or `kappastream-git` to build from source)

**Debian / Ubuntu** — `.deb` available in [Releases](../../releases)

**Fedora** — `.rpm` available in [Releases](../../releases)

### One dependency

kappastream resolves streams by shelling out to **[streamlink](https://streamlink.github.io/)** — the battle-tested, actively maintained tool that already solved this problem. No point reinventing it.

```bash
sudo pacman -S streamlink     # Arch
sudo apt install streamlink   # Debian / Ubuntu
sudo dnf install streamlink   # Fedora
pip install streamlink        # anywhere
```

If it's not on your `PATH`, point at it explicitly:

```bash
STREAMLINK_BIN=/opt/bin/streamlink ./kappastream.AppImage
```

If streamlink is missing, the app tells you clearly instead of failing silently. (Yes, that's a feature. Yes, it took a while.)

---

## Build from source

```bash
npm install
npm run check                       # svelte-check + tsc
npm run build                       # produces dist/
npx tauri build --bundles appimage  # first run: 15–30 min Rust compile
```

Output lands in `src-tauri/target/release/bundle/appimage/`.

There is no `npm run dev` — kappastream is Tauri-only. The frontend is compiled once and embedded directly into the binary. It is not, and never was, a website.

---

## Stack

- **Svelte 5** (runes) + TypeScript — the UI
- **Vite 8** — builds `dist/`, embedded into the binary at compile time
- **hls.js** — stream playback
- **Raw IRC over WebSocket** — chat, with a hand-rolled parser
- **Tauri 2** (Rust) — the native shell, subprocess handling, and packaging

Roughly 30 MB of app instead of 300 MB of bundled Chromium. You're welcome.

---

## Project layout

```
src/
  App.svelte              # Layout, IRC socket, HLS, persistence, stream resolution
  app.css                 # Theme tokens (CSS custom properties)
  lib/
    Sidebar.svelte        # Favorites, drag-reorder, import/export
    PlayerControls.svelte # PiP, theater, fullscreen, quality
    Settings.svelte       # Themes, UI scale, mentions, backup
    favorites.svelte.ts   # DecAPI polling + retry backoff + status cache
    irc.ts                # IRC parser
    emotes.ts             # Twitch + 7TV + BTTV + FFZ loaders
src-tauri/
  src/
    resolve.rs            # resolve_stream  — runs streamlink
    decapi.rs             # decapi_fetch    — status lookups
    opener.rs             # open_url_robust — external links (twitch.tv only)
    export.rs             # save_favorites_export — native Save As
packaging/                # AUR, Debian, Fedora
```

---

## Known limitations

**Picture-in-Picture "always on top" needs a one-time setup on Wayland.** WebKitGTK doesn't implement the HTML5 PiP API, so kappastream builds its own borderless floating window instead. Tauri requests always-on-top via GTK's keep-above hint — which works fine on X11, but is a no-op on Wayland, since xdg-shell has no concept of always-on-top.

<details>
<summary><b>Hyprland</b></summary>

```conf
windowrulev2 = float, title:^(kappastream — PiP)$
windowrulev2 = pin,   title:^(kappastream — PiP)$
```
</details>

<details>
<summary><b>KDE / KWin</b></summary>

Focus the PiP window → `Alt+F3` → More Actions → Keep Above.

To make it permanent: System Settings → Window Management → Window Rules → match window title containing `PiP` → Keep Above: Force → Yes.
</details>

**streamlink must be installed on the host.** See above.

**Linux only.** X11 and Wayland. No macOS or Windows builds — for now.

---

## License

**GPL-3.0-only.**

Copyleft on purpose. If someone forks kappastream and bolts ads or telemetry onto it, they're legally obligated to publish that too — where you can see it, and refuse it.

Free software, in the sense that actually matters.

See [LICENSE](LICENSE) for the full text. Distributed in the hope that it will be useful, but **without any warranty**.

---

<sub>Not affiliated with, endorsed by, or connected to Twitch Interactive, Inc. "Twitch" and related marks are trademarks of their respective owners. This project does not authenticate with Twitch, does not use Twitch's Helix or Kraken APIs, and holds no Twitch credentials of any kind.</sub>
