#!/usr/bin/env bash
# Installs the Wails v3 CLI (wails3) at the version of the Wails library required by apps/desktop/go.mod (the only
# place the version is written), built with the repository's Go toolchain (ADR-0051).
#
# The CLI is not used to build the app (scripts/build-desktop-bin.sh runs `go build`): it provides the dev watcher
# (`wails3 tool watcher`), the Windows resources (`wails3 generate syso`) and the WebView2 bootstrapper. Library,
# CLI and the JS runtime (@wailsio/runtime in apps/desktop/frontend/package.json, pinned exactly) must be the same
# release: the runtime speaks the library's wire protocol.
#
# The module is built exactly as published, outside the workspace: dependencies come from its own go.sum (checked
# against the checksum database), nothing is overridden.
#
#   scripts/install-wails.sh                install into $(go env GOBIN), or GOPATH/bin
#   scripts/install-wails.sh --check        fail unless go.mod, the wails3 CLI and the npm runtime have that version
#   scripts/install-wails.sh --check-pins   same, but a missing CLI is not an error (task lint, CI without the CLI)
#   scripts/install-wails.sh --version      print the version (with the leading "v")
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
VERSION="$(awk '{ for (i = 1; i < NF; i++) if ($i == "github.com/wailsapp/wails/v3" && $(i + 1) != "=>") { print $(i + 1); exit } }' \
  "$root/apps/desktop/go.mod")"
[ -n "$VERSION" ] || { echo "install-wails: github.com/wailsapp/wails/v3 not found in apps/desktop/go.mod" >&2; exit 1; }

gobin() {
  local bin
  bin="$(go env GOBIN)"
  echo "${bin:-$(go env GOPATH)/bin}"
}

# cli_path prints the wails3 to use: the one on PATH, else the one in GOBIN; nothing when there is none.
cli_path() {
  local cli
  cli="$(command -v wails3 2>/dev/null || true)"
  [ -n "$cli" ] || { cli="$(gobin)/wails3"; [ -x "$cli" ] || cli=""; }
  echo "$cli"
}

# check verifies the three places the version is written. $1 = require-cli | optional-cli.
check() {
  local mode="$1" status=0 cli have runtime
  runtime="$(sed -n 's/^[[:space:]]*"@wailsio\/runtime":[[:space:]]*"\([^"]*\)".*/\1/p' "$root/apps/desktop/frontend/package.json" | head -n 1)"
  if [ "$runtime" != "${VERSION#v}" ]; then
    echo "install-wails: @wailsio/runtime is '${runtime:-missing}' in apps/desktop/frontend/package.json, apps/desktop/go.mod requires Wails ${VERSION} (pin it exactly: ${VERSION#v})" >&2
    status=1
  fi
  cli="$(cli_path)"
  if [ -z "$cli" ]; then
    if [ "$mode" = require-cli ]; then
      echo "install-wails: wails3 not found: run 'task wails-cli'" >&2
      status=1
    fi
  else
    # `wails3 version` prints on stderr, and the version is the last line: the CLI may print a banner before it.
    have="$("$cli" version 2>&1 | sed -n 's/^[[:space:]]*\(v[0-9][^[:space:]]*\)[[:space:]]*$/\1/p' | tail -n 1 || true)"
    if [ "$have" != "$VERSION" ]; then
      echo "install-wails: ${cli} is ${have:-of unknown version}, apps/desktop/go.mod requires Wails ${VERSION}: run 'task wails-cli'" >&2
      status=1
    fi
  fi
  return "$status"
}

case "${1:-}" in
  --version)
    echo "$VERSION"
    exit 0
    ;;
  --check)
    check require-cli
    exit $?
    ;;
  --check-pins)
    check optional-cli
    exit $?
    ;;
  "") ;;
  *)
    echo "usage: $0 [--check|--check-pins|--version]  (the version comes from apps/desktop/go.mod)" >&2
    exit 2
    ;;
esac

GOVERSION="$(sed -n 's/^go \([0-9.]*\)$/\1/p' "$root/go.work")"
export GOTOOLCHAIN="go${GOVERSION}"
# Outside the workspace: `go install pkg@version` uses the Wails module's own go.mod and go.sum.
export GOWORK=off GOFLAGS=-mod=readonly

bin="$(gobin)"
mkdir -p "$bin"
GOBIN="$bin" go install "github.com/wailsapp/wails/v3/cmd/wails3@${VERSION}"
echo "wails3 ${VERSION} (Go ${GOVERSION}) installed in $bin"
