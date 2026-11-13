#!/usr/bin/env bash
# Fails when a release binary was built with a build tag it must never carry (ADR-0051, B-D8), or without
# "production". Reads the build settings the Go linker embeds (`go version -m`), so it checks what was really built:
#
#   scripts/release/check-build-tags.sh <binary|Clarae notanda.app> [...]
#
#   mcp       the Wails v3 MCP server: drives the app from 127.0.0.1:9099
#   server    the Wails v3 server mode: an HTTP server instead of a window
#   devtools  the web inspector (`wails3 dev` adds tags from the environment)
#   production (required) the strict CSP and no development logging
#
# The app refuses to start with these tags (internal/shell/buildtags.go): this check stops the release before that.
# A universal macOS binary is checked slice by slice.
set -euo pipefail
. "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/lib.sh"

[ $# -gt 0 ] || die "usage: $0 <binary|.app> [...]"
need go

FORBIDDEN="mcp server devtools"

# tags_of <binary> prints the -tags value of the build ("" when none).
tags_of() {
  local out
  out="$(go version -m "$1")" || die "go version -m failed on $1: not a Go binary?"
  printf '%s\n' "$out" | sed -n 's/^[[:space:]]*build[[:space:]]*-tags=//p' | tail -n 1
}

# check_one <binary> <label>
check_one() {
  local bin="$1" label="$2" tags t f
  tags="$(tags_of "$bin")"
  for f in $FORBIDDEN; do
    for t in ${tags//,/ }; do
      [ "$t" != "$f" ] || die "$label was built with the forbidden tag '$f' (tags: $tags): rebuild without it"
    done
  done
  case ",$tags," in *,production,*) ;; *) die "$label was not built with the tag 'production' (tags: '${tags:-none}')" ;; esac
  ok "$label: tags '$tags'"
}

check_binary() {
  local bin="$1" archs a tmp
  [ -f "$bin" ] || die "$bin not found"
  if command -v lipo >/dev/null 2>&1 && archs="$(lipo -archs "$bin" 2>/dev/null)" && [ "$(wc -w <<<"$archs")" -gt 1 ]; then
    tmp="$(mktemp -d)"
    for a in $archs; do
      lipo -thin "$a" "$bin" -output "$tmp/$a"
      check_one "$tmp/$a" "$(basename "$bin") ($a)"
    done
    rm -rf "$tmp"
  else
    check_one "$bin" "$(basename "$bin")"
  fi
}

for target in "$@"; do
  if [ -d "$target" ]; then
    # A macOS bundle: the executable is CFBundleExecutable in Contents/MacOS.
    exe="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleExecutable' "$target/Contents/Info.plist" 2>/dev/null || true)"
    [ -n "$exe" ] || die "$target has no CFBundleExecutable"
    check_binary "$target/Contents/MacOS/$exe"
  else
    check_binary "$target"
  fi
done
