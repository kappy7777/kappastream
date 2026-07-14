#!/bin/sh
# Wrapper for kappastream.
#
# WebKitGTK's composited-surface path triggers "Error 71 (Protocol error)
# dispatching to Wayland display" on most Wayland compositors (sway,
# hyprland, older KDE/gnome-shell, etc.). WEBKIT_DISABLE_COMPOSITING_MODE=1
# disables that path, so the WebView uses a simple toplevel surface instead.
# It's a harmless no-op on X11, so we export it unconditionally.
#
# Installed to /usr/bin/kappastream by the distro packaging (packaging/aur,
# packaging/debian, packaging/fedora); the real binary lives at
# /usr/lib/kappastream/kappastream.
export WEBKIT_DISABLE_COMPOSITING_MODE=1
exec /usr/lib/kappastream/kappastream "$@"