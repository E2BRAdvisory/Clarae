# The image that `task vet-linux` and `task test-nativeview-linux` run in (M22, ADR-0062): Go and the
# libraries the Linux build of the desktop links (GTK3 and WebKit2GTK 4.1, as release.yml installs them on
# the runner), plus a virtual X server for the live test of the Linux driver of the native web views.
# Built on demand by the tasks (docker build is cached), never pushed anywhere.
FROM golang:1.27-bookworm

RUN apt-get update \
 && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
      pkg-config libgtk-3-dev libwebkit2gtk-4.1-dev \
      xvfb xauth x11-utils dbus-x11 libgl1-mesa-dri fonts-dejavu-core ca-certificates \
 && rm -rf /var/lib/apt/lists/*
