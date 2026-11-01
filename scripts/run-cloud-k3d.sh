#!/usr/bin/env bash
# Full cloud session on a local k3d cluster: PostgreSQL, S3 (RustFS), Keycloak and the
# MemoBrain Notes Cloud Service deployed with Helm (deploy/helm/memobrain + values-k3d.yaml).
#
#   yarn dev:cloud:k3d [up]                  choose the cluster (asked), build, deploy, wait;
#                                            starts a stopped cluster
#   yarn dev:cloud:k3d down                  switch MemoBrain Notes off, keeping its data until the next
#                                            "up": stops the dedicated "memobrain" cluster; on any
#                                            other cluster only scales MemoBrain Notes down to zero pods
#   yarn dev:cloud:k3d delete                remove MemoBrain Notes for good (deletes the dedicated
#                                            cluster; on other clusters only the namespace)
#   yarn dev:cloud:k3d status                show pods
#   --no-web                                 (up) do not start the Web UI on http://localhost:5174
#   --cluster NAME                           (any command) use NAME without asking; created by
#                                            "up" if missing. MEMOBRAIN_K3D_CLUSTER does the same
#
# Existing clusters are listed and a new cluster dedicated to MemoBrain Notes is suggested: it keeps
# the host ports (18081, 18082, 18080, 9000) and the DNS override away from your other work.
# On an existing cluster the script adds those ports to its load balancer, a CoreDNS
# override and the namespace "memobrain"; all other workloads are left alone.
#
# Endpoints on the host: API http://localhost:18081, notify gRPC localhost:18082,
# Keycloak http://keycloak.localtest.me:18080 (admin/admin; users admin/user1/user2,
# password "memobrain-dev-password"), S3 http://localhost:9000. localtest.me resolves to
# 127.0.0.1 through public DNS, so the same issuer URL works in the browser and in pods.
# The Web UI (admin console) runs on http://localhost:5174 (esbuild dev server, log .dev/logs/web.log)
# until "down"/"delete"; sign in as admin. Desktop: yarn dev:desktop, then enter the server URL in Settings > Cloud.
set -euo pipefail
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib.sh"

DEFAULT_CLUSTER=memobrain
NS=memobrain
KEYCLOAK_IP=10.43.0.50   # must match deploy/k3d/deps.yaml (inside the default k3s service CIDR)
KEYCLOAK_HOST=keycloak.localtest.me
PORTS=(18081 18082 18080 9000)

CLUSTER="${MEMOBRAIN_K3D_CLUSTER:-}"
ACTION=up
WEB=1
while [ $# -gt 0 ]; do
  case "$1" in
    --cluster) shift; CLUSTER="${1:?--cluster needs a name}" ;;
    --no-web) WEB=0 ;;
    up|down|delete|status) ACTION="$1" ;;
    -h|--help) sed -n '2,27p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
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
  echo "${C_BOLD}Which local k3d cluster should run MemoBrain Notes?${C_OFF}"
  if cluster_exists "$DEFAULT_CLUSTER"; then
    echo "  [1] $DEFAULT_CLUSTER  (dedicated MemoBrain Notes cluster, exists - recommended)"
  else
    echo "  [1] create a new cluster '$DEFAULT_CLUSTER' dedicated to MemoBrain Notes (recommended)"
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
    web_stop
    cluster_exists "$CLUSTER" || die "cluster '$CLUSTER' does not exist"
    if [ "$CLUSTER" = "$DEFAULT_CLUSTER" ]; then
      k3d cluster stop "$CLUSTER" >/dev/null
      ok "cluster '$CLUSTER' stopped (data is kept; 'up' starts it again)"
    else
      k scale deploy --all --replicas=0 >/dev/null 2>&1 || true
      ok "MemoBrain Notes scaled down on '$CLUSTER'; the cluster keeps running ('up' brings MemoBrain Notes back)"
    fi
    exit 0 ;;
  delete)
    web_stop
    cluster_exists "$CLUSTER" || die "cluster '$CLUSTER' does not exist"
    if [ "$CLUSTER" = "$DEFAULT_CLUSTER" ]; then k3d cluster delete "$CLUSTER"
    else
      helm --kube-context "$CTX" -n "$NS" uninstall memobrain >/dev/null 2>&1 || true
      kubectl --context "$CTX" delete ns "$NS" --ignore-not-found >/dev/null
      ok "removed namespace '$NS' from '$CLUSTER' (ports and DNS override left in place)"
    fi
    exit 0 ;;
