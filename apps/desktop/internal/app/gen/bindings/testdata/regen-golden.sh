#!/usr/bin/env bash
# Rewrites testdata/golden from what the Wails v2 CLI writes for the fixture package: the golden is the
# reference the generator (go run ./internal/app/gen/bindings) is held to, so it must come from
# `wails generate module`, never from the generator itself. apps/desktop depends on Wails v3 and no longer
# on v2, so the v2 version the golden comes from is pinned here (WAILS_V2) and the fixture is built in a
# temporary module of its own: `go mod tidy` there fetches the v2 module and writes its go.sum (it needs the
# network, or a module cache that already holds it), the CLI step then runs with GOPROXY=off. Needs the
# CLI at that version: go install github.com/wailsapp/wails/v2/cmd/wails@v2.17.1
#
# The module path comes from apps/desktop/go.mod (the type arguments of a generic name carry the import path
# of their package); it is written to the golden as memobrain_apps_desktop whatever the module is called,
# so that `task rename-module` does not invalidate the golden (generate_test.go does the same).
#
#   internal/app/gen/bindings/testdata/regen-golden.sh
set -euo pipefail

WAILS_V2=v2.17.1

here="$(cd "$(dirname "$0")" && pwd)"
pkg="$(cd "$here/.." && pwd)"
gomod="$pkg/../../../../go.mod"
desktop="$(awk '$1 == "module" { print $2; exit }' "$gomod")"
[ -n "$desktop" ] || { echo "regen-golden: no module line in $gomod" >&2; exit 1; }
module="$desktop/internal/app/gen/bindings"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

cp -R "$pkg/fixture" "$tmp/fixture"
cat >"$tmp/go.mod" <<MOD
module $module

go 1.27.4

require github.com/wailsapp/wails/v2 $WAILS_V2
MOD
cat >"$tmp/main.go" <<GO
package main

import (
	"$module/fixture"

	"github.com/wailsapp/wails/v2"
	"github.com/wailsapp/wails/v2/pkg/options"
)

func main() { _ = wails.Run(&options.App{Bind: fixture.Services()}) }
GO
(cd "$tmp" && GOWORK=off GOFLAGS=-mod=mod go mod tidy >"$tmp/tidy.log" 2>&1) ||
  { cat "$tmp/tidy.log" >&2; exit 1; }
have_cli="$(wails version 2>&1 | grep -Eo '^v2\.[0-9]+\.[0-9]+' | head -n 1 || true)"
[ "$have_cli" = "$WAILS_V2" ] ||
  { echo "regen-golden: the wails CLI is '${have_cli:-missing}', the golden is written by $WAILS_V2" >&2; exit 1; }
echo '{"name":"fixture","outputfilename":"fixture","wailsjsdir":"./out"}' >"$tmp/wails.json"

(cd "$tmp" && GOWORK=off GOFLAGS=-mod=mod GOPROXY=off wails generate module >"$tmp/wails.log" 2>&1) ||
  { cat "$tmp/wails.log" >&2; exit 1; }

# A generic type argument is written with every character outside [A-Za-z0-9_] as an underscore.
sanitize() { printf '%s' "$1" | sed 's/[^A-Za-z0-9_]/_/g'; }
have="$(sanitize "$desktop")"
want=memobrain_apps_desktop # goldenModule of generate_test.go

rm -rf "$here/golden"
(cd "$tmp/out/wailsjs" && find . -type f) | while read -r f; do
  mkdir -p "$here/golden/$(dirname "$f")"
  sed "s/$have/$want/g" "$tmp/out/wailsjs/$f" >"$here/golden/$f.golden"
done
echo "golden rewritten from the Wails CLI $have_cli"
