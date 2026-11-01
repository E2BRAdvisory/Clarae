#!/usr/bin/env bash
# Mixed-client e2e suite (P7 of the W8 review): a headless desktop device (apps/desktop/cmd/e2e-device,
# the real desktop core) and the web workbench in Chromium (Playwright) against the same cloud.
#
# Everything runs on a throwaway stack of its own, never on the development one:
#   docker compose project memobrain-w8e2e (deploy/docker/compose.e2e-mixed.yaml over compose.dev.yaml):
#   PostgreSQL :5434, S3 :9010/:9011, Keycloak :8080 (management :9012), cloud :18091 (gRPC :18092).
# A local k3d cluster on :9000/:18080-18082 and the memobrain-dev volumes are left alone.
#
# Usage: scripts/e2e-mixed.sh [all|up|build|cloud|test|down] [playwright args...]
#   all (default)  up, build, cloud, test, then down (volumes removed) unless KEEP=1
#   up             stack only          build   web build + cloud binary + device binary
#   cloud          start the cloud     test    run the specs (web/e2e-mixed)
#   down           stop the cloud, remove the stack and its volumes
# Environment: KEEP=1 keeps the stack after `all`; SKIP_BUILD=1 reuses the binaries of a previous build.
set -euo pipefail
. "$(dirname "$0")/lib.sh"

PROJECT=memobrain-w8e2e
WORK="$DEV_DIR/e2e-mixed"
REALM_DIR="$WORK/realm"
BIN="$WORK/bin"
LOGS="$WORK/logs"
PID="$WORK/cloud.pid"
URL="http://localhost:18091"
mkdir -p "$WORK" "$BIN" "$LOGS"

mixed() {
  E2E_MIXED_REALM_DIR="$REALM_DIR" docker compose -p "$PROJECT" \
    -f "$ROOT/deploy/docker/compose.dev.yaml" -f "$ROOT/deploy/docker/compose.e2e-mixed.yaml" "$@"
}

# The dev realm, plus the cloud's test origin on memobrain-web and the password grant on
# memobrain-desktop (the headless device signs in with it). Only this copy is changed.
write_realm() {
  mkdir -p "$REALM_DIR"
  node - "$ROOT/deploy/keycloak/realm-memobrain.json" "$REALM_DIR/realm-memobrain.json" "$URL" <<'JS'
const fs = require('node:fs');
const [src, dst, origin] = process.argv.slice(2);
const realm = JSON.parse(fs.readFileSync(src, 'utf8'));
for (const c of realm.clients) {
  if (c.clientId === 'memobrain-web') {
    c.redirectUris = [...new Set([...(c.redirectUris ?? []), `${origin}/*`])];
    c.webOrigins = [...new Set([...(c.webOrigins ?? []), origin])];
    const post = c.attributes?.['post.logout.redirect.uris'];
    if (post !== undefined) c.attributes['post.logout.redirect.uris'] = `${post}##${origin}/*`;
  }
  if (c.clientId === 'memobrain-desktop') c.directAccessGrantsEnabled = true;
}
fs.writeFileSync(dst, JSON.stringify(realm, null, 2));
JS
}

up() {
  need docker
  docker info >/dev/null 2>&1 || die "Docker is not running"
  write_realm
  log "Starting the throwaway stack $PROJECT (PostgreSQL :5434, S3 :9010, Keycloak :8080)"
  mixed up -d --wait >"$LOGS/compose.log" 2>&1 || { cat "$LOGS/compose.log" >&2; die "stack failed to start"; }
  ok "stack is healthy"
}

