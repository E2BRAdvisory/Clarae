#!/usr/bin/env bash
# What `task vet-linux` runs inside the image of this folder (M22, ADR-0062): the Linux build of apps/desktop, which
# no other task compiles on a Mac. The repository is mounted read-only at /src.
set -euo pipefail
cd /src/apps/desktop
export CGO_ENABLED=1 GOOS=linux GOFLAGS=-buildvcs=false

echo "==> linux/$(go env GOARCH), GTK $(pkg-config --modversion gtk+-3.0), WebKitGTK $(pkg-config --modversion webkit2gtk-4.1), $(go version | cut -d' ' -f3)"

# The package must also list in every build that has no driver of Linux (GTK4 by default, purego, the server tag, no
# cgo): a C file that the tool cannot leave out ("C source files not allowed when not using cgo") breaks the build of
# anyone who does not have GTK3. The files of the driver carry the constraint of the binding of Wails for GTK3.
for cfg in "1|" "1|gtk3,purego" "1|gtk3,server" "1|gtk3,android" "0|" "0|gtk3"; do
  CGO_ENABLED="${cfg%%|*}" go list -tags "${cfg#*|}" ./internal/shell/nativeview >/dev/null
done
# ... and without cgo it compiles and vets (driver_other.go).
CGO_ENABLED=0 go vet -tags 'gtk3,purego' ./internal/shell/nativeview/

# The release build: GTK3 + WebKit2GTK 4.1 (scripts/build-desktop-bin.sh passes -tags production,gtk3).
go vet -tags gtk3 ./...
# The live test of the Linux driver (tag nativeviewtest) is vetted and compiled too: it is run by hand.
go vet -tags 'gtk3 nativeviewtest' ./internal/shell/nativeview/
for p in $(go list -tags gtk3 -f '{{if or .TestGoFiles .XTestGoFiles}}{{.ImportPath}}{{end}}' ./internal/shell/... ./internal/app/... ./internal/webview/...); do
  go test -tags gtk3 -c -o /dev/null "$p"
done
go test -tags 'gtk3 nativeviewtest' -c -o /dev/null ./internal/shell/nativeview/

# The C side, with the warnings the Go tool does not turn on.
cflags=$(pkg-config --cflags gtk+-3.0 webkit2gtk-4.1)
for def in "" "-DCLARAE_NATIVEVIEW_TEST" "-DCLARAE_NATIVEVIEW_TEST -DCLARAE_NATIVEVIEW_TRACE"; do
  # shellcheck disable=SC2086
  gcc -Wall -Wextra -Wno-unused-parameter $def -fsyntax-only $cflags internal/shell/nativeview/guest_linux.c
done
echo "==> ok"
