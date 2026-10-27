#!/usr/bin/env bash
# Shared helpers for the dev scripts. Source it; do not execute it.

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEV_DIR="${MEMOBRAIN_DEV_DIR:-$ROOT/.dev}"        # git-ignored scratch area: data dirs, logs, pids, binaries
COMPOSE_FILE="$ROOT/deploy/docker/compose.dev.yaml"
CLOUD_ENV="$ROOT/deploy/docker/cloud.dev.env"
CLOUD_PID="$DEV_DIR/cloud.pid"
CLOUD_LOG="$DEV_DIR/logs/cloud.log"
CLOUD_BIN="$DEV_DIR/bin/memobrain-cloud"
CLOUD_URL="http://127.0.0.1:18081"

if [ -t 1 ]; then
  C_BOLD=$'\033[1m'; C_DIM=$'\033[2m'; C_RED=$'\033[31m'; C_GREEN=$'\033[32m'; C_YELLOW=$'\033[33m'; C_OFF=$'\033[0m'
else
  C_BOLD=""; C_DIM=""; C_RED=""; C_GREEN=""; C_YELLOW=""; C_OFF=""
fi

log()  { printf '%s==>%s %s\n' "$C_BOLD" "$C_OFF" "$*"; }
ok()   { printf '%s ok%s %s\n' "$C_GREEN" "$C_OFF" "$*"; }
warn() { printf '%swarn%s %s\n' "$C_YELLOW" "$C_OFF" "$*" >&2; }
die()  { printf '%serror%s %s\n' "$C_RED" "$C_OFF" "$*" >&2; exit 1; }

need() { command -v "$1" >/dev/null 2>&1 || die "'$1' not found in PATH. See docs/dev-setup.md"; }

compose() { docker compose -f "$COMPOSE_FILE" "$@"; }

# stack_up starts PostgreSQL, S3 and Keycloak and waits until they are healthy.
stack_up() {
  need docker
  docker info >/dev/null 2>&1 || die "Docker is not running"
  log "Starting dev stack (PostgreSQL :5433, S3 :9000, Keycloak :8080)"
  local out; out="$(mktemp)"
  if ! compose up -d --wait >"$out" 2>&1; then
    cat "$out" >&2; rm -f "$out"
    die "stack failed to start (details above; logs: make stack-logs)"
  fi
  rm -f "$out"
  ok "stack is healthy"
}

stack_down() { compose down >/dev/null 2>&1 || true; }

# cloud_running prints nothing; returns 0 when our cloud process is alive.
cloud_running() {
  [ -f "$CLOUD_PID" ] && kill -0 "$(cat "$CLOUD_PID")" 2>/dev/null
}

cloud_ready() { curl -fsS "$CLOUD_URL/api/v1/readyz" >/dev/null 2>&1; }

# cloud_start builds the cloud binary and runs it in the background.
cloud_start() {
  need go
  mkdir -p "$DEV_DIR/bin" "$DEV_DIR/logs"
  if cloud_running; then ok "cloud already running (pid $(cat "$CLOUD_PID"))"; return; fi
  if cloud_ready; then
    die "something else already answers on $CLOUD_URL (not started by these scripts). Stop it first."
  fi
  log "Building cloud service"
  (cd "$ROOT/services/cloud" && go build -o "$CLOUD_BIN" ./cmd/memobrain-cloud) || die "cloud build failed"
  log "Starting cloud service (log: ${CLOUD_LOG#$ROOT/})"
  (
    set -a; . "$CLOUD_ENV"; set +a
    exec "$CLOUD_BIN" --role=all
  ) >"$CLOUD_LOG" 2>&1 &
  echo $! >"$CLOUD_PID"
  for _ in $(seq 1 60); do
    cloud_ready && { ok "cloud is ready at $CLOUD_URL"; return; }
    cloud_running || { tail -n 20 "$CLOUD_LOG" >&2; die "cloud exited during startup"; }
    sleep 1
  done
  tail -n 20 "$CLOUD_LOG" >&2
  die "cloud did not become ready in 60 s"
}

cloud_stop() {
  if cloud_running; then
    local pid; pid="$(cat "$CLOUD_PID")"
    kill "$pid" 2>/dev/null || true
    for _ in $(seq 1 20); do kill -0 "$pid" 2>/dev/null || break; sleep 0.25; done
    kill -9 "$pid" 2>/dev/null || true
    ok "cloud stopped"
  fi
  rm -f "$CLOUD_PID"
}

# seed_demo_vault DIR creates a small vault exercising links, tags, properties and tasks.
seed_demo_vault() {
  local dir="$1"
  if [ -e "$dir/Welcome.md" ]; then return; fi
  mkdir -p "$dir/Projects" "$dir/Journal"
  cat >"$dir/Welcome.md" <<'MD'
# Welcome to MemoBrain Notes

This demo vault is for checks and debugging. Try these:

- Follow links: [[Projects/Roadmap]], [[Journal/2026-10-24]], [[Missing note]] (an unresolved "ghost" link)
- Search for `tag:#demo`, `[status:active]`, `task-todo:review`, `/ro+adma?p/`
- Rename `Projects/Roadmap.md` and watch the links in other notes update
- Open the Backlinks panel under a note

#demo
MD
  cat >"$dir/Projects/Roadmap.md" <<'MD'
---
status: active
due: 2026-12-01
aliases: [Plan, Product roadmap]
tags: [demo, planning]
---
# Roadmap

Back to [[Welcome]]. See also [[Journal/2026-10-24#Notes|today's notes]].

- [ ] review the sync design
- [x] write the spec
- [ ] ship M1
MD
  cat >"$dir/Journal/2026-10-24.md" <<'MD'
# 2026-10-24

## Notes
Talked about the Roadmap and the Product roadmap alias. #demo/journal

## Tasks
- [ ] review search results
MD
  ok "demo vault created in $dir"
}

# run_quiet LABEL CMD... runs a command with its output captured; the output
# is shown only if the command fails.
run_quiet() {
  local label="$1"; shift
  local out; out="$(mktemp)"
  if ! "$@" >"$out" 2>&1; then
    sed 's/\x1b\[[0-9;]*m//g' "$out" | grep -vE 'KnownStructs|Not found: time.Time' >&2
    rm -f "$out"
    die "$label failed (output above)"
  fi
  rm -f "$out"
}
