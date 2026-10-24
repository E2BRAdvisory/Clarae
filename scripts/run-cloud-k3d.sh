#!/usr/bin/env bash
# Full cloud session on a local k3d cluster: PostgreSQL, S3 (RustFS), Keycloak and the
# Nodus Cloud Service deployed with Helm (deploy/helm/nodus + values-k3d.yaml).
#
#   scripts/run-cloud-k3d.sh            create the cluster if needed, build, deploy, wait
#   scripts/run-cloud-k3d.sh --down     delete the cluster
#   scripts/run-cloud-k3d.sh --status   show pods
#
# Endpoints on the host: API http://localhost:18081, notify gRPC localhost:18082,
# Keycloak http://keycloak.localtest.me:8080 (admin/admin; users admin/user1/user2,
# password "nodus-dev-password"), S3 http://localhost:9000. localtest.me resolves to
# 127.0.0.1 through public DNS, so the same issuer URL works in the browser and in pods.
# Desktop: NODUS_DEFAULT_SERVER_URL=http://localhost:18081 (server URL in Settings > Cloud).
set -euo pipefail
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib.sh"

CLUSTER="${NODUS_K3D_CLUSTER:-nodus}"
NS=nodus
KEYCLOAK_IP=10.43.0.50   # must match deploy/k3d/deps.yaml
KEYCLOAK_HOST=keycloak.localtest.me
CTX="k3d-$CLUSTER"

case "${1:-}" in
  --down) need k3d; k3d cluster delete "$CLUSTER"; exit 0 ;;
  --status) need kubectl; kubectl --context "$CTX" -n "$NS" get pods,svc; exit 0 ;;
  -h|--help) sed -n '2,12p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
  "") ;;
  *) die "unknown option: $1 (see --help)" ;;
esac

need docker; need k3d; need helm; need kubectl
docker info >/dev/null 2>&1 || die "Docker is not running"

if k3d cluster list "$CLUSTER" >/dev/null 2>&1; then
  ok "cluster '$CLUSTER' exists"
  k3d cluster start "$CLUSTER" >/dev/null 2>&1 || true
else
  log "Creating k3d cluster '$CLUSTER'"
  k3d cluster create "$CLUSTER" \
    --servers 1 --agents 0 --wait \
    --k3s-arg "--disable=traefik@server:0" \
    --host-alias "$KEYCLOAK_IP:$KEYCLOAK_HOST" \
    -p "18081:18081@loadbalancer" -p "18082:18082@loadbalancer" \
    -p "8080:8080@loadbalancer" -p "9000:9000@loadbalancer" >/dev/null
fi
k() { kubectl --context "$CTX" -n "$NS" "$@"; }
kubectl --context "$CTX" get ns "$NS" >/dev/null 2>&1 || kubectl --context "$CTX" create ns "$NS" >/dev/null

log "Deploying dependencies (PostgreSQL, S3, Keycloak)"
k create configmap keycloak-realm --from-file="$ROOT/deploy/keycloak/realm-nodus.json" \
  --dry-run=client -o yaml | k apply -f - >/dev/null
k apply -f "$ROOT/deploy/k3d/deps.yaml" >/dev/null

log "Building the cloud image (nodus-cloud:dev)"
run_quiet "docker build" docker build -q -f "$ROOT/services/cloud/Dockerfile" -t nodus-cloud:dev "$ROOT"
k3d image import nodus-cloud:dev -c "$CLUSTER" >/dev/null

log "Waiting for dependencies (Keycloak can take a minute)"
for d in postgres s3 keycloak; do k rollout status "deploy/$d" --timeout=300s >/dev/null || die "$d did not become ready (kubectl --context $CTX -n $NS logs deploy/$d)"; done

log "Installing the Helm release"
# Force a rollout so a rebuilt image with the same tag is picked up.
helm --kube-context "$CTX" -n "$NS" upgrade --install nodus "$ROOT/deploy/helm/nodus" \
  -f "$ROOT/deploy/helm/nodus/values-k3d.yaml" \
  --set-string "podAnnotations.rebuilt=$(date +%s)" --wait --timeout 5m >/dev/null \
  || die "helm install failed (kubectl --context $CTX -n $NS logs deploy/nodus-api)"

for _ in $(seq 1 30); do cloud_ready && break; sleep 2; done
cloud_ready || die "API does not answer on $CLOUD_URL"
ok "cloud is ready on $CLOUD_URL"
cat <<MSG

  API        $CLOUD_URL   (gRPC localhost:18082)
  Keycloak   http://$KEYCLOAK_HOST:8080   admin/admin; user1/nodus-dev-password
  Desktop    NODUS_DEFAULT_SERVER_URL=$CLOUD_URL yarn dev:desktop
  Logs       kubectl --context $CTX -n $NS logs -f deploy/nodus-api
  Stop       scripts/run-cloud-k3d.sh --down
MSG
