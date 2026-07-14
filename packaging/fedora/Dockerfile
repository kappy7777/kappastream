# Build a kappastream .rpm for Fedora.
#
# Fedora ships current-enough rust + nodejs in its own repos (unlike Ubuntu
# LTS), so no rustup / nodesource is needed — the distro toolchain satisfies
# the Tauri 2 MSRV (>=1.77.2) and Vite 8 (Node >=20.19).
#
# glibc floor: pin the OLDEST Fedora you intend to support. A binary built
# here runs on this release and all newer ones, but not older (the dynamic
# linker needs >= the build host's glibc). The default below (fedora:44)
# matches a current release; lower it (e.g. fedora:42) only if you must
# support older Fedoras, since each step down raises the risk of a stale or
# archived package repo.
#
# NOTE: the WebKitGTK -devel package is `webkit2gtk4.1-devel` (Fedora renamed
# `webkit2gtk3` -> `webkit2gtk4.1` around F43; the old name is gone on F43+).

FROM fedora:44

# Build deps: the Tauri WebView stack + rpm build/validation tooling.
RUN dnf -y install \
      make gcc \
      rust cargo \
      nodejs npm \
      pkgconf-pkg-config \
      cmake perl \
      openssl-devel \
      webkit2gtk4.1-devel \
      gtk3-devel \
      libsoup3-devel \
      desktop-file-utils \
      libappstream-glib \
      rpm-build \
      rpmdevtools \
      rpmlint \
      file \
      streamlink \
    && dnf clean all

WORKDIR /src
# Build from the repo root so the whole tree (incl. packaging/shared/) is
# visible:
#   docker build -t kappastream-rpm packaging/fedora
#   docker run --rm -v "$PWD":/src kappastream-rpm
# The .rpm lands at packaging/fedora/dist/ on the host (via the /src mount).
CMD ["bash", "/src/packaging/fedora/build.sh"]
