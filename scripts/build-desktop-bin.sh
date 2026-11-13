#!/usr/bin/env bash
# Builds the desktop app (Wails v3) with plain `go build`, without `wails3 build` (ADR-0051, B-D9): the frontend
# first, then the binary with the tags and linker flags of a release. The output goes where the packaging
# scripts look for it, apps/desktop/build/bin:
#
#   darwin   "Clarae notanda.app" (universal by default: one build per architecture + lipo, ad-hoc signed)
#   linux    clarae                 (-tags production,gtk3: GTK3 + WebKit2GTK 4.1)
#   windows  clarae.exe             (-H windowsgui, icon/manifest/version info from `wails3 generate syso`)
#
#   scripts/build-desktop-bin.sh [--os darwin|windows|linux] [--arch amd64|arm64|universal] [--version V]
#                                [--ldflags "-X pkg.Var=value ..."] [--skip-frontend] [--release]
#   scripts/build-desktop-bin.sh --dev        Go binary only, without the production tag, for the dev watcher
#                                             (build/config.yml); the UI comes from the esbuild server
#   scripts/build-desktop-bin.sh --run-dev    run the binary that --dev built
#
# --version is stamped into the binary (-X main.Version, shown in About and used by the updater), the macOS
# Info.plist and the Windows version resources (only its MAJOR.MINOR.PATCH there; anything else is 0.0.0).
# The updater flags (-X <updater>.PublicKeyB64 / ManifestBaseURL / DisabledByBuild) are passed with --ldflags or
# LDFLAGS_EXTRA: scripts/release/build-desktop.sh decides them and refuses a release without the production key.
# --release is for a build that is shipped: it refuses the build switches of the frontend in the environment
# (CLARAE_AI, CLARAE_COLLAB, CLARAE_E2E) and CLARAE_DIST (the UI would be built
# where Go does not embed it from): release/check-editor-switches.sh. It always builds the frontend (no --skip-frontend,
# no --dev) and checks that neither the collaboration code nor the binding mock of the e2e tests is in what it built, and that
# the Milkdown editor is (release/check-dist.sh).
# Defaults: the host OS, the host architecture (universal on macOS), version from `git describe`.
#
# The product data (name, bundle id, URL scheme) is apps/desktop/build/project.json; the templates it fills are
# build/darwin/Info*.plist and build/windows/info.json. The CLI wails3 is needed only for the Windows resources.
set -euo pipefail
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib.sh"

DESKTOP="$ROOT/apps/desktop"
BUILD_DIR="$DESKTOP/build"
BIN_DIR="$BUILD_DIR/bin"
PROJECT="$BUILD_DIR/project.json"
RENDER="$ROOT/scripts/release/render-assets.go"

TARGET_OS=""; ARCH=""; VERSION=""; SKIP_FRONTEND=0; DEV=0; RUN_DEV=0; RELEASE=0
LDFLAGS_EXTRA="${LDFLAGS_EXTRA:-}"
while [ $# -gt 0 ]; do
  case "$1" in
    --os) shift; TARGET_OS="${1:?--os needs darwin, windows or linux}" ;;
    --arch) shift; ARCH="${1:?--arch needs amd64, arm64 or universal}" ;;
    --version) shift; VERSION="${1:?--version needs a value}" ;;
    --ldflags) shift; LDFLAGS_EXTRA="${LDFLAGS_EXTRA:+$LDFLAGS_EXTRA }${1:?--ldflags needs a value}" ;;
    --skip-frontend) SKIP_FRONTEND=1 ;;
    --dev) DEV=1 ;;
    --release) RELEASE=1 ;;
    --run-dev) RUN_DEV=1 ;;
    -h|--help) sed -n '2,/^set -euo/p' "$0" | sed '$d' | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) die "unknown option: $1 (see --help)" ;;
  esac
  shift
done

