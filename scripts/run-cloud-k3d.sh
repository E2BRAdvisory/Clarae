#!/usr/bin/env bash
# Full cloud session on a local k3d cluster: PostgreSQL, S3 (RustFS), Keycloak and the
# Nodus Cloud Service deployed with Helm (deploy/helm/nodus + values-k3d.yaml).
#
#   scripts/run-cloud-k3d.sh                 choose the cluster (asked), build, deploy, wait
#   scripts/run-cloud-k3d.sh --cluster NAME  use NAME without asking (created if missing);
#                                            NODUS_K3D_CLUSTER does the same
#   scripts/run-cloud-k3d.sh --down          remove Nodus (deletes the dedicated "nodus"
#                                            cluster; on other clusters only the namespace)
#   scripts/run-cloud-k3d.sh --status        show pods
#
# Existing clusters are listed and a new cluster dedicated to Nodus is suggested: it keeps
# the host ports (18081, 18082, 8080, 9000) and the DNS override away from your other work.
# On an existing cluster the script adds those ports to its load balancer, a CoreDNS
# override and the namespace "nodus"; all other workloads are left alone.
#
# Endpoints on the host: API http://localhost:18081, notify gRPC localhost:18082,
# Keycloak http://keycloak.localtest.me:8080 (admin/admin; users admin/user1/user2,
# password "nodus-dev-password"), S3 http://localhost:9000. localtest.me resolves to
# 127.0.0.1 through public DNS, so the same issuer URL works in the browser and in pods.
# Desktop: NODUS_DEFAULT_SERVER_URL=http://localhost:18081 (server URL in Settings > Cloud).
set -euo pipefail
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib.sh"

DEFAULT_CLUSTER=nodus
NS=nodus
KEYCLOAK_IP=10.43.0.50   # must match deploy/k3d/deps.yaml (inside the default k3s service CIDR)
KEYCLOAK_HOST=keycloak.localtest.me
PORTS=(18081 18082 8080 9000)

CLUSTER="${NODUS_K3D_CLUSTER:-}"
ACTION=up
while [ $# -gt 0 ]; do
  case "$1" in
    --cluster) shift; CLUSTER="${1:?--cluster needs a name}" ;;
    --down) ACTION=down ;;
    --status) ACTION=status ;;
    -h|--help) sed -n '2,20p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) die "unknown option: $1 (see --help)" ;;
  esac
  shift
done

need docker; need k3d; need helm; need kubectl
docker info >/dev/null 2>&1 || die "Docker is not running"

cluster_names() { k3d cluster list --no-headers 2>/dev/null | awk '{print $1}'; }
cluster_exists() { cluster_names | grep -qx "$1"; }

# choose_cluster asks which local k3d cluster to use, listing the existing ones and
# suggesting a dedicated new cluster. Without a terminal it picks the dedicated one.
choose_cluster() {
  if [ ! -t 0 ]; then CLUSTER="$DEFAULT_CLUSTER"; return; fi
  local choices=("$DEFAULT_CLUSTER") n i=1 pick
  echo "${C_BOLD}Which local k3d cluster should run Nodus?${C_OFF}"
  if cluster_exists "$DEFAULT_CLUSTER"; then
    echo "  [1] $DEFAULT_CLUSTER  (dedicated Nodus cluster, exists - recommended)"
  else
    echo "  [1] create a new cluster '$DEFAULT_CLUSTER' dedicated to Nodus (recommended)"
  fi
  while read -r n; do
    { [ -z "$n" ] || [ "$n" = "$DEFAULT_CLUSTER" ]; } && continue
    i=$((i + 1)); choices+=("$n")
    echo "  [$i] $n  (existing, shared with your other work)"
  done < <(cluster_names)
  echo "  [c] create a new cluster with another name"
  read -r -p "Choice [1]: " pick
  pick="${pick:-1}"
  case "$pick" in
    c|C) read -r -p "Name of the new cluster: " CLUSTER; [ -n "$CLUSTER" ] || die "empty name" ;;
    *[!0-9]*) die "invalid choice: $pick" ;;
    *) [ "$pick" -ge 1 ] && [ "$pick" -le "${#choices[@]}" ] || die "invalid choice: $pick"
       CLUSTER="${choices[$((pick - 1))]}" ;;
  esac
}

[ -n "$CLUSTER" ] || choose_cluster
CTX="k3d-$CLUSTER"
log "Cluster: $CLUSTER"
k() { kubectl --context "$CTX" -n "$NS" "$@"; }

case "$ACTION" in
  status) k get pods,svc; exit 0 ;;
  down)
    if [ "$CLUSTER" = "$DEFAULT_CLUSTER" ]; then k3d cluster delete "$CLUSTER"
    else
      helm --kube-context "$CTX" -n "$NS" uninstall nodus >/dev/null 2>&1 || true
      kubectl --context "$CTX" delete ns "$NS" --ignore-not-found >/dev/null
      ok "removed namespace '$NS' from '$CLUSTER' (ports and DNS override left in place)"
    fi
    exit 0 ;;
esac

if cluster_exists "$CLUSTER"; then
  ok "cluster '$CLUSTER' exists"
  k3d cluster start "$CLUSTER" >/dev/null 2>&1 || true
  # Publish the Nodus ports on the cluster's load balancer when they are not mapped yet.
  mapped="$(docker inspect "k3d-$CLUSTER-serverlb" --format '{{json .HostConfig.PortBindings}}' 2>/dev/null || true)"
  for p in "${PORTS[@]}"; do
    case "$mapped" in
      *"\"$p/tcp\""*) ;;
      *)
        log "Publishing port $p on '$CLUSTER'"
        k3d cluster edit "$CLUSTER" --port-add "$p:$p@loadbalancer" >/dev/null \
          || die "cannot publish port $p (already used by another cluster or process?)" ;;
    esac
  done
else
  log "Creating k3d cluster '$CLUSTER'"
  k3d cluster create "$CLUSTER" \
    --servers 1 --agents 0 --wait \
    --k3s-arg "--disable=traefik@server:0" \
    -p "18081:18081@loadbalancer" -p "18082:18082@loadbalancer" \
    -p "8080:8080@loadbalancer" -p "9000:9000@loadbalancer" >/dev/null \
    || die "cluster creation failed (ports 18081, 18082, 8080, 9000 free?)"
fi
kubectl --context "$CTX" get ns "$NS" >/dev/null 2>&1 || kubectl --context "$CTX" create ns "$NS" >/dev/null

# Pods resolve the public Keycloak host to its fixed ClusterIP (coredns-custom is
# imported by k3s' CoreDNS), so browser and pods share one issuer URL.
log "Aliasing $KEYCLOAK_HOST to Keycloak inside the cluster"
kubectl --context "$CTX" -n kube-system apply -f - >/dev/null <<DNS
apiVersion: v1
kind: ConfigMap
metadata: { name: coredns-custom }
data:
  nodus.override: |
    hosts {
      $KEYCLOAK_IP $KEYCLOAK_HOST
      fallthrough
    }
DNS
kubectl --context "$CTX" -n kube-system rollout restart deploy/coredns >/dev/null 2>&1 || true

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
