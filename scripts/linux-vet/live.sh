#!/usr/bin/env bash
# What `task test-nativeview-linux` runs inside the image of this folder (M22, ADR-0062): the live test of the Linux
# driver of the native web views, under a virtual X server. The repository is mounted read-only at /src.
#
# The driver never makes a guest without the sandbox of WebKit (bubblewrap), so the test runs with it. In a container
# bubblewrap needs to create user namespaces, which Docker's default profile does not allow: `task test-nativeview-linux`
# runs the container with --cap-add SYS_ADMIN --cap-add NET_ADMIN --security-opt seccomp=unconfined --security-opt systempaths=unconfined (or
# --privileged). The GPU paths
# of WebKit need a driver the container has not: they are turned off here, for the test only (the application never sets
# them). RUN restricts the tests (a go test -run expression); CLARAE_NATIVEVIEW_CFLAGS adds C flags
# (-DCLARAE_NATIVEVIEW_TRACE logs the navigations the policy sees); CLARAE_LIVE_NO_MENU=1 runs without a menu bar.
set -euo pipefail
cd /src/apps/desktop
export CGO_ENABLED=1 GOOS=linux GOFLAGS=-buildvcs=false
unset WEBKIT_DISABLE_SANDBOX_THIS_IS_DANGEROUS
export WEBKIT_DISABLE_COMPOSITING_MODE=1 LIBGL_ALWAYS_SOFTWARE=1 GDK_BACKEND=x11 NO_AT_BRIDGE=1
export CGO_CFLAGS="-g -O2 ${CLARAE_NATIVEVIEW_CFLAGS:-}"
# The check the driver makes, so that a refusal here is not a surprise there: the namespaces and a seccomp filter.
printf '\x06\x00\x00\x00\x00\x00\xff\x7f' > /tmp/allow.bpf
if ! bwrap --unshare-uts --unshare-pid --unshare-net --unshare-ipc --die-with-parent --ro-bind / / --dev /dev --proc /proc --seccomp 3 true 3< /tmp/allow.bpf 2>/dev/null; then
  echo "bubblewrap cannot create its namespaces in this container: the live test needs the sandbox of WebKit." >&2
  echo "(an amd64 container on an arm64 machine cannot: its emulator has no seccomp; use LINUX_ARCH=arm64 there)" >&2
  echo "run the container with: --cap-add SYS_ADMIN --cap-add NET_ADMIN --security-opt seccomp=unconfined --security-opt systempaths=unconfined  (task test-nativeview-linux does)" >&2
  exit 1
fi
echo "==> linux/$(go env GOARCH), WebKitGTK $(pkg-config --modversion webkit2gtk-4.1)"
xvfb-run -a -s '-screen 0 1600x1000x24' dbus-launch --exit-with-session \
  go test -tags 'gtk3 nativeviewtest' -count=1 -v -timeout 600s ${RUN:+-run "$RUN"} ./internal/shell/nativeview/