if [ "$RELEASE" = 1 ]; then
  [ "$DEV" = 0 ] && [ "$RUN_DEV" = 0 ] || die "--release cannot be combined with --dev or --run-dev"
  [ "$SKIP_FRONTEND" = 0 ] || die "--skip-frontend is not allowed with --release: a release always builds the UI"
  # Before anything is built: a variable exported in this shell would be read by the esbuild script of the frontend.
  sh "$ROOT/scripts/release/check-editor-switches.sh"
fi

host_os() {
  case "$(uname -s)" in
    Darwin) echo darwin ;;
    Linux) echo linux ;;
    MINGW*|MSYS*|CYGWIN*) echo windows ;;
    *) die "unsupported host: $(uname -s)" ;;
  esac
}
[ -n "$TARGET_OS" ] || TARGET_OS="$(host_os)"
case "$TARGET_OS" in darwin|windows|linux) ;; *) die "--os must be darwin, windows or linux, got '$TARGET_OS'" ;; esac

need go
HOST_ARCH="$(go env GOARCH)"
if [ -z "$ARCH" ]; then
  if [ "$TARGET_OS" = darwin ] && [ "$DEV" = 0 ]; then ARCH=universal; else ARCH="$HOST_ARCH"; fi
fi
case "$ARCH" in
  amd64|arm64) ;;
  universal) [ "$TARGET_OS" = darwin ] || die "--arch universal is for darwin only" ;;
  *) die "--arch must be amd64, arm64 or universal (darwin only), got '$ARCH'" ;;
esac

NAME="$(GOWORK=off go run "$RENDER" -project "$PROJECT" -field name)"
OUTPUT="$(GOWORK=off go run "$RENDER" -project "$PROJECT" -field outputfilename)"
[ -n "$NAME" ] && [ -n "$OUTPUT" ] || die "$PROJECT has no name or outputfilename"
APP="$BIN_DIR/$NAME.app"
DEV_APP="$BIN_DIR/$OUTPUT.dev.app"
DEV_BIN="$BIN_DIR/$OUTPUT-dev"
[ "$TARGET_OS" = windows ] && DEV_BIN="$DEV_BIN.exe"

if [ "$RUN_DEV" = 1 ]; then
  if [ "$TARGET_OS" = darwin ]; then exec "$DEV_APP/Contents/MacOS/$OUTPUT"; fi
  exec "$DEV_BIN"
fi

if [ -z "$VERSION" ]; then
  VERSION="$(git -C "$ROOT" describe --tags --always --dirty 2>/dev/null || echo dev)"
fi
VERSION="${VERSION#v}"
# Windows and macOS version resources take MAJOR.MINOR.PATCH only.
NUMERIC="$(printf '%s' "$VERSION" | sed -nE 's/^([0-9]+\.[0-9]+\.[0-9]+).*/\1/p')"
NUMERIC="${NUMERIC:-0.0.0}"

# ---- tags and linker flags --------------------------------------------------------------------------------------

# "production" is ours to pass (the strict CSP of csp_prod.go, no dev tooling); the binary must never carry the
# tags mcp, server or devtools (internal/shell/buildtags.go): they are not set here and the app refuses to start with them.
TAGS="production"
[ "$TARGET_OS" = linux ] && TAGS="$TAGS,gtk3"
LDFLAGS="-s -w -X main.Version=$VERSION"
[ "$TARGET_OS" = windows ] && LDFLAGS="$LDFLAGS -H windowsgui"
[ -n "$LDFLAGS_EXTRA" ] && LDFLAGS="$LDFLAGS $LDFLAGS_EXTRA"
if [ "$DEV" = 1 ]; then
  # Without "production" the app uses the relaxed CSP of the dev server and the dev logging of Wails.
  TAGS=""
  [ "$TARGET_OS" = linux ] && TAGS="gtk3"
  # main.Version must be exactly "dev": the updater stays off ("development build") and the log goes to the console
  # (main.go). The git-describe VERSION above is for the Info.plist and the log line only.
  LDFLAGS="-X main.Version=dev"
  [ -n "$LDFLAGS_EXTRA" ] && LDFLAGS="$LDFLAGS $LDFLAGS_EXTRA"
