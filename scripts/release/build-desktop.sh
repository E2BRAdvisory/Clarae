#!/usr/bin/env bash
# Build the desktop app for one OS with the version stamped in (M7-WP3; Wails v3, ADR-0051).
#
#   [ARCH=amd64|arm64] scripts/release/build-desktop.sh <darwin|windows|linux> <version> [--release]
#
# - <version> is semver without the leading "v" (1.0.0, 1.1.0-rc.1). It is stamped into the
#   binary (-X main.Version, shown in About and used by the updater), into the macOS
#   Info.plist and the Windows version resources (MAJOR.MINOR.PATCH only). Nothing in the repository changes:
#   the templates are rendered by scripts/release/render-assets.go into a temporary directory.
# - The binary is built by scripts/build-desktop-bin.sh (plain `go build -tags production[,gtk3]`, no Wails CLI
#   for the build itself) into apps/desktop/build/bin:
#     darwin   "MemoBrain Notes.app", universal (the .dmg is made by package-macos.sh)
#     windows  memobrain.exe and the NSIS installer memobrain-<arch>-installer.exe for $ARCH (needs makensis and the
#              wails3 CLI for the exe resources and the WebView2 bootstrapper; arm64 is cross-compiled, the
#              WebView2 binding needs no CGO)
#     linux    memobrain for $ARCH (arm64 needs an arm64 host, WebKitGTK is CGO; the .deb and AppImage are made by
#              package-linux.sh)
#   $ARCH defaults to amd64; macOS is always universal.
# - SKIP_FRONTEND=1 reuses apps/desktop/frontend/dist instead of building the UI again (local checks only: with
#   --release it is refused, a release always builds it). Any other value than 1, 0 or empty is an error.
# - With --release the build switches of the frontend (MEMOBRAIN_AI, MEMOBRAIN_COLLAB,
#   MEMOBRAIN_E2E) and MEMOBRAIN_DIST must not be set, and neither the collaboration code nor the binding mock of the
#   e2e tests may be in the frontend that was built, which must have the Milkdown editor (check-editor-switches.sh, check-dist.sh, run by build-desktop-bin.sh). A release
#   is the default build. `task release-desktop` always passes --release.
# - Every binary is checked with scripts/release/check-build-tags.sh: it must carry the tag "production" and none
#   of mcp, server, devtools (ADR-0051, B-D8).
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

# Only the value 1 reuses dist/: a bare "is it set" test would also skip the build on SKIP_FRONTEND=0.
SKIP_FRONTEND_FLAG=""
case "${SKIP_FRONTEND:-0}" in
  0) ;;
  1) [ "$MODE" != "--release" ] || die "SKIP_FRONTEND=1 is not allowed with --release: a release always builds the UI"
     SKIP_FRONTEND_FLAG=1 ;;
  *) die "SKIP_FRONTEND must be 1, 0 or empty, got '$SKIP_FRONTEND'" ;;
esac

RELEASE_FLAG=""
if [ "$MODE" = "--release" ]; then
  RELEASE_FLAG=1
  # Fail before the Go toolchain and the installer tools are looked for (build-desktop-bin.sh checks again).
  sh "$ROOT/scripts/release/check-editor-switches.sh"
fi

need go
DESKTOP="$ROOT/apps/desktop"
# The import path is asked to the toolchain, never spelled here: the linker ignores -X on a package that does not
# exist, so a stale path would build a release that trusts the development update key without any error.
UPDATER_PKG="$(cd "$DESKTOP" && go list ./internal/updater)"
[ -n "$UPDATER_PKG" ] || die "go list did not find the updater package in $DESKTOP"
UPDATER_FLAGS=""
UNSIGNED_UPDATES=0
PROBE_PUBLIC_KEY=""
PROBE_DISABLED=""
if [ -n "${UPDATE_PUBLIC_KEY:-}" ]; then
  UPDATER_FLAGS="-X $UPDATER_PKG.PublicKeyB64=$UPDATE_PUBLIC_KEY"
  PROBE_PUBLIC_KEY="$UPDATE_PUBLIC_KEY"
