#!/usr/bin/env bash
# Stop what scripts/run-desktop-with-cloud.sh --keep left running.
#
#   scripts/dev-stop.sh            stop the cloud process
#   scripts/dev-stop.sh --stack    also stop the Docker stack (data kept)
#   scripts/dev-stop.sh --purge    also delete stack volumes and .dev/ (data dirs, logs)
set -euo pipefail
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib.sh"

STACK=0; PURGE=0
for a in "$@"; do
  case "$a" in
    --stack) STACK=1 ;;
    --purge) STACK=1; PURGE=1 ;;
    -h|--help) sed -n '2,7p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) die "unknown option: $a" ;;
  esac
done

cloud_stop
if [ "$PURGE" = 1 ]; then
  log "Removing stack volumes and ${DEV_DIR#$ROOT/}"
  compose down -v >/dev/null 2>&1 || true
  rm -rf "$DEV_DIR"
elif [ "$STACK" = 1 ]; then
  log "Stopping stack"; stack_down
fi
ok "done"