fi

# ---- frontend ---------------------------------------------------------------------------------------------------

DIST="$DESKTOP/frontend/dist"
if [ "$DEV" = 1 ]; then
  # go:embed needs a dist/ with something in it; the UI itself is served by the esbuild server.
  # The watcher starts this step only when the esbuild server answers 200 on / (readiness in build/config.yml), that
  # is once dist/index.html is written; the placeholder is for a standalone --dev run. A size check would race esbuild.
  mkdir -p "$DIST"
  [ -e "$DIST/index.html" ] || touch "$DIST/index.html"
elif [ "$SKIP_FRONTEND" = 0 ]; then
  need node; need yarn
  if [ ! -d "$ROOT/node_modules" ]; then
    log "Installing frontend dependencies"
    (cd "$ROOT" && yarn install --immutable)
  fi
  # The UI imports the Wails bindings, which the repository does not hold (a fresh checkout has none): they are
  # written from the Go API every time, so the UI never builds against a stale copy (Taskfile gen-wails).
  log "Generating the Wails bindings"
  (cd "$DESKTOP" && go run ./internal/app/gen/bindings)
  log "Building the frontend"
  (cd "$ROOT" && yarn workspace @clarae/desktop-frontend run build)
fi
if [ "$DEV" = 0 ]; then
  [ -s "$DIST/index.html" ] || die "$DIST has no index.html: build the frontend (omit --skip-frontend)"
fi
# What a release carries is the default build: AI, collaboration and the binding mock only come from the switches checked above.
[ "$RELEASE" = 0 ] || sh "$ROOT/scripts/release/check-dist.sh" "$DIST"


# ---- go build ---------------------------------------------------------------------------------------------------

# gobuild <goarch> <output>: one binary for TARGET_OS/<goarch>.
gobuild() {
  local goarch="$1" out="$2"
  local -a flags=(-trimpath -buildvcs=false -ldflags "$LDFLAGS")
  [ "$DEV" = 1 ] && flags=(-buildvcs=false -ldflags "$LDFLAGS")
  [ -n "$TAGS" ] && flags+=(-tags "$TAGS")
  case "$TARGET_OS" in
    darwin)
      # Deployment target = the minimum of Go 1.27 itself: its runtime objects are built for macOS 13 (the Wails v3
      # templates say 12, which only makes the linker warn). The framework UniformTypeIdentifiers, which the v2 CLI
      # added by hand, is linked by the library itself (dialogs_darwin.go): nothing to add here.
      (cd "$DESKTOP" && GOOS=darwin GOARCH="$goarch" CGO_ENABLED=1 MACOSX_DEPLOYMENT_TARGET=13.0 \
        CGO_CFLAGS="-mmacosx-version-min=13.0" CGO_LDFLAGS="-mmacosx-version-min=13.0" go build "${flags[@]}" -o "$out" .) ;;
    windows)
      # The WebView2 binding needs no cgo, so this cross-compiles from any host.
      (cd "$DESKTOP" && GOOS=windows GOARCH="$goarch" CGO_ENABLED=0 go build "${flags[@]}" -o "$out" .) ;;
    linux)
      # WebKitGTK is cgo: the architecture is the host's.
      [ "$goarch" = "$HOST_ARCH" ] || die "linux/$goarch needs a $goarch host (cgo)"
      (cd "$DESKTOP" && GOOS=linux GOARCH="$goarch" CGO_ENABLED=1 go build "${flags[@]}" -o "$out" .) ;;
  esac
}

mkdir -p "$BIN_DIR"
STAGE="$(mktemp -d)"
SYSO=""
cleanup() { rm -rf "$STAGE"; [ -z "$SYSO" ] || rm -f "$SYSO"; }
trap cleanup EXIT

