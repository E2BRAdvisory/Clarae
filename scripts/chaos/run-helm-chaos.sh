#!/usr/bin/env bash
# Chaos test of the Helm chart on a DISPOSABLE k3d cluster (M7-WP2b).
#
#   scripts/chaos/run-helm-chaos.sh [--drain 5s] [--replicas 3] [--keep] [--out DIR]
#
# The script creates its own cluster "memobrain-chaos-<rand>" (never reuses another one, and
# refuses to act on any kubectl context that is not a k3d-memobrain-chaos-* one), deploys the
# dependencies and the chart (values-k3d.yaml + values-chaos.yaml), then runs an availability
# probe at 10 Hz (GET /readyz and an authenticated GET /me with a real Keycloak token)
# while it:
#   1. force-kills API pods (SIGKILL, no grace) three times,
#   2. deletes API pods gracefully (SIGTERM) twice,
#   3. runs "kubectl rollout restart" of the API,
#   4. crashes PostgreSQL (kill -9 of the postmaster; the pod restarts, data survives).
# It then writes samples, events and a JSON + Markdown report to .dev/chaos/<timestamp>/
# and deletes the cluster (unless --keep).
#
# Host ports (not the dev ones, so a running "memobrain" cluster is unaffected):
# API on 28081, Keycloak on 28080 (override with CHAOS_API_PORT / CHAOS_KC_PORT).
# The cloud image is built from the working tree as memobrain-cloud:chaos.
set -euo pipefail
. "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/lib.sh"

DRAIN=5s
REPLICAS=3
KEEP=0
OUT=""
API_PORT="${CHAOS_API_PORT:-28081}"
KC_PORT="${CHAOS_KC_PORT:-28080}"
while [ $# -gt 0 ]; do
  case "$1" in
    --drain) shift; DRAIN="${1:?--drain needs a duration}" ;;
    --replicas) shift; REPLICAS="${1:?--replicas needs a number}" ;;
    --out) shift; OUT="${1:?--out needs a directory}" ;;
    --keep) KEEP=1 ;;
    -h|--help) sed -n '2,19p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) die "unknown option: $1" ;;
  esac
  shift
done

need docker; need k3d; need helm; need kubectl; need go; need python3; need jq; need curl
docker info >/dev/null 2>&1 || die "Docker is not running"
for p in "$API_PORT" "$KC_PORT"; do
  if lsof -iTCP:"$p" -sTCP:LISTEN >/dev/null 2>&1; then die "host port $p is in use"; fi
done

CLUSTER="memobrain-chaos-$(od -An -N3 -tx1 /dev/urandom | tr -d ' \n')"
CTX="k3d-$CLUSTER"
NS=memobrain
KEYCLOAK_IP=10.43.0.50   # must match deploy/k3d/deps.yaml
KEYCLOAK_HOST=keycloak.localtest.me
STAMP="$(date +%Y%m%d-%H%M%S)"
OUT="${OUT:-$DEV_DIR/chaos/$STAMP}"
mkdir -p "$OUT"
EVENTS="$OUT/events.tsv"; : >"$EVENTS"
PROBE_PID=""
CREATED=0

# guard: every mutating call goes through k, which only ever talks to our own cluster.
guard() {
  case "$CLUSTER" in memobrain-chaos-*) ;; *) die "refusing: '$CLUSTER' is not a chaos cluster" ;; esac
  case "$CTX" in k3d-memobrain-chaos-*) ;; *) die "refusing: context '$CTX' is not a chaos cluster" ;; esac
}
k() { guard; kubectl --context "$CTX" -n "$NS" "$@"; }
now_ms() { python3 -c 'import time; print(int(time.time()*1000))'; }
event() { printf '%s\t%s\t%s\t%s\n' "$(now_ms)" "$1" "$2" "${3:-}" >>"$EVENTS"; }

cleanup() {
  local rc=$?
  [ -n "$PROBE_PID" ] && kill "$PROBE_PID" 2>/dev/null || true
  if [ "$CREATED" = 1 ]; then
    if [ "$KEEP" = 1 ]; then
      warn "cluster $CLUSTER kept (--keep); remove it with: k3d cluster delete $CLUSTER"
    else
      guard
      log "Deleting the disposable cluster $CLUSTER"
      k3d cluster delete "$CLUSTER" >/dev/null 2>&1 || true
    fi
  fi
  exit $rc
}
trap cleanup EXIT INT TERM

log "Creating the disposable cluster $CLUSTER (API :$API_PORT, Keycloak :$KC_PORT)"
k3d cluster create "$CLUSTER" --servers 1 --agents 0 --wait \
  --k3s-arg "--disable=traefik@server:0" \
  -p "$API_PORT:18081@loadbalancer" -p "$KC_PORT:18080@loadbalancer" >/dev/null \
  || die "cluster creation failed"
