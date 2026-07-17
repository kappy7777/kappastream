#!/bin/sh
# Wrapper for kappastream — thin launcher.
#
# NVIDIA EGL-Wayland explicit-sync compatibility is now handled inside the Rust
# binary at the very start of main(), before GTK/WebKitGTK/EGL initialize: on a
# Wayland session with the NVIDIA kernel driver loaded it sets
# __NV_DISABLE_EXPLICIT_SYNC=1 (unless the user already set it), which avoids
# the "Error 71 (Protocol error) dispatching to Wayland display" crash while
# retaining WebKitGTK's accelerated compositing path. AMD, Intel and X11
# sessions are unaffected. Doing this in the binary rather than here means every
# release format — AppImage, .deb, .rpm, AUR — gets identical behavior (the
# AppImage does not use this wrapper at all; it runs the binary directly).
#
# This wrapper therefore no longer exports WEBKIT_DISABLE_COMPOSITING_MODE=1 by
# default. If you still hit a Wayland protocol error on an unusual setup, you
# can re-enable the old broad fallback manually:
#   WEBKIT_DISABLE_COMPOSITING_MODE=1 kappastream
# and you can force native explicit sync back on to test an upstream fix:
#   __NV_DISABLE_EXPLICIT_SYNC=0 kappastream
#
# Installed to /usr/bin/kappastream by the distro packaging (packaging/aur,
# packaging/debian, packaging/fedora); the real binary lives at
# /usr/lib/kappastream/kappastream.
exec /usr/lib/kappastream/kappastream "$@"