# windows_resources writes apps/desktop/rsrc_windows_<arch>.syso: the linker adds it to the exe (icon, manifest,
# version info). Removed on exit.
windows_resources() {
  local goarch="$1"
  "$ROOT/scripts/install-wails.sh" --check
  GOWORK=off go run "$RENDER" -project "$PROJECT" -version "$NUMERIC" -out "$STAGE/info.json" "$BUILD_DIR/windows/info.json"
  # The manifest is a template too ({{.Name}}, {{.Info.ProductVersion}}): the loader refuses an exe whose
  # assemblyIdentity is not a valid name and a four-part version, so it is rendered like info.json.
  GOWORK=off go run "$RENDER" -project "$PROJECT" -version "$NUMERIC" -out "$STAGE/wails.exe.manifest" "$BUILD_DIR/windows/wails.exe.manifest"
  SYSO="$DESKTOP/rsrc_windows_${goarch}.syso"
  (cd "$DESKTOP" && wails3 generate syso -arch "$goarch" -icon build/windows/icon.ico \
    -manifest "$STAGE/wails.exe.manifest" -info "$STAGE/info.json" -out "$SYSO")
}

# macos_bundle <binary> <bundle> <plist template>: the .app around the binary, signed ad hoc (the packaging
# script signs it for real when it has an identity).
macos_bundle() {
  local bin="$1" bundle="$2" template="$3"
  rm -rf "$bundle"
  mkdir -p "$bundle/Contents/MacOS" "$bundle/Contents/Resources"
  cp "$bin" "$bundle/Contents/MacOS/$OUTPUT"
  GOWORK=off go run "$RENDER" -project "$PROJECT" -version "$NUMERIC" -out "$bundle/Contents/Info.plist" "$template"
  # CFBundleIconFile is "iconfile": the name Wails v2 gave the icon in Resources.
  cp "$BUILD_DIR/darwin/icon.icns" "$bundle/Contents/Resources/iconfile.icns"
  xattr -cr "$bundle"
  codesign --force --deep --sign - "$bundle"
  codesign --verify --deep --strict "$bundle"
}

log "Go build: $TARGET_OS/$ARCH, version $VERSION${TAGS:+, tags $TAGS}"
case "$TARGET_OS" in
  darwin)
    need codesign; need xattr
    if [ "$DEV" = 1 ]; then
      gobuild "$ARCH" "$STAGE/$OUTPUT"
      macos_bundle "$STAGE/$OUTPUT" "$DEV_APP" "$BUILD_DIR/darwin/Info.dev.plist"
      RESULT="$DEV_APP"
    else
      if [ "$ARCH" = universal ]; then
        need lipo
        gobuild arm64 "$STAGE/$OUTPUT-arm64"
        gobuild amd64 "$STAGE/$OUTPUT-amd64"
        lipo -create -output "$STAGE/$OUTPUT" "$STAGE/$OUTPUT-arm64" "$STAGE/$OUTPUT-amd64"
      else
        gobuild "$ARCH" "$STAGE/$OUTPUT"
      fi
      macos_bundle "$STAGE/$OUTPUT" "$APP" "$BUILD_DIR/darwin/Info.plist"
      RESULT="$APP"
    fi ;;
  windows)
    goarch="$ARCH"
    windows_resources "$goarch"
    if [ "$DEV" = 1 ]; then RESULT="$DEV_BIN"; else RESULT="$BIN_DIR/$OUTPUT.exe"; fi
    gobuild "$goarch" "$STAGE/out.exe"
    mv "$STAGE/out.exe" "$RESULT" ;;
  linux)
    if [ "$DEV" = 1 ]; then RESULT="$DEV_BIN"; else RESULT="$BIN_DIR/$OUTPUT"; fi
    gobuild "$ARCH" "$STAGE/out"
    mv "$STAGE/out" "$RESULT" ;;
esac
ok "built ${RESULT#$ROOT/}"
