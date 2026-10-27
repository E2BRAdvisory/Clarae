#!/usr/bin/env bash
# Run the desktop app standalone: no cloud, no Docker. Useful to check the
# editor, vault handling, indexing and search offline (local-first mode).
#
#   scripts/run-desktop.sh                 hot-reload dev mode (wails dev)
#   scripts/run-desktop.sh --build         production build, then run the binary
#   scripts/run-desktop.sh --demo          also create and open nothing, but seed a demo vault
#                                          in .dev/standalone/vaults/Demo (open it from the app)
#   scripts/run-desktop.sh --data-dir DIR  use another application data directory
#   scripts/run-desktop.sh --fresh         wipe the standalone data directory first
#
# State lives under .dev/standalone (git-ignored): app.db, logs/memobrain.log, vaults/.
set -euo pipefail
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib.sh"

BUILD=0; DEMO=0; FRESH=0
DATA_DIR="$DEV_DIR/standalone"
while [ $# -gt 0 ]; do
  case "$1" in
    --build) BUILD=1 ;;
    --demo) DEMO=1 ;;
    --fresh) FRESH=1 ;;
    --data-dir) shift; DATA_DIR="${1:?--data-dir needs a path}" ;;
    -h|--help) sed -n '2,13p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) die "unknown option: $1 (see --help)" ;;
  esac
  shift
done

need wails; need node; need yarn
[ "$FRESH" = 1 ] && { log "Removing $DATA_DIR"; rm -rf "$DATA_DIR"; }
mkdir -p "$DATA_DIR/vaults"
[ "$DEMO" = 1 ] && seed_demo_vault "$DATA_DIR/vaults/Demo"

log "Standalone desktop (data: ${DATA_DIR#$ROOT/}, log: ${DATA_DIR#$ROOT/}/logs/memobrain.log)"
log "Installing frontend dependencies"
(cd "$ROOT" && run_quiet "yarn install" yarn install --immutable)

export MEMOBRAIN_DATA_DIR="$DATA_DIR"
unset MEMOBRAIN_DEFAULT_SERVER_URL
if [ "$BUILD" = 1 ]; then
  log "Building (production)"
  (cd "$ROOT/apps/desktop" && run_quiet "desktop build" wails build -clean -ldflags "-X main.Version=dev-standalone")
  case "$(uname -s)" in
    Darwin) exec "$ROOT/apps/desktop/build/bin/memobrain.app/Contents/MacOS/memobrain" ;;
    *) exec "$ROOT/apps/desktop/build/bin/memobrain" ;;
  esac
else
  cd "$ROOT/apps/desktop" && exec wails dev
fi