esac

if cluster_exists "$CLUSTER"; then
  ok "cluster '$CLUSTER' exists"
  k3d cluster start "$CLUSTER" >/dev/null 2>&1 || true
  # Publish the MemoBrain Notes ports on the cluster's load balancer when they are not mapped yet.
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
    -p "18080:18080@loadbalancer" -p "9000:9000@loadbalancer" >/dev/null \
    || die "cluster creation failed (ports 18081, 18082, 18080, 9000 free?)"
fi
# After a Docker restart (or a load-balancer recreation by "k3d cluster edit") the serverlb
# container can come back attached to no network: nginx then cannot resolve the server node and
# crash-loops, so the API never answers. Reattach it and restart it.
lb="k3d-$CLUSTER-serverlb"
if docker inspect "$lb" >/dev/null 2>&1 \
  && [ -z "$(docker inspect "$lb" --format '{{range $k, $v := .NetworkSettings.Networks}}{{$k}}{{end}}' 2>/dev/null)" ]; then
  log "Reattaching $lb to the cluster network"
  docker network connect "k3d-$CLUSTER" "$lb" >/dev/null 2>&1 || true
  docker restart "$lb" >/dev/null 2>&1 || true
fi
# The API server is published on a random host port that changes whenever the cluster's load
# balancer is recreated (start after a reboot or Docker restart, port edits above): refresh the
# kubeconfig entry, then wait until the API answers instead of failing with "connection refused".
k3d kubeconfig merge "$CLUSTER" --kubeconfig-merge-default --kubeconfig-switch-context=false >/dev/null 2>&1 || true
log "Waiting for the Kubernetes API of '$CLUSTER'"
api_ready=""
for _ in $(seq 1 60); do
  if kubectl --context "$CTX" get --raw /readyz >/dev/null 2>&1; then api_ready=1; break; fi
  sleep 2
  k3d kubeconfig merge "$CLUSTER" --kubeconfig-merge-default --kubeconfig-switch-context=false >/dev/null 2>&1 || true
done
[ -n "$api_ready" ] || die "the Kubernetes API of '$CLUSTER' does not answer (docker ps | grep k3d-$CLUSTER; k3d cluster stop $CLUSTER && k3d cluster start $CLUSTER)"
ok "Kubernetes API ready"
kubectl --context "$CTX" get ns "$NS" >/dev/null 2>&1 || kubectl --context "$CTX" create ns "$NS" >/dev/null

# Pods resolve the public Keycloak host to its fixed ClusterIP through a dedicated CoreDNS
# server block (coredns-custom *.server is imported by k3s; the main block already uses the
# hosts plugin, which may appear only once per block), so browser and pods share one issuer.
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
# A broken override from an earlier run would keep CoreDNS crash-looping.
kubectl --context "$CTX" -n kube-system patch cm coredns-custom --type=json \
  -p '[{"op":"remove","path":"/data/memobrain.override"}]' >/dev/null 2>&1 || true
kubectl --context "$CTX" -n kube-system rollout restart deploy/coredns >/dev/null 2>&1 || true

# Pods stay Pending when every node carries the disk-pressure taint (the Docker disk is full).
pressure="$(kubectl --context "$CTX" get nodes -o jsonpath='{range .items[*]}{.spec.taints[?(@.key=="node.kubernetes.io/disk-pressure")].key}{"\n"}{end}' | grep -c disk-pressure || true)"
total="$(kubectl --context "$CTX" get nodes --no-headers | wc -l | tr -d ' ')"
if [ "$pressure" -ge "$total" ]; then
  docker system df >&2 || true
  die "all $total node(s) of '$CLUSTER' have disk pressure: the Docker disk is full, so nothing can be scheduled. Free space (e.g. 'docker builder prune', 'docker image prune -a', or 'docker volume prune' after checking what it removes) and run again."