# build makes the three binaries without touching the shared outputs (build/wasm, web/dist,
# services/cloud/web-embed/dist, which other builds and suites use): the core and the web UI are
# built under .dev/e2e-mixed, and the cloud in a copy of its module with that web UI embedded.
build() {
  need go
  need node
  need rsync
  local out="$WORK/build" src="$WORK/src"
  mkdir -p "$out"
  log "Building the WebAssembly core"
  (cd "$ROOT/apps/desktop" && GOOS=js GOARCH=wasm go build -trimpath -ldflags "-s -w -X main.Version=e2e" \
    -o "$out/memobrain-core.wasm" ./cmd/memobrain-core) || die "core build failed"
  [ -d "$ROOT/packages/workbench/wailsjs/go" ] || run_quiet "wailsjs" task -d "$ROOT" wailsjs
  log "Building the web UI (production bundle, core embedded)"
  rm -rf "$out/web"
  (cd "$ROOT/web" && MEMOBRAIN_VERSION=e2e MEMOBRAIN_CORE_WASM="$out/memobrain-core.wasm" \
    MEMOBRAIN_DIST="$(python3 -c 'import os,sys; print(os.path.relpath(sys.argv[1], sys.argv[2]))' "$out/web" "$ROOT/web")" \
    node scripts/esbuild.mjs build) >"$LOGS/web-build.log" 2>&1 || {
    # The bundle budget (ADR-0020) is enforced by the web build itself; the suite still runs.
    if grep -q 'Bundle budget exceeded' "$LOGS/web-build.log" && [ -f "$out/web/workbench.html" ]; then
      warn "web build: bundle budget exceeded ($(grep -E '^Bundle (console|workbench)' "$LOGS/web-build.log" | tr '\n' ' ')); the suite runs anyway"
    else
      tail -n 30 "$LOGS/web-build.log" >&2; die "web build failed"
    fi
  }
  log "Building the cloud binary (web UI embedded, in a copy of the module)"
  rm -rf "$src" && mkdir -p "$src/apps/desktop" "$src/services" "$src/shared"
  cp "$ROOT/go.work" "$ROOT/go.work.sum" "$src/"
  cp "$ROOT/apps/desktop/go.mod" "$ROOT/apps/desktop/go.sum" "$src/apps/desktop/"
  rsync -a "$ROOT/shared/go" "$src/shared/"
  rsync -a --exclude 'web-embed/dist/' "$ROOT/services/cloud" "$src/services/"
  mkdir -p "$src/services/cloud/web-embed/dist" && cp -R "$out/web/." "$src/services/cloud/web-embed/dist/"
  (cd "$src/services/cloud" && CGO_ENABLED=0 go build -trimpath -o "$BIN/memobrain-cloud" ./cmd/memobrain-cloud) || die "cloud build failed"
  log "Building the headless desktop device (apps/desktop/cmd/e2e-device)"
  (cd "$ROOT/apps/desktop" && go build -tags e2e -o "$BIN/e2e-device" ./cmd/e2e-device) || die "device build failed"
  ok "binaries in ${BIN#$ROOT/}"
}

cloud_up() {
  [ -x "$BIN/memobrain-cloud" ] || die "no cloud binary: run '$0 build'"
  if [ -f "$PID" ] && kill -0 "$(cat "$PID")" 2>/dev/null; then ok "cloud already running"; return; fi
  curl -fsS "$URL/api/v1/readyz" >/dev/null 2>&1 && die "something else answers on $URL"
  log "Starting the cloud on $URL (log: ${LOGS#$ROOT/}/cloud.log)"
  (
    set -a; . "$CLOUD_ENV"; set +a
    export LISTEN_ADDR=127.0.0.1:18091 GRPC_LISTEN_ADDR=127.0.0.1:18092 METRICS_LISTEN_ADDR=127.0.0.1:18093
    export DATABASE_URL='postgres://memobrain:memobrain@127.0.0.1:5434/memobrain?sslmode=disable'
    export S3_ENDPOINT=http://127.0.0.1:9010 WEB_UI_ORIGIN="$URL" LOG_LEVEL=info
    exec "$BIN/memobrain-cloud" --role=all
  ) >"$LOGS/cloud.log" 2>&1 &
  echo $! >"$PID"
  for _ in $(seq 1 60); do
    curl -fsS "$URL/api/v1/readyz" >/dev/null 2>&1 && { ok "cloud is ready"; return; }
    kill -0 "$(cat "$PID")" 2>/dev/null || { tail -n 30 "$LOGS/cloud.log" >&2; die "cloud exited during startup"; }
    sleep 1
  done
  tail -n 30 "$LOGS/cloud.log" >&2
  die "cloud did not become ready in 60 s"
}

cloud_down() {
  if [ -f "$PID" ]; then
    kill "$(cat "$PID")" 2>/dev/null || true
    rm -f "$PID"
  fi
}

run_tests() {
  [ -x "$BIN/e2e-device" ] || die "no device binary: run '$0 build'"
  log "Running web/e2e-mixed"
  MEMOBRAIN_CLOUD_URL="$URL" MEMOBRAIN_E2E_DEVICE="$BIN/e2e-device" MEMOBRAIN_E2E_DEVICE_DATA="$WORK/devices" \
    yarn --cwd "$ROOT" workspace @memobrain/web exec playwright test -c playwright.mixed.config.ts "$@"
}

down() {
  cloud_down
  log "Removing the throwaway stack $PROJECT and its volumes"
  mixed down -v --remove-orphans >/dev/null 2>&1 || true
  ok "stack removed"
}

cmd="${1:-all}"
[ $# -gt 0 ] && shift
case "$cmd" in
  up) up ;;
  build) build ;;
  cloud) cloud_up ;;
  test) run_tests "$@" ;;
  down) down ;;
  all)
    [ "${KEEP:-}" = 1 ] || trap down EXIT
    up
    [ "${SKIP_BUILD:-}" = 1 ] || build
    cloud_up
    run_tests "$@"
    ;;
  *) die "unknown command '$cmd' (all|up|build|cloud|test|down)" ;;
esac