elif [ "${ALLOW_UNSIGNED_UPDATES:-}" = "1" ]; then
  UNSIGNED_UPDATES=1
  warn "UPDATE_PUBLIC_KEY not set: the updater is compiled out of this build (ALLOW_UNSIGNED_UPDATES=1)"
  UPDATER_FLAGS="-X $UPDATER_PKG.DisabledByBuild=1"
  PROBE_DISABLED=1
elif [ "$MODE" = "--release" ]; then
  die "UPDATE_PUBLIC_KEY is not set: refusing to build a release with the development update key (docs/release/secrets.md)"
else
  warn "UPDATE_PUBLIC_KEY not set: this build trusts the DEVELOPMENT update key (not for distribution)"
fi
if [ -n "${UPDATE_BASE_URL:-}" ]; then
  UPDATER_FLAGS="${UPDATER_FLAGS:+$UPDATER_FLAGS }-X $UPDATER_PKG.ManifestBaseURL=$UPDATE_BASE_URL"
elif [ "$MODE" = "--release" ] && [ "$UNSIGNED_UPDATES" = "0" ]; then
  die "UPDATE_BASE_URL is not set (public URL of the update channel)"
fi

# The flags are checked where they land (internal/updater/ldflags_test.go) before anything is compiled with them.
# -v and the grep: a probe that was skipped or not found must not count as a pass.
if [ -n "$UPDATER_FLAGS" ]; then
  log "checking that the updater flags reach $UPDATER_PKG"
  PROBE_OUT="$(cd "$DESKTOP" && env UPDATER_PROBE=1 UPDATER_EXPECT_PUBLIC_KEY="$PROBE_PUBLIC_KEY" \
    UPDATER_EXPECT_DISABLED="$PROBE_DISABLED" ${UPDATE_BASE_URL:+UPDATER_EXPECT_BASE_URL="$UPDATE_BASE_URL"} \
    go test -count=1 -v -run '^TestLdflagsProbe$' -ldflags "$UPDATER_FLAGS" ./internal/updater 2>&1)" \
    && printf '%s\n' "$PROBE_OUT" | grep -q -- '^--- PASS: TestLdflagsProbe' \
    || { printf '%s\n' "$PROBE_OUT" >&2; die "the updater flags did not reach $UPDATER_PKG (internal/updater/ldflags_test.go)"; }
fi

BUILD_DIR="$DESKTOP/build"
BIN_DIR="$BUILD_DIR/bin"
PROJECT="$BUILD_DIR/project.json"
RENDER="$ROOT/scripts/release/render-assets.go"
NAME="$(GOWORK=off go run "$RENDER" -project "$PROJECT" -field name)"          # "MemoBrain Notes": bundle and PRODUCT_EXECUTABLE
OUTPUT="$(GOWORK=off go run "$RENDER" -project "$PROJECT" -field outputfilename)" # "memobrain": CFBundleExecutable, linux binary
[ -n "$NAME" ] && [ -n "$OUTPUT" ] || die "$PROJECT has no name or outputfilename"

# bin_build <os> <arch>: scripts/build-desktop-bin.sh with the updater flags of this release.
bin_build() {
  bash "$ROOT/scripts/build-desktop-bin.sh" --os "$1" --arch "$2" --version "$VERSION" \
    ${UPDATER_FLAGS:+--ldflags "$UPDATER_FLAGS"} ${SKIP_FRONTEND_FLAG:+--skip-frontend} ${RELEASE_FLAG:+--release}
}

# sha256_of <file>: sha256sum on Linux and Git Bash, shasum on macOS.
sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | cut -d' ' -f1; else shasum -a 256 "$1" | cut -d' ' -f1; fi
}

# webview2_bootstrapper <dir>: writes MicrosoftEdgeWebview2Setup.exe into <dir> with `wails3 generate
# webview2bootstrapper` (the CLI embeds the copy that lives in the Wails v3 module, pinned by go.sum) and checks its
# SHA-256 against scripts/release/checksums.sha256. The installer bootstraps WebView2 with Microsoft's evergreen
# setup; the fwlink URL serves a file that changes with every Microsoft update and so cannot be pinned, the module copy can.
webview2_bootstrapper() {
  local dir="$1" want have
  mkdir -p "$dir"
  wails3 generate webview2bootstrapper -dir "$dir" >/dev/null
  [ -f "$dir/MicrosoftEdgeWebview2Setup.exe" ] || die "wails3 did not write the WebView2 bootstrapper into $dir"
  want="$(awk '$2 == "MicrosoftEdgeWebview2Setup.exe" { print $1 }' "$ROOT/scripts/release/checksums.sha256")"
  [ -n "$want" ] || die "scripts/release/checksums.sha256 has no line for MicrosoftEdgeWebview2Setup.exe"
  have="$(sha256_of "$dir/MicrosoftEdgeWebview2Setup.exe")"
  [ "$have" = "$want" ] || die "the WebView2 bootstrapper of the Wails module has SHA-256 $have, checksums.sha256 pins $want: check the new bootstrapper and update the pin"
}

