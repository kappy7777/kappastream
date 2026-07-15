# Security Policy

## Reporting a vulnerability

Please **do not** open a public GitHub issue for security-sensitive bugs.

Instead, report them privately via GitHub's _"Report a vulnerability"_
flow on the [Security tab](./security/advisories/new), or email
**kappy777@proton.me**. Include:

- the app version (About modal, or the release page)
- your distro / compositor (X11 or Wayland)
- a description of the issue and, if possible, minimal reproduction steps

You should hear back within a few days. If confirmed, a fix and a
GitHub Security Advisory / new release will follow.

## Scope

kappastream is an **anonymous, read-only** Twitch viewer — there is no
Twitch login, no OAuth, and no credentials are ever stored or sent. All
persistence is local (`localStorage` only).

The desktop build (Tauri) does expose a small set of local IPC commands
to its WebView: stream resolution (shells out to the local `streamlink`
binary), a DecAPI HTTP proxy, window/PiP controls, and OS notifications.
Channel names and stream qualities are validated against strict allowlists
before any subprocess or network call is made.

## Supported versions

Only the latest release is supported. See the
[releases page](./releases/latest).
