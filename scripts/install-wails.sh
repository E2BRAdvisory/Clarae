#!/usr/bin/env bash
# Builds the Wails CLI with the repository's Go toolchain and a current golang.org/x/tools.
#
# Wails v2.12.0 pins x/tools v0.30, which cannot read the export data of Go 1.27: `wails dev`
# stops at "internal error: package "crypto/sha256" without types was imported from ...".
# The CLI itself is unchanged; only the x/tools it is linked with is newer.
#
#   scripts/install-wails.sh [version]     default v2.12.0; installs into $(go env GOBIN) or GOPATH/bin
set -euo pipefail

VERSION="${1:-v2.12.0}"
GOVERSION="$(sed -n 's/^go \([0-9.]*\)$/\1/p' "$(dirname "$0")/../go.work")"
export GOTOOLCHAIN="go${GOVERSION}"
export GOFLAGS=-mod=mod

work="$(mktemp -d)"
trap 'chmod -R u+w "$work"; rm -rf "$work"' EXIT

src="$(go mod download -json "github.com/wailsapp/wails/v2@${VERSION}" | sed -n 's/.*"Dir": "\(.*\)",/\1/p')"
cp -R "$src/." "$work"
chmod -R u+w "$work"

cd "$work"
go get golang.org/x/tools@latest
bin="$(go env GOBIN)"
bin="${bin:-$(go env GOPATH)/bin}"
mkdir -p "$bin"
go build -o "$bin/wails" ./cmd/wails
echo "wails ${VERSION} (Go ${GOVERSION}, x/tools $(go list -m -f '{{.Version}}' golang.org/x/tools)) installed in $bin"