case "$TARGET" in
  darwin)
    bin_build darwin universal
    bash "$ROOT/scripts/release/check-build-tags.sh" "$BIN_DIR/$NAME.app" ;;
  windows)
    need makensis
    "$ROOT/scripts/install-wails.sh" --check
    bin_build windows "$ARCH"
    EXE="$BIN_DIR/$OUTPUT.exe"
    [ -f "$EXE" ] || die "the build did not produce $EXE"
    bash "$ROOT/scripts/release/check-build-tags.sh" "$EXE"
    if [ -n "${MEMOBRAIN_SIGNTOOL_CMD:-}" ]; then
      # The command is a full signtool line with %1 for the file, as NSIS takes it.
      log "signing $EXE"
      bash -c "${MEMOBRAIN_SIGNTOOL_CMD//%1/$EXE}"
    else
      warn "MEMOBRAIN_SIGNTOOL_CMD not set: $OUTPUT.exe and its installer are UNSIGNED"
    fi
    # makensis is run here, not by a Wails command, so the exe is signed first. The installer sources are copied into
    # a temporary tree with the layout project.nsi expects (installer/, ../icon.ico, ../../bin) and wails_tools.nsh is
    # rendered there: the files of the repository are never rewritten.
    STAGE="$(mktemp -d)"
    trap 'rm -rf "$STAGE"' EXIT
    INST="$STAGE/windows/installer"
    mkdir -p "$INST" "$STAGE/bin"
    cp "$BUILD_DIR/windows/installer/project.nsi" "$INST/project.nsi"
    cp "$BUILD_DIR/windows/icon.ico" "$STAGE/windows/icon.ico"
    GOWORK=off go run "$RENDER" -project "$PROJECT" -version "$NUMERIC" -out "$INST/wails_tools.nsh" "$BUILD_DIR/windows/installer/wails_tools.nsh"
    webview2_bootstrapper "$INST/tmp"
    cp "$EXE" "$STAGE/bin/$OUTPUT.exe"
    upper="$(printf '%s' "$ARCH" | tr '[:lower:]' '[:upper:]')"
    INSTALLER="memobrain-$ARCH-installer.exe"
    rm -f "$BIN_DIR/$INSTALLER"
    (cd "$INST" && makensis -V2 "-DARG_WAILS_${upper}_BINARY=..\\..\\bin\\$OUTPUT.exe" project.nsi)
    [ -f "$STAGE/bin/$INSTALLER" ] || die "makensis did not produce $INSTALLER"
    mv "$STAGE/bin/$INSTALLER" "$BIN_DIR/$INSTALLER" ;;
  linux)
    bin_build linux "$ARCH"
    BIN="$BIN_DIR/$OUTPUT"
    [ -f "$BIN" ] || die "the build did not produce $BIN"
    bash "$ROOT/scripts/release/check-build-tags.sh" "$BIN"
    # The binary must link GTK3 and WebKit2GTK 4.1 (the .deb depends on them), not the GTK4 / WebKitGTK 6.0 default.
    if command -v ldd >/dev/null 2>&1; then
      libs="$(ldd "$BIN" 2>/dev/null || true)"
      case "$libs" in *libgtk-4*|*libwebkitgtk-6*) die "$BIN links GTK4/WebKitGTK 6.0: the build tag gtk3 is missing" ;; esac
      case "$libs" in *libwebkit2gtk-4.1*) ;; *) die "$BIN does not link libwebkit2gtk-4.1" ;; esac
    fi ;;
esac
ok "built $TARGET $VERSION in apps/desktop/build/bin"
ls -la "$BIN_DIR"