CREATED=1
kubectl --context "$CTX" create ns "$NS" >/dev/null

log "Aliasing $KEYCLOAK_HOST to Keycloak inside the cluster"
kubectl --context "$CTX" -n kube-system apply -f - >/dev/null <<DNS
apiVersion: v1
kind: ConfigMap
metadata: { name: coredns-custom }
data:
  memobrain.server: |
    $KEYCLOAK_HOST:53 {
      hosts {
        $KEYCLOAK_IP $KEYCLOAK_HOST
      }
    }
DNS
kubectl --context "$CTX" -n kube-system rollout restart deploy/coredns >/dev/null 2>&1 || true

log "Building the cloud image from the working tree (memobrain-cloud:chaos)"
docker build -q -f "$ROOT/scripts/chaos/Dockerfile.cloud" -t memobrain-cloud:chaos "$ROOT" >/dev/null || die "image build failed"
for img in memobrain-cloud:chaos postgres:17 rustfs/rustfs:latest quay.io/keycloak/keycloak:26.7; do
  docker image inspect "$img" >/dev/null 2>&1 && k3d image import "$img" -c "$CLUSTER" >/dev/null 2>&1 || true
done

log "Deploying dependencies"
k create configmap keycloak-realm --from-file="$ROOT/deploy/keycloak/realm-memobrain.json" >/dev/null
k apply -f "$ROOT/deploy/k3d/deps.yaml" >/dev/null
kubectl --context "$CTX" -n kube-system rollout status deploy/coredns --timeout=120s >/dev/null
for d in postgres s3 keycloak; do k rollout status "deploy/$d" --timeout=300s >/dev/null & done
wait || die "a dependency did not become ready"

log "Installing the chart (api replicas=$REPLICAS, SHUTDOWN_DRAIN=$DRAIN)"
guard
helm --kube-context "$CTX" -n "$NS" upgrade --install memobrain "$ROOT/deploy/helm/memobrain" \
  -f "$ROOT/deploy/helm/memobrain/values-k3d.yaml" -f "$ROOT/deploy/helm/memobrain/values-chaos.yaml" \
  --set "api.replicas=$REPLICAS" --set-string "config.SHUTDOWN_DRAIN=$DRAIN" \
  --wait --timeout 5m >/dev/null || die "helm install failed (kubectl --context $CTX -n $NS logs deploy/memobrain-memobrain-api)"
API="http://127.0.0.1:$API_PORT"
for _ in $(seq 1 40); do curl -fsS "$API/api/v1/readyz" >/dev/null 2>&1 && break; sleep 2; done
curl -fsS "$API/api/v1/readyz" >/dev/null || die "API does not answer on $API"

# The realm has no password grant; enable it for the desktop client of THIS disposable
# cluster so the probe can obtain a real token non-interactively.
log "Enabling the password grant on the throwaway Keycloak (probe only)"
KC="http://$KEYCLOAK_HOST:$KC_PORT"
RESOLVE=(--resolve "$KEYCLOAK_HOST:$KC_PORT:127.0.0.1")
for _ in $(seq 1 30); do
  ADMIN_TOKEN="$(curl -fsS "${RESOLVE[@]}" -d grant_type=password -d client_id=admin-cli -d username=admin -d password=admin \
    "$KC/realms/master/protocol/openid-connect/token" 2>/dev/null | jq -r .access_token || true)"
  [ -n "${ADMIN_TOKEN:-}" ] && [ "$ADMIN_TOKEN" != null ] && break; sleep 2
done
[ -n "${ADMIN_TOKEN:-}" ] && [ "$ADMIN_TOKEN" != null ] || die "cannot get a Keycloak admin token"
CID="$(curl -fsS "${RESOLVE[@]}" -H "Authorization: Bearer $ADMIN_TOKEN" "$KC/admin/realms/memobrain/clients?clientId=memobrain-desktop" | jq -r '.[0].id')"
curl -fsS "${RESOLVE[@]}" -H "Authorization: Bearer $ADMIN_TOKEN" "$KC/admin/realms/memobrain/clients/$CID" \
  | jq '.directAccessGrantsEnabled = true' \
  | curl -fsS "${RESOLVE[@]}" -X PUT -H "Authorization: Bearer $ADMIN_TOKEN" -H 'Content-Type: application/json' -d @- "$KC/admin/realms/memobrain/clients/$CID" >/dev/null

