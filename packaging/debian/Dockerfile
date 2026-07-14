# Build a kappastream .deb for Ubuntu 24.04 (noble) + Debian 13 (trixie).
#
# Why noble as the base: glibc 2.39 here is OLDER than trixie's 2.40, so a
# binary built in this image also runs on trixie. The .deb's Depends use
# non-t64 package names, which trixie's t64 packages satisfy via Provides.
#
# Ubuntu 24.04's packaged rustc (1.75) and nodejs (18) are too old for the
# Tauri 2 MSRV (>=1.77.2) and Vite 8 (Node >=20.19), so rustup + nodesource
# supply current toolchains. The runtime libs the binary links against come
# from noble's own libwebkit2gtk-4.1-dev / libgtk-3-dev (the glibc floor).

FROM ubuntu:24.04

ENV DEBIAN_FRONTEND=noninteractive
ENV TZ=UTC

# 1) Current Node (Vite 8 requires >=20.19 / >=22.12).
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl gnupg \
 && curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
 && apt-get install -y --no-install-recommends nodejs \
 && rm -rf /var/lib/apt/lists/*

# 2) Current Rust (Tauri 2 MSRV >=1.77.2; noble only ships 1.75).
RUN curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs \
 | sh -s -- -y --profile minimal
ENV PATH="/root/.cargo/bin:${PATH}"

# 3) Build deps: the Tauri WebView stack + dpkg-deb tooling.
RUN apt-get update && apt-get install -y --no-install-recommends \
      build-essential \
      pkg-config \
      libssl-dev \
      libwebkit2gtk-4.1-dev \
      libgtk-3-dev \
      libjavascriptcoregtk-4.1-dev \
      libsoup-3.0-dev \
      libglib2.0-dev \
      libgdk-pixbuf2.0-dev \
      libcairo2-dev \
      libdbus-1-dev \
      libwayland-dev \
      cmake \
      perl \
      file \
      dpkg-dev \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /src
# Build from the repo root so the whole tree (incl. packaging/shared/) is
# visible:
#   docker build -t kappastream-deb packaging/debian
#   docker run --rm -v "$PWD":/src kappastream-deb
# The .deb lands at packaging/debian/dist/ on the host (via the /src mount).
CMD ["bash", "/src/packaging/debian/build.sh"]
