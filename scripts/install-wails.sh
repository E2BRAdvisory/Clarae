#!/usr/bin/env bash
# Installs the Wails CLI at the version of the Wails library required by apps/desktop/go.mod (the only
# place the version is written), built with the repository's Go toolchain.
#
# CLI and library must match: otherwise `wails dev` / `wails build` rewrite go.mod to the CLI's own
# version (the repository also passes -nosyncgomod everywhere as a safety net). Since v2.17 the CLI
# links an x/tools that reads Go 1.27 export data, so the module is built exactly as published:
# dependencies come from its own go.sum (checked against the checksum database), nothing is overridden.
#
#   scripts/install-wails.sh             install into $(go env GOBIN), or GOPATH/bin
#   scripts/install-wails.sh --check     fail unless the wails on PATH (or in GOBIN) has that version
#   scripts/install-wails.sh --version   print the version
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
VERSION="$(awk '{ for (i = 1; i < NF; i++) if ($i == "github.com/wailsapp/wails/v2" && $(i + 1) != "=>") { print $(i + 1); exit } }' \
  "$root/apps/desktop/go.mod")"
[ -n "$VERSION" ] || { echo "install-wails: github.com/wailsapp/wails/v2 not found in apps/desktop/go.mod" >&2; exit 1; }

gobin() {
  local bin
  bin="$(go env GOBIN)"
  echo "${bin:-$(go env GOPATH)/bin}"
}

case "${1:-}" in
  --version)
    echo "$VERSION"
    exit 0
    ;;
  --check)
    cli="$(command -v wails 2>/dev/null || true)"
    [ -n "$cli" ] || cli="$(gobin)/wails"
    have="$([ -x "$cli" ] && "$cli" version 2>/dev/null | head -n 1 || true)"
    if [ "$have" != "$VERSION" ]; then
      echo "install-wails: ${cli} is ${have:-missing}, apps/desktop/go.mod requires Wails ${VERSION}: run 'task wails-cli'" >&2
      exit 1
    fi
    exit 0
    ;;
  "") ;;
  *)
    echo "usage: $0 [--check|--version]  (the version comes from apps/desktop/go.mod)" >&2
    exit 2
    ;;
esac

GOVERSION="$(sed -n 's/^go \([0-9.]*\)$/\1/p' "$root/go.work")"
export GOTOOLCHAIN="go${GOVERSION}"
# Outside the workspace: `go install pkg@version` uses the Wails module's own go.mod and go.sum.
export GOWORK=off GOFLAGS=-mod=readonly

bin="$(gobin)"
mkdir -p "$bin"
GOBIN="$bin" go install "github.com/wailsapp/wails/v2/cmd/wails@${VERSION}"
echo "wails ${VERSION} (Go ${GOVERSION}) installed in $bin"
