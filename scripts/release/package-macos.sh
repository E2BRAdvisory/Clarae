#!/usr/bin/env bash
# Turn the universal MemoBrain Notes.app into a (signed, notarised, stapled) .dmg (M7-WP3).
#
#   scripts/release/package-macos.sh <version> [--require-signing]
#
# Input : apps/desktop/build/bin/memobrain.app (scripts/release/build-desktop.sh darwin <version>)
# Output: dist/memobrain-<version>-darwin-universal.dmg
#
# Signing and notarisation run ONLY when their secrets are present; otherwise the dmg is built
# unsigned with a loud warning. With --require-signing (release workflow on a tag) missing
# secrets are an error.
#
#   APPLE_SIGNING_IDENTITY   "Developer ID Application: Name (TEAMID)" (certificate in the keychain)
#   Notarisation, one of:
#     NOTARY_KEYCHAIN_PROFILE            profile stored with `xcrun notarytool store-credentials`
#     APPLE_API_KEY_PATH + APPLE_API_KEY_ID + APPLE_API_ISSUER   App Store Connect API key (.p8)
#     APPLE_ID + APPLE_APP_PASSWORD + APPLE_TEAM_ID              Apple ID with app-specific password
set -euo pipefail
. "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/lib.sh"

VERSION="${1:-}"; REQUIRE="${2:-}"
[ -n "$VERSION" ] || die "usage: $0 <version> [--require-signing]"
VERSION="${VERSION#v}"
APP="$ROOT/apps/desktop/build/bin/memobrain.app"
ENTITLEMENTS="$ROOT/apps/desktop/build/darwin/entitlements.plist"
OUT_DIR="$ROOT/dist"; DMG="$OUT_DIR/memobrain-$VERSION-darwin-universal.dmg"
[ -d "$APP" ] || die "$APP not found: run scripts/release/build-desktop.sh darwin $VERSION first"
need hdiutil; need codesign; need xcrun
mkdir -p "$OUT_DIR"

SIGNED=0; NOTARISED=0
if [ -n "${APPLE_SIGNING_IDENTITY:-}" ]; then
  log "Signing $APP with '$APPLE_SIGNING_IDENTITY' (hardened runtime)"
  codesign --force --deep --options runtime --timestamp --entitlements "$ENTITLEMENTS" \
    --sign "$APPLE_SIGNING_IDENTITY" "$APP"
  codesign --verify --deep --strict --verbose=2 "$APP"
  SIGNED=1
elif [ "$REQUIRE" = "--require-signing" ]; then
  die "APPLE_SIGNING_IDENTITY is not set: refusing to produce an unsigned release (docs/release/secrets.md)"
else
  warn "APPLE_SIGNING_IDENTITY not set: the .app keeps Wails' ad-hoc signature; the dmg is NOT signed or notarised"
fi

STAGE="$(mktemp -d)"; trap 'rm -rf "$STAGE"' EXIT
cp -R "$APP" "$STAGE/MemoBrain Notes.app"
ln -s /Applications "$STAGE/Applications"
log "Creating $DMG"
rm -f "$DMG"
hdiutil create -volname "MemoBrain Notes $VERSION" -srcfolder "$STAGE" -fs HFS+ -format UDZO -ov "$DMG" >/dev/null

if [ "$SIGNED" = 1 ]; then
  codesign --force --timestamp --sign "$APPLE_SIGNING_IDENTITY" "$DMG"
  notary_args=()
  if [ -n "${NOTARY_KEYCHAIN_PROFILE:-}" ]; then
    notary_args=(--keychain-profile "$NOTARY_KEYCHAIN_PROFILE")
  elif [ -n "${APPLE_API_KEY_PATH:-}" ] && [ -n "${APPLE_API_KEY_ID:-}" ] && [ -n "${APPLE_API_ISSUER:-}" ]; then
    notary_args=(--key "$APPLE_API_KEY_PATH" --key-id "$APPLE_API_KEY_ID" --issuer "$APPLE_API_ISSUER")
  elif [ -n "${APPLE_ID:-}" ] && [ -n "${APPLE_APP_PASSWORD:-}" ] && [ -n "${APPLE_TEAM_ID:-}" ]; then
    notary_args=(--apple-id "$APPLE_ID" --password "$APPLE_APP_PASSWORD" --team-id "$APPLE_TEAM_ID")
  fi
  if [ "${#notary_args[@]}" -gt 0 ]; then
    log "Submitting to the Apple notary service (waits for the verdict)"
    xcrun notarytool submit "$DMG" "${notary_args[@]}" --wait
    xcrun stapler staple "$DMG"
    xcrun stapler validate "$DMG"
    NOTARISED=1
  elif [ "$REQUIRE" = "--require-signing" ]; then
    die "no notarisation credentials (NOTARY_KEYCHAIN_PROFILE | APPLE_API_* | APPLE_ID/APPLE_APP_PASSWORD/APPLE_TEAM_ID)"
  else
    warn "no notarisation credentials: the dmg is signed but NOT notarised (Gatekeeper will warn)"
  fi
fi
ok "$DMG ($(du -h "$DMG" | cut -f1)); signed=$SIGNED notarised=$NOTARISED"
