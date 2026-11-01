#!/usr/bin/env bash
# Run the desktop app together with the cloud services, for end-to-end checks
# and debugging of sign-in, sync and sharing: PostgreSQL + S3 + Keycloak in
# Docker, the cloud service as a local background process, and the desktop app.
#
#   scripts/run-desktop-with-cloud.sh                 stack + cloud + desktop (wails dev, hot reload)
#   scripts/run-desktop-with-cloud.sh --two-devices   stack + cloud + TWO desktop instances (built binary,
#                                                     separate data dirs) to simulate two devices
#   scripts/run-desktop-with-cloud.sh --cloud-only    stack + cloud, no desktop (use your own client)
#   scripts/run-desktop-with-cloud.sh --demo          seed a demo vault in each data dir
#   scripts/run-desktop-with-cloud.sh --reset-stack   destroy stack volumes first (re-imports the Keycloak realm)
#   scripts/run-desktop-with-cloud.sh --keep          leave the cloud and the stack running on exit
#
# On exit (Ctrl-C) the cloud process is stopped; add --keep to leave everything up,
# stop it later with scripts/dev-stop.sh. Server URL is prefilled in Settings → Cloud.
#
# Sign in with:  user1 / memobrain-dev-password   (also user2, and admin for the admin role)
# Logs: .dev/logs/cloud.log   .dev/with-cloud*/logs/memobrain.log   Keycloak admin: http://localhost:8080 (admin/admin)
set -euo pipefail
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib.sh"

TWO=0; CLOUD_ONLY=0; DEMO=0; RESET=0; KEEP=0
while [ $# -gt 0 ]; do
  case "$1" in
    --two-devices) TWO=1 ;;
    --cloud-only) CLOUD_ONLY=1 ;;
    --demo) DEMO=1 ;;
    --reset-stack) RESET=1 ;;
    --keep) KEEP=1 ;;
    -h|--help) sed -n '2,18p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) die "unknown option: $1 (see --help)" ;;
  esac
  shift
done

need curl
if [ "$CLOUD_ONLY" = 0 ]; then need wails; need node; need yarn; fi

cleanup() {
  trap - EXIT INT TERM
  [ -n "${DESKTOP_PIDS:-}" ] && kill $DESKTOP_PIDS 2>/dev/null || true
  if [ "$KEEP" = 1 ]; then
    log "Leaving cloud and stack running (stop with scripts/dev-stop.sh)"
  else
    cloud_stop
    log "Stack left running (scripts/dev-stop.sh --stack to stop it)"
  fi
}
trap cleanup EXIT INT TERM

if [ "$RESET" = 1 ]; then
  log "Resetting stack volumes"; compose down -v >/dev/null 2>&1 || true
fi
stack_up
cloud_start

echo
echo "  Cloud API       $CLOUD_URL/api/v1   (client config: $CLOUD_URL/api/v1/client-config)"
echo "  Keycloak        http://localhost:8080   admin / admin"
echo "  S3 console      http://localhost:9001   memobrain / memobrain-secret"
echo "  Sign in         user1 / memobrain-dev-password   (user2, admin)"
echo "  Cloud log       ${CLOUD_LOG#$ROOT/}"
echo

if [ "$CLOUD_ONLY" = 1 ]; then
  log "Cloud only: press Ctrl-C to stop"
  tail -n 0 -f "$CLOUD_LOG" & DESKTOP_PIDS=$!
  wait
  exit 0
fi

log "Installing frontend dependencies"
(cd "$ROOT" && run_quiet "yarn install" yarn install --immutable)

export MEMOBRAIN_DEFAULT_SERVER_URL="$CLOUD_URL"
DESKTOP_PIDS=""
if [ "$TWO" = 1 ]; then
  log "Building desktop (production) for two instances"
  (cd "$ROOT/apps/desktop" && run_quiet "desktop build" wails build -clean -nosyncgomod $WAILS_TAGS -ldflags "-X main.Version=dev-cloud")
  case "$(uname -s)" in
    Darwin) BIN="$(find "$ROOT/apps/desktop/build/bin" -maxdepth 1 -name '*.app' -type d | head -n 1)/Contents/MacOS/memobrain" ;;
    *) BIN="$ROOT/apps/desktop/build/bin/memobrain" ;;
  esac
  for n in 1 2; do
    d="$DEV_DIR/with-cloud-$n"; mkdir -p "$d/vaults"
    [ "$DEMO" = 1 ] && seed_demo_vault "$d/vaults/Demo"
    log "Starting device $n (data: ${d#$ROOT/})"
    MEMOBRAIN_DATA_DIR="$d" "$BIN" --log-level debug >/dev/null 2>&1 &
    DESKTOP_PIDS="$DESKTOP_PIDS $!"
  done
  log "Two devices running. Sign in with user1 on both; press Ctrl-C to stop"
  wait
else
  d="$DEV_DIR/with-cloud"; mkdir -p "$d/vaults"
  [ "$DEMO" = 1 ] && seed_demo_vault "$d/vaults/Demo"
  log "Starting desktop in dev mode (data: ${d#$ROOT/})"
  cd "$ROOT/apps/desktop"
  MEMOBRAIN_DATA_DIR="$d" wails dev -nosyncgomod $WAILS_TAGS
fi