TOKEN_URL="$KC/realms/memobrain/protocol/openid-connect/token"
log "Warming up and checking the authenticated probe"
PROBE_BIN="$OUT/probe"
(cd "$ROOT" && go build -o "$PROBE_BIN" scripts/chaos/probe/main.go) || die "probe build failed"
"$PROBE_BIN" -api "$API" -token-url "$TOKEN_URL" -resolve "$KEYCLOAK_HOST=127.0.0.1" -rate 10 -out "$OUT/samples.jsonl" &
PROBE_PID=$!
sleep 6
ok_me="$(jq -s '[.[]|select(.kind=="me" and .ok)]|length' "$OUT/samples.jsonl")"
[ "${ok_me:-0}" -gt 10 ] || die "the authenticated probe gets no 200 from /me"
ok "probe works ($ok_me successful /me calls so far)"

API_DEPLOY="$(k get deploy -l app.kubernetes.io/component=api -o name | head -1)"   # deployment/<release>-memobrain-api
[ -n "$API_DEPLOY" ] || die "API deployment not found"
wait_api_ready() { # wait until all desired API replicas are ready
  k rollout status "$API_DEPLOY" --timeout=180s >/dev/null
}
api_pods() { k get pods -l app.kubernetes.io/component=api -o jsonpath='{.items[*].metadata.name}'; }
pick_pod() { api_pods | tr ' ' '\n' | awk 'NF' | sort -R | head -1; }

event warmup start; sleep 15; event warmup end

event pod-kill start "3x force delete (SIGKILL, grace 0) of one API pod, 20 s apart"
for i in 1 2 3; do
  p="$(pick_pod)"; log "kill api pod $p"
  k delete pod "$p" --grace-period=0 --force >/dev/null 2>&1 || true
  sleep 20
done
wait_api_ready; event pod-kill end

event pod-delete-graceful start "2x graceful delete (SIGTERM, 30 s grace) of one API pod"
for i in 1 2; do
  p="$(pick_pod)"; log "delete api pod $p (graceful)"
  k delete pod "$p" --wait=false >/dev/null 2>&1 || true
  sleep 25
done
wait_api_ready; event pod-delete-graceful end

event rolling-restart start "kubectl rollout restart of the API deployment"
k rollout restart "$API_DEPLOY" >/dev/null
wait_api_ready
sleep 10; event rolling-restart end

event postgres-crash start "SIGKILL of the PostgreSQL checkpointer: the postmaster drops every connection and runs crash recovery"
log "crashing PostgreSQL"
# SIGKILL to PID 1 is ignored inside a container, so the crash is injected one level down: when any
# server process dies from a signal the postmaster restarts them all (crash recovery).
k exec deploy/postgres -- sh -c 'for p in /proc/[0-9]*; do if tr "\0" " " <$p/cmdline 2>/dev/null | grep -q "postgres: [c]heckpointer"; then kill -9 ${p#/proc/}; fi; done' >/dev/null 2>&1 || true
sleep 2
pglog="$(k logs deploy/postgres --tail=80 2>&1 || true)"   # captured: grep -q in a pipe would SIGPIPE kubectl under pipefail
if ! printf '%s' "$pglog" | grep -q "terminated by signal 9"; then
  die "fault not injected: PostgreSQL did not report a process killed by signal 9"
fi
ok "PostgreSQL crash injected (crash recovery started)"
began="$(now_ms)"
rec=""
for _ in $(seq 1 120); do
  if curl -fsS -m 2 "$API/api/v1/readyz" >/dev/null 2>&1; then rec=$(( $(now_ms) - began )); break; fi
  sleep 1
done
sleep 15
event postgres-crash end "readyz healthy again ${rec:-never} ms after the crash was confirmed"
[ -n "$rec" ] || warn "readiness did not recover within 120 s after the PostgreSQL crash"

event cooldown start; sleep 10; event cooldown end

kill "$PROBE_PID" 2>/dev/null || true; wait "$PROBE_PID" 2>/dev/null || true; PROBE_PID=""
jq -n --arg cluster "$CLUSTER" --arg drain "$DRAIN" --argjson replicas "$REPLICAS" --arg image "memobrain-cloud:chaos" --arg rate "10 Hz (readyz + me per tick)" --arg timeout "2 s" \
  '{cluster:$cluster, api_replicas:$replicas, SHUTDOWN_DRAIN:$drain, image:$image, probe_rate:$rate, request_timeout:$timeout}' >"$OUT/meta.json"
k get "$API_DEPLOY" -o json | jq '{pdb:"none in chart", strategy:.spec.strategy, readinessProbe:.spec.template.spec.containers[0].readinessProbe, terminationGracePeriodSeconds:.spec.template.spec.terminationGracePeriodSeconds, lifecycle:.spec.template.spec.containers[0].lifecycle, affinity:.spec.template.spec.affinity}' >"$OUT/deployment-facts.json"
python3 "$ROOT/scripts/chaos/report.py" "$OUT"
ok "report: ${OUT#$ROOT/}/report.md"
