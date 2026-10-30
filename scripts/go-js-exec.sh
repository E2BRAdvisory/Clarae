#!/usr/bin/env bash
# Runs a Go test binary built with GOOS=js GOARCH=wasm under Node, with the sqlite-wasm bridge
# installed (ADR-0030, M9-WP2). Use it as the -exec program:
#   GOOS=js GOARCH=wasm go test -exec "$PWD/scripts/go-js-exec.sh" ./internal/store/...
# See `task test-wasm`.
set -euo pipefail
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
goroot="$(go env GOROOT)"
runner="$goroot/lib/wasm/wasm_exec_node.js"
[[ -f "$runner" ]] || runner="$goroot/misc/wasm/wasm_exec_node.js"
# A clean environment: the wasm runtime copies it into the Go process, and a large one fails to start.
exec env -i PATH="$PATH" HOME="${HOME:-/tmp}" TMPDIR="${TMPDIR:-/tmp}" \
  node --stack-size=8192 --import "$root/packages/sqlite-bridge/src/go-test-preload.ts" "$runner" "$@"
