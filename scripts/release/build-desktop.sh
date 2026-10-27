#!/usr/bin/env bash
# Build the desktop app for one OS with the version stamped in (M7-WP3).
#
#   scripts/release/build-desktop.sh <darwin|windows|linux> <version> [--release]
#
# - <version> is semver without the leading "v" (1.0.0, 1.1.0-rc.1). It is stamped into the
#   binary (-X main.Version, shown in About and used by the updater), into the macOS
#   Info.plist and the Windows version resources (wails.json info.productVersion, patched
#   temporarily and restored on exit; the file in the repository never changes).
# - Output goes to apps/desktop/build/bin.
# - darwin: universal .app; windows: amd64 + NSIS installer (needs makensis); linux: amd64 binary.
# - UPDATE_PUBLIC_KEY (base64 ed25519) and UPDATE_BASE_URL are compiled in with ldflags. With
#   --release they are mandatory: a release must never ship the development update key.
set -euo pipefail
. "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/lib.sh"

TARGET="${1:-}"; VERSION="${2:-}"; MODE="${3:-}"
case "$TARGET" in darwin|windows|linux) ;; *) die "usage: $0 <darwin|windows|linux> <version> [--release]" ;; esac
VERSION="${VERSION#v}"
[[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$ ]] || die "invalid semver: '$VERSION'"
# Windows/macOS numeric version resources need MAJOR.MINOR.PATCH only.
NUMERIC="${VERSION%%-*}"

UPDATER_PKG=memobrain/apps/desktop/internal/updater
LDFLAGS="-s -w -X main.Version=$VERSION"
if [ -n "${UPDATE_PUBLIC_KEY:-}" ]; then
  LDFLAGS="$LDFLAGS -X $UPDATER_PKG.PublicKeyB64=$UPDATE_PUBLIC_KEY"
elif [ "$MODE" = "--release" ]; then
  die "UPDATE_PUBLIC_KEY is not set: refusing to build a release with the development update key (docs/release/secrets.md)"
else
  warn "UPDATE_PUBLIC_KEY not set: this build trusts the DEVELOPMENT update key (not for distribution)"
fi
if [ -n "${UPDATE_BASE_URL:-}" ]; then
  LDFLAGS="$LDFLAGS -X $UPDATER_PKG.ManifestBaseURL=$UPDATE_BASE_URL"
elif [ "$MODE" = "--release" ]; then
  die "UPDATE_BASE_URL is not set (public URL of the update channel)"
fi

need wails; need jq; need yarn
DESKTOP="$ROOT/apps/desktop"
# wails build rewrites a few tracked files (version-stamped NSIS tools, frontend md5): keep copies
# and restore them on exit so a local build leaves the working tree clean.
NSH="$DESKTOP/build/windows/installer/wails_tools.nsh"; MD5="$DESKTOP/frontend/package.json.md5"
SAVE="$(mktemp -d)"
cp "$DESKTOP/wails.json" "$SAVE/wails.json"
[ -f "$NSH" ] && cp "$NSH" "$SAVE/wails_tools.nsh"
[ -f "$MD5" ] && cp "$MD5" "$SAVE/package.json.md5"
restore() {
  cp "$SAVE/wails.json" "$DESKTOP/wails.json"
  [ -f "$SAVE/wails_tools.nsh" ] && cp "$SAVE/wails_tools.nsh" "$NSH"
  [ -f "$SAVE/package.json.md5" ] && cp "$SAVE/package.json.md5" "$MD5"
  rm -rf "$SAVE" "$DESKTOP/build/windows/installer/tmp"
}
trap restore EXIT
jq --arg v "$NUMERIC" '.info.productVersion = $v' "$SAVE/wails.json" > "$DESKTOP/wails.json"

cd "$DESKTOP"
case "$TARGET" in
  darwin)  wails build -clean -platform darwin/universal -ldflags "$LDFLAGS" ;;
  windows) need makensis
           wails build -clean -platform windows/amd64 -nsis -ldflags "$LDFLAGS" ;;
  linux)   wails build -clean -platform linux/amd64 -tags webkit2_41 -ldflags "$LDFLAGS" ;;
esac
ok "built $TARGET $VERSION in apps/desktop/build/bin"
ls -la build/bin
