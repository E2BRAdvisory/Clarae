#!/usr/bin/env bash
# Build the desktop app for one OS with the version stamped in (M7-WP3).
#
#   [ARCH=amd64|arm64] scripts/release/build-desktop.sh <darwin|windows|linux> <version> [--release]
#
# - <version> is semver without the leading "v" (1.0.0, 1.1.0-rc.1). It is stamped into the
#   binary (-X main.Version, shown in About and used by the updater), into the macOS
#   Info.plist and the Windows version resources (wails.json info.productVersion, patched
#   temporarily and restored on exit; the file in the repository never changes).
# - Output goes to apps/desktop/build/bin.
# - darwin: universal .app; windows: NSIS installer for $ARCH (needs makensis; arm64 is cross-compiled,
#   the webview binding needs no CGO); linux: binary for $ARCH (arm64 needs an arm64 host, WebKitGTK is CGO).
#   $ARCH defaults to amd64; macOS is always universal.
# - Windows signing: when MEMOBRAIN_SIGNTOOL_CMD is set (a signtool command line, %1 = the file) the
#   application exe is signed BEFORE it is packed, then NSIS signs the installer and uninstaller.
# - UPDATE_PUBLIC_KEY (base64 ed25519) and UPDATE_BASE_URL are compiled in with ldflags. With
#   --release they are mandatory: a release must never ship the development update key. The one way out is
#   ALLOW_UNSIGNED_UPDATES=1 (unsigned channel, ADR-0031): the updater is then compiled out (DisabledByBuild),
#   so the app never looks for updates it could not verify.
set -euo pipefail
. "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/lib.sh"

TARGET="${1:-}"; VERSION="${2:-}"; MODE="${3:-}"
case "$TARGET" in darwin|windows|linux) ;; *) die "usage: $0 <darwin|windows|linux> <version> [--release]" ;; esac
VERSION="${VERSION#v}"
ARCH="${ARCH:-amd64}"
case "$ARCH" in
  amd64|arm64) ;;
  universal) [ "$TARGET" = darwin ] || die "ARCH=universal is for darwin only" ;;
  *) die "ARCH must be amd64 or arm64 (universal on darwin), got '$ARCH'" ;;
esac
[[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$ ]] || die "invalid semver: '$VERSION'"
# Windows/macOS numeric version resources need MAJOR.MINOR.PATCH only.
NUMERIC="${VERSION%%-*}"

UPDATER_PKG=memobrain/apps/desktop/internal/updater
LDFLAGS="-s -w -X main.Version=$VERSION"
UNSIGNED_UPDATES=0
if [ -n "${UPDATE_PUBLIC_KEY:-}" ]; then
  LDFLAGS="$LDFLAGS -X $UPDATER_PKG.PublicKeyB64=$UPDATE_PUBLIC_KEY"
elif [ "${ALLOW_UNSIGNED_UPDATES:-}" = "1" ]; then
  UNSIGNED_UPDATES=1
  warn "UPDATE_PUBLIC_KEY not set: the updater is compiled out of this build (ALLOW_UNSIGNED_UPDATES=1)"
  LDFLAGS="$LDFLAGS -X $UPDATER_PKG.DisabledByBuild=1"
elif [ "$MODE" = "--release" ]; then
  die "UPDATE_PUBLIC_KEY is not set: refusing to build a release with the development update key (docs/release/secrets.md)"
else
  warn "UPDATE_PUBLIC_KEY not set: this build trusts the DEVELOPMENT update key (not for distribution)"
fi
if [ -n "${UPDATE_BASE_URL:-}" ]; then
  LDFLAGS="$LDFLAGS -X $UPDATER_PKG.ManifestBaseURL=$UPDATE_BASE_URL"
elif [ "$MODE" = "--release" ] && [ "$UNSIGNED_UPDATES" = "0" ]; then
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
  darwin)  wails build -clean -nosyncgomod -platform darwin/universal -ldflags "$LDFLAGS" ;;
  windows) need makensis
           wails build -clean -nosyncgomod -platform "windows/$ARCH" -ldflags "$LDFLAGS"
           EXE="build/bin/memobrain.exe"
           [ -f "$EXE" ] || die "wails did not produce $EXE"
           if [ -n "${MEMOBRAIN_SIGNTOOL_CMD:-}" ]; then
             # The command is a full signtool line with %1 for the file, as NSIS takes it.
             log "signing $EXE"
             bash -c "${MEMOBRAIN_SIGNTOOL_CMD//%1/$EXE}"
           else
             warn "MEMOBRAIN_SIGNTOOL_CMD not set: memobrain.exe and its installer are UNSIGNED"
           fi
           # makensis is run here rather than through `wails build -nsis` so the exe is signed first.
           upper="$(printf '%s' "$ARCH" | tr '[:lower:]' '[:upper:]')"
           # The installer bootstraps WebView2 with Microsoft's evergreen setup. The copy embedded in the Wails
           # module is used (as `wails build -nsis` does): go.sum pins its hash, while the fwlink URL serves a
           # file that changes with every Microsoft update and so cannot be pinned.
           mkdir -p build/windows/installer/tmp
           WV2="$(go list -m -f '{{.Dir}}' github.com/wailsapp/wails/v2)/internal/webview2runtime/MicrosoftEdgeWebview2Setup.exe"
           command -v cygpath >/dev/null 2>&1 && WV2="$(cygpath -u "$WV2")" # Git Bash on the Windows runner
           [ -f "$WV2" ] || die "WebView2 bootstrapper not found in the Wails module ($WV2)"
           cp "$WV2" build/windows/installer/tmp/MicrosoftEdgeWebview2Setup.exe
           GOWORK=off go run "$ROOT/scripts/release/nsis-render.go" wails.json build/windows/installer/wails_tools.nsh
           (cd build/windows/installer && makensis -V2 "-DARG_WAILS_${upper}_BINARY=..\\..\\bin\\memobrain.exe" project.nsi) ;;
  linux)   wails build -clean -nosyncgomod -platform "linux/$ARCH" -tags webkit2_41 -ldflags "$LDFLAGS" ;;
esac
ok "built $TARGET $VERSION in apps/desktop/build/bin"
ls -la build/bin
