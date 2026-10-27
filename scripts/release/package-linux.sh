#!/usr/bin/env bash
# Package the Linux binary as .deb (nfpm) and AppImage (appimagetool) (M7-WP3).
#
#   scripts/release/package-linux.sh <deb|appimage|all> <version>
#
# Input : apps/desktop/build/bin/nodus (scripts/release/build-desktop.sh linux <version>)
# Output: dist/nodus-<version>-linux-amd64.deb and dist/nodus-<version>-linux-amd64.AppImage
#
# Needs (Linux runner): nfpm for the deb, appimagetool (+ libfuse2 or --appimage-extract-and-run)
# for the AppImage. Neither the .deb nor the AppImage bundles WebKitGTK: both rely on the system
# libwebkit2gtk-4.1 (declared as a dependency of the deb). These scripts were NOT run on the
# macOS development machine; the first run is the release workflow / the cross-OS checklist.
# Signing: the AppImage and deb are not signed; integrity comes from SHA256SUMS, the signed
# update manifest and the cosign/GitHub attestation of the release assets.
set -euo pipefail
. "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/lib.sh"

KIND="${1:-}"; VERSION="${2:-}"
case "$KIND" in deb|appimage|all) ;; *) die "usage: $0 <deb|appimage|all> <version>" ;; esac
VERSION="${VERSION#v}"; [ -n "$VERSION" ] || die "version required"
ARCH="${ARCH:-amd64}"; GO_ARCH="$ARCH"
BIN="$ROOT/apps/desktop/build/bin/nodus"; LINUX="$ROOT/apps/desktop/build/linux"
[ -x "$BIN" ] || die "$BIN not found: run scripts/release/build-desktop.sh linux $VERSION first"
OUT="$ROOT/dist"; mkdir -p "$OUT"

STAGE="$(mktemp -d)"; trap 'rm -rf "$STAGE"' EXIT
cp "$BIN" "$STAGE/nodus"
cp "$LINUX/nodus.desktop" "$STAGE/nodus.desktop"
# Placeholder icon until the final artwork exists: the 1024 px appicon.png is used as it is.
cp "$ROOT/apps/desktop/build/appicon.png" "$STAGE/nodus.png"
sed -e "s/@VERSION@/$VERSION/" -e "s/@DATE@/$(date -u +%F)/" \
  "$LINUX/dev.nodus.desktop.metainfo.xml" > "$STAGE/dev.nodus.desktop.metainfo.xml"

if [ "$KIND" = deb ] || [ "$KIND" = all ]; then
  need nfpm
  log "Building the .deb"
  (cd "$ROOT" && VERSION="$VERSION" ARCH="$ARCH" STAGE="$STAGE" \
    nfpm package -p deb -f "$LINUX/nfpm.yaml" -t "$OUT/nodus-$VERSION-linux-$ARCH.deb")
fi

if [ "$KIND" = appimage ] || [ "$KIND" = all ]; then
  need appimagetool
  log "Building the AppImage"
  APPDIR="$STAGE/Nodus.AppDir"
  mkdir -p "$APPDIR/usr/bin" "$APPDIR/usr/share/metainfo"
  cp "$STAGE/nodus" "$APPDIR/usr/bin/nodus"
  cp "$STAGE/nodus.png" "$APPDIR/nodus.png"
  # Inside the AppImage Exec must be the bare command: AppRun puts usr/bin on PATH.
  cp "$STAGE/nodus.desktop" "$APPDIR/nodus.desktop"
  cp "$STAGE/dev.nodus.desktop.metainfo.xml" "$APPDIR/usr/share/metainfo/"
  cat > "$APPDIR/AppRun" <<'EOF'
#!/bin/sh
HERE="$(dirname "$(readlink -f "$0")")"
exec "$HERE/usr/bin/nodus" "$@"
EOF
  chmod +x "$APPDIR/AppRun"
  # $APPIMAGE (set by the runtime) tells the updater it can replace the file in place.
  AI_ARCH=x86_64; [ "$ARCH" = arm64 ] && AI_ARCH=aarch64
  ARCH="$AI_ARCH" appimagetool --appimage-extract-and-run "$APPDIR" "$OUT/nodus-$VERSION-linux-$GO_ARCH.AppImage"
fi
ok "packages in $OUT"
ls -la "$OUT"
