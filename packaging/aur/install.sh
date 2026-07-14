#!/bin/sh
# install.sh — system-wide installer for the kappastream prebuilt tarball.
#
# Copies the binary, the Wayland-workaround wrapper, the desktop entry,
# AppStream metainfo, and icons into /usr so `kappastream` launches
# correctly from a terminal or app menu.
#
#   sudo ./install.sh             install (default)
#   sudo ./install.sh uninstall   remove everything this installed
#
# Why the wrapper matters: /usr/bin/kappastream exports
# WEBKIT_DISABLE_COMPOSITING_MODE=1 before exec'ing the real binary at
# /usr/lib/kappastream/kappastream. Without that variable, WebKitGTK's
# composited-surface path crashes on Wayland with
# "Error 71 (Protocol error) dispatching to Wayland display". Running the
# bare binary directly skips the wrapper and hits that crash — so always
# launch via `kappastream` (the wrapper), never the raw binary.
set -eu

PREFIX=/usr
LIBDIR="$PREFIX/lib/kappastream"
HERE="$(cd "$(dirname "$0")" && pwd)"

need_root() {
	[ "$(id -u)" -eq 0 ] || { echo "error: run as root, e.g.  sudo $0 $*" >&2; exit 1; }
}

install_files() {
	echo "==> Installing kappastream under $PREFIX"
	install -Dm755 "$HERE/kappastream"    "$LIBDIR/kappastream"
	install -Dm755 "$HERE/kappastream.sh" "$PREFIX/bin/kappastream"
	install -Dm644 "$HERE/kappastream.desktop" \
		"$PREFIX/share/applications/kappastream.desktop"
	install -Dm644 "$HERE/dev.kappy.kappastream.metainfo.xml" \
		"$PREFIX/share/metainfo/dev.kappy.kappastream.metainfo.xml"
	# hicolor icon theme (sizes mirror the AUR/Debian/Fedora layout).
	install -Dm644 "$HERE/32x32.png"      "$PREFIX/share/icons/hicolor/32x32/apps/kappastream.png"
	install -Dm644 "$HERE/64x64.png"      "$PREFIX/share/icons/hicolor/64x64/apps/kappastream.png"
	install -Dm644 "$HERE/128x128.png"    "$PREFIX/share/icons/hicolor/128x128/apps/kappastream.png"
	install -Dm644 "$HERE/128x128@2x.png" "$PREFIX/share/icons/hicolor/256x256/apps/kappastream.png"
	install -Dm644 "$HERE/icon.png"       "$PREFIX/share/icons/hicolor/512x512/apps/kappastream.png"
	# Best-effort cache refresh (these tools may be absent — never fatal).
	update-desktop-database -q "$PREFIX/share/applications" 2>/dev/null || true
	gtk-update-icon-cache -q "$PREFIX/share/icons/hicolor" 2>/dev/null || true
	echo "==> Done. Launch from your app menu, or run:  kappastream"
}

uninstall_files() {
	echo "==> Removing kappastream from $PREFIX"
	rm -f "$PREFIX/bin/kappastream" \
		"$LIBDIR/kappastream" \
		"$PREFIX/share/applications/kappastream.desktop" \
		"$PREFIX/share/metainfo/dev.kappy.kappastream.metainfo.xml"
	rm -f "$PREFIX/share/icons/hicolor"/{32x32,64x64,128x128,256x256,512x512}/apps/kappastream.png
	rmdir "$LIBDIR" 2>/dev/null || true
	update-desktop-database -q "$PREFIX/share/applications" 2>/dev/null || true
	gtk-update-icon-cache -q "$PREFIX/share/icons/hicolor" 2>/dev/null || true
	echo "==> Removed."
}

case "${1:-install}" in
	install)   need_root install;   install_files ;;
	uninstall) need_root uninstall; uninstall_files ;;
	*)
		echo "usage: sudo $0 [install|uninstall]" >&2
		exit 2
		;;
esac