fi

# Build and import the cloud image while the dependencies start (Keycloak is the slow one).
BUILD_LOG="$(mktemp)"
(
  docker build -q -f "$ROOT/services/cloud/Dockerfile" -t memobrain-cloud:dev "$ROOT" \
    && k3d image import memobrain-cloud:dev -c "$CLUSTER"
) >"$BUILD_LOG" 2>&1 &
BUILD_PID=$!
log "Building the cloud image in the background (memobrain-cloud:dev)"
# Images already in the local Docker cache are copied in instead of pulled from the registries.
# The list is the pinned references of deploy/k3d/deps.yaml (name:tag@digest).
for img in $(awk '$1 == "image:" { print $2 }' "$ROOT/deploy/k3d/deps.yaml"); do
  docker image inspect "$img" >/dev/null 2>&1 && k3d image import "$img" -c "$CLUSTER" >/dev/null 2>&1 &
done

log "Deploying dependencies (PostgreSQL, S3, Keycloak)"
k create configmap keycloak-realm --from-file="$ROOT/deploy/keycloak/realm-memobrain.json" \
  --dry-run=client -o yaml | k apply -f - >/dev/null
k apply -f "$ROOT/deploy/k3d/deps.yaml" >/dev/null
# Keycloak imports the realm only on an empty database: restart it when the realm file changed.
realm_hash="$(shasum -a 256 "$ROOT/deploy/keycloak/realm-memobrain.json" | cut -c1-16)"
k patch deploy keycloak -p "{\"spec\":{\"template\":{\"metadata\":{\"annotations\":{\"realm-hash\":\"$realm_hash\"}}}}}" >/dev/null

log "Waiting for dependencies (Keycloak can take a minute)"
kubectl --context "$CTX" -n kube-system rollout status deploy/coredns --timeout=120s >/dev/null || die "CoreDNS is not ready (kubectl --context $CTX -n kube-system logs deploy/coredns)"
dep_pids=()
for d in postgres s3 keycloak; do
  k rollout status "deploy/$d" --timeout=300s >/dev/null &
  dep_pids+=("$!")
done
for pid in "${dep_pids[@]}"; do
  wait "$pid" || die "a dependency did not become ready (kubectl --context $CTX -n $NS get pods)"
done
wait "$BUILD_PID" || { cat "$BUILD_LOG" >&2; die "cloud image build/import failed (output above)"; }
rm -f "$BUILD_LOG"

log "Installing the Helm release"
# The image id as annotation rolls the pods only when the image really changed.
helm --kube-context "$CTX" -n "$NS" upgrade --install memobrain "$ROOT/deploy/helm/memobrain" \
  -f "$ROOT/deploy/helm/memobrain/values-k3d.yaml" \
  --set-string "podAnnotations.image=$(docker image inspect -f '{{.Id}}' memobrain-cloud:dev)" --wait --timeout 5m >/dev/null \
  || die "helm install failed (kubectl --context $CTX -n $NS logs deploy/memobrain-api)"

for _ in $(seq 1 30); do cloud_ready && break; sleep 2; done
cloud_ready || die "API does not answer on $CLOUD_URL"
ok "cloud is ready on $CLOUD_URL"
[ "$WEB" = 1 ] && web_start
cat <<MSG

  API        $CLOUD_URL   (gRPC localhost:18082)
  Keycloak   http://$KEYCLOAK_HOST:18080   admin/admin; user1/memobrain-dev-password
  Web UI     $WEB_URL   (admin / memobrain-dev-password; log ${WEB_LOG#$ROOT/}; --no-web to skip)
  Desktop    yarn dev:desktop, then Settings > Cloud: server URL $CLOUD_URL
  Logs       kubectl --context $CTX -n $NS logs -f deploy/memobrain-api
  Stop       yarn dev:cloud:k3d down   (or delete)
MSG
