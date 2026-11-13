#!/usr/bin/env bash
# Restore drill (M7-WP2b): proves docs/runbook/backup-restore.md on DISPOSABLE containers.
#
#   scripts/chaos/restore-drill.sh [--keep]
#
# What it does, end to end:
#   1. starts PostgreSQL 17 with WAL archiving and an S3 store (RustFS; falls back to MinIO when
#      RustFS cannot do bucket versioning), all named clarae-chaos-drill-<rand>-*;
#   2. runs the real cloud binary against them, creates data through the API (batch "a");
#   3. takes a base backup (pg_basebackup) and a logical dump (pg_dump), enables bucket versioning;
#   4. creates batch "b", notes the point-in-time T, then simulates an accident: batch "b" is
#      deleted through the API and batch "c" is added after T;
#   5. object-store faults: an object is deleted, another overwritten with garbage, both detected
#      and healed from bucket versions;
#   6. DESTROYS the database (container and data volume), restores base backup + WAL up to T
#      (PITR), restarts the cloud, waits for the maintenance job and verifies: batch a+b present,
#      c absent, every blob downloadable with a matching digest, changelog contiguous, DB and
#      object store consistent, and a cursor ahead of the server is told to bootstrap;
#   7. restores the logical dump into a scratch database and compares the row counts.
# Exits non-zero at the first failed check. Nothing outside the named containers/volumes and
# .dev/chaos/drill-* is touched.
set -euo pipefail
. "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/lib.sh"

KEEP=0
[ "${1:-}" = "--keep" ] && KEEP=1
need docker; need go; need python3
docker info >/dev/null 2>&1 || die "Docker is not running"

RAND="$(od -An -N3 -tx1 /dev/urandom | tr -d ' \n')"
P="clarae-chaos-drill-$RAND"
WORK="$DEV_DIR/chaos/drill-$(date +%Y%m%d-%H%M%S)"
mkdir -p "$WORK"
REPORT="$WORK/report.md"
free_port() { python3 -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1",0)); print(s.getsockname()[1])'; }
PG_PORT="$(free_port)"; S3_PORT="$(free_port)"; ISS_PORT="$(free_port)"; API_PORT="$(free_port)"; GRPC_PORT="$(free_port)"
AK=drillkey; SK=drillsecret-0123456789
PG_IMG=postgres:17
CLOUD_PID=""; ISSUER_PID=""
S3_IMPL=rustfs
# Only ever remove things this script created: names are checked before every removal.
mine() { case "$1" in clarae-chaos-drill-"$RAND"*) return 0 ;; *) die "refusing to touch '$1'" ;; esac; }
dk_rm() { mine "$1"; docker rm -f "$1" >/dev/null 2>&1 || true; }
vol_rm() { mine "$1"; docker volume rm -f "$1" >/dev/null 2>&1 || true; }

step() { printf '\n==> %s\n' "$*" | tee -a "$REPORT"; }
note() { printf '%s\n' "$*" | tee -a "$REPORT"; }

cleanup() {
  local rc=$?
  [ -n "$CLOUD_PID" ] && kill -9 "$CLOUD_PID" 2>/dev/null || true
  [ -n "$ISSUER_PID" ] && kill "$ISSUER_PID" 2>/dev/null || true
  if [ "$KEEP" = 0 ]; then
    for c in "$P-pg" "$P-s3" "$P-scratch"; do dk_rm "$c"; done
    for v in "$P-pgdata" "$P-wal" "$P-base" "$P-s3data"; do vol_rm "$v"; done
  else
    warn "kept: containers/volumes $P-*"
  fi
  [ $rc -eq 0 ] && ok "restore drill PASSED (report: ${REPORT#$ROOT/})" || warn "restore drill FAILED (see ${REPORT#$ROOT/})"
  exit $rc
}
trap cleanup EXIT INT TERM

DRILL="$WORK/drilltool"; CLOUD="$WORK/clarae-cloud"
step "Building drilltool and the cloud binary"
(cd "$ROOT/services/cloud" && go build -o "$DRILL" ./test/drilltool && go build -o "$CLOUD" ./cmd/clarae-cloud) || die "build failed"
MANIFEST="$WORK/manifest.json"
ISSUER="http://127.0.0.1:$ISS_PORT"
API="http://127.0.0.1:$API_PORT"
DBURL="postgres://clarae:clarae@127.0.0.1:$PG_PORT/clarae?sslmode=disable"

psql_q() { docker exec -u postgres "$P-pg" psql -U clarae -d "${2:-clarae}" -Atqc "$1"; }
wait_pg() { for _ in $(seq 1 60); do docker exec "$P-pg" pg_isready -U clarae -d clarae >/dev/null 2>&1 && return 0; sleep 1; done; die "PostgreSQL did not become ready"; }

start_pg() { # $1 = fresh|restored
  local extra=()
  [ "$1" = fresh ] && extra=(-e POSTGRES_USER=clarae -e POSTGRES_PASSWORD=clarae -e POSTGRES_DB=clarae)
  docker run -d --name "$P-pg" ${extra[@]+"${extra[@]}"} \
    -v "$P-pgdata:/var/lib/postgresql/data" -v "$P-wal:/wal" -v "$P-base:/base" \
    -p "127.0.0.1:$PG_PORT:5432" "$PG_IMG" \
    -c wal_level=replica -c archive_mode=on -c 'archive_command=test ! -f /wal/%f && cp %p /wal/%f' -c archive_timeout=10 >/dev/null
  wait_pg
}

start_s3() {
  case "$S3_IMPL" in
    rustfs) docker run -d --name "$P-s3" -e RUSTFS_ACCESS_KEY=$AK -e RUSTFS_SECRET_KEY=$SK -e RUSTFS_VOLUMES=/data -e RUSTFS_ADDRESS=:9000 \
              -v "$P-s3data:/data" -p "127.0.0.1:$S3_PORT:9000" rustfs/rustfs:latest >/dev/null ;;
    minio)  docker run -d --name "$P-s3" -e MINIO_ROOT_USER=$AK -e MINIO_ROOT_PASSWORD=$SK \
              -v "$P-s3data:/data" -p "127.0.0.1:$S3_PORT:9000" minio/minio:latest server /data >/dev/null ;;
  esac
  for _ in $(seq 1 60); do
    code="$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$S3_PORT/" || true)"
    case "$code" in 200|403) return 0 ;; esac; sleep 1
  done
  die "S3 ($S3_IMPL) did not start"
}
has() { printf '%s' "$1" | grep -q "$2"; }

start_cloud() { # waits for readiness
  [ -n "$CLOUD_PID" ] && { kill -9 "$CLOUD_PID" 2>/dev/null || true; CLOUD_PID=""; }
  LISTEN_ADDR="127.0.0.1:$API_PORT" GRPC_LISTEN_ADDR="127.0.0.1:$GRPC_PORT" DATABASE_URL="$DBURL" \
  OIDC_ISSUER="$ISSUER" OIDC_AUDIENCE=clarae-api OIDC_STATUS_CACHE_TTL=1s LOG_LEVEL=debug \
  S3_ENDPOINT="http://127.0.0.1:$S3_PORT" S3_ACCESS_KEY=$AK S3_SECRET_KEY=$SK S3_BUCKET_BLOBS=clarae-blobs S3_BUCKET_EXPORTS=clarae-exports S3_USE_PATH_STYLE=true \
  "$CLOUD" --role=all >>"$WORK/cloud.log" 2>&1 &
  CLOUD_PID=$!
  for _ in $(seq 1 60); do curl -fsS "$API/api/v1/readyz" >/dev/null 2>&1 && return 0; kill -0 "$CLOUD_PID" 2>/dev/null || { tail -20 "$WORK/cloud.log" >&2; die "cloud exited"; }; sleep 1; done
  die "cloud not ready"
}

D() { "$DRILL" "$@"; }

# ---------------------------------------------------------------------------
step "1. PostgreSQL with WAL archiving, S3 store and the cloud"
docker volume create "$P-pgdata" >/dev/null; docker volume create "$P-wal" >/dev/null; docker volume create "$P-base" >/dev/null; docker volume create "$P-s3data" >/dev/null
docker run --rm --user root -v "$P-wal:/wal" -v "$P-base:/base" --entrypoint chown "$PG_IMG" postgres:postgres /wal /base
start_pg fresh
start_s3
S3A=(-s3 "127.0.0.1:$S3_PORT" -ak "$AK" -sk "$SK")
for b in clarae-blobs clarae-exports probe; do D s3 mkbucket "${S3A[@]}" -bucket "$b" >/dev/null; done
out="$(D s3 probe "${S3A[@]}" -bucket probe 2>&1)"; echo "$out" | tee -a "$REPORT"
if ! has "$out" 'versioning=SUPPORTED'; then
  note "RustFS does not support bucket versioning: using MinIO for the object store of the drill."
  dk_rm "$P-s3"; vol_rm "$P-s3data"; docker volume create "$P-s3data" >/dev/null
  S3_IMPL=minio; start_s3
  for b in clarae-blobs clarae-exports probe; do D s3 mkbucket "${S3A[@]}" -bucket "$b" >/dev/null; done
  out="$(D s3 probe "${S3A[@]}" -bucket probe 2>&1)"; echo "$out" | tee -a "$REPORT"
  has "$out" 'versioning=SUPPORTED' || die "MinIO versioning probe failed"
fi
note "object store used: $S3_IMPL"
D s3 enable "${S3A[@]}" -bucket clarae-blobs | tee -a "$REPORT"
D s3 lifecycle "${S3A[@]}" -bucket clarae-blobs 2>&1 | tee -a "$REPORT" || note "(lifecycle rules not supported by this store)"

"$DRILL" issuer -addr "127.0.0.1:$ISS_PORT" >"$WORK/issuer.log" 2>&1 &
ISSUER_PID=$!
for _ in $(seq 1 30); do curl -fsS "$ISSUER/.well-known/openid-configuration" >/dev/null 2>&1 && break; sleep 0.5; done
start_cloud
ok "cloud ready on $API"

# ---------------------------------------------------------------------------
step "2. Batch a (30 files) through the API"
D seed -api "$API" -issuer "$ISSUER" -manifest "$MANIFEST" -tag a -n 30 | tee -a "$REPORT"

step "3. Base backup + logical dump"
T_BACKUP="$(date -u +%FT%TZ)"
docker exec -u postgres "$P-pg" pg_basebackup -U clarae -D /base/b1 -Ft -z -X stream -c fast
docker exec -u postgres "$P-pg" pg_dump -U clarae -Fc -f /base/clarae.dump clarae
docker exec "$P-pg" ls -la /base/b1 /base/clarae.dump | tee -a "$REPORT"
note "backup taken at $T_BACKUP"
COUNT_FILES_BACKUP="$(psql_q 'SELECT count(*) FROM files')"

step "4. Batch b after the backup, then the point-in-time T, then the accident"
D seed -api "$API" -issuer "$ISSUER" -manifest "$MANIFEST" -tag b -n 20 | tee -a "$REPORT"
sleep 2
T="$(psql_q "SELECT to_char(now() AT TIME ZONE 'UTC','YYYY-MM-DD HH24:MI:SS.US') || '+00'")"
psql_q 'SELECT pg_switch_wal()' >/dev/null
note "recovery target T = $T"
sleep 3
D delete -api "$API" -issuer "$ISSUER" -manifest "$MANIFEST" -tag b | tee -a "$REPORT"
D seed -api "$API" -issuer "$ISSUER" -manifest "$MANIFEST" -tag c -n 10 | tee -a "$REPORT"
LAST_SEQ_BEFORE="$(python3 -c "import json;print(json.load(open('$MANIFEST'))['last_seq'])")"
psql_q 'SELECT pg_switch_wal()' >/dev/null
sleep 12 # archive_timeout=10 s also ships the last partial segment
note "files in DB before the disaster: $(psql_q 'SELECT count(*) FROM files WHERE NOT is_deleted') live, last_seq=$LAST_SEQ_BEFORE (files at backup time: $COUNT_FILES_BACKUP)"

step "5. Object-store faults healed from bucket versions"
HASH_A0="$(python3 -c "import json;print([f['hash'] for f in json.load(open('$MANIFEST'))['files'] if f['tag']=='a'][3])")"
HASH_A1="$(python3 -c "import json;print([f['hash'] for f in json.load(open('$MANIFEST'))['files'] if f['tag']=='a'][4])")"
KEY0="blobs/${HASH_A0:0:2}/$HASH_A0"; KEY1="blobs/${HASH_A1:0:2}/$HASH_A1"
# The bucket was versioned after the objects of batch a existed in RustFS/MinIO? They were written
# after "enable", so every object has a version.
D s3 rm "${S3A[@]}" -bucket clarae-blobs -key "$KEY0" | tee -a "$REPORT"
vbc() { D verify-blobs -db "$DBURL" "${S3A[@]}" 2>&1 || true; }
out="$(vbc)"; echo "$out" | tee -a "$REPORT"; has "$out" 'missing=1' || die "deleted object not detected"; ok "the consistency check detects the deleted object"
D s3 restore "${S3A[@]}" -bucket clarae-blobs -key "$KEY0" | tee -a "$REPORT"
out="$(vbc)"; echo "$out" | tee -a "$REPORT"; has "$out" 'missing=0 size-mismatch=0' || die "object not healed"
D s3 overwrite "${S3A[@]}" -bucket clarae-blobs -key "$KEY1" | tee -a "$REPORT"
out="$(vbc)"; echo "$out" | tee -a "$REPORT"; has "$out" 'size-mismatch=1' || die "overwritten object not detected"; ok "the consistency check detects the overwritten object"
D s3 restore "${S3A[@]}" -bucket clarae-blobs -key "$KEY1" | tee -a "$REPORT"
out="$(vbc)"; echo "$out" | tee -a "$REPORT"; has "$out" 'missing=0 size-mismatch=0' || die "object not healed"

# ---------------------------------------------------------------------------
step "6. DISASTER: the database is destroyed (container and data volume)"
kill -9 "$CLOUD_PID" 2>/dev/null || true; CLOUD_PID=""
dk_rm "$P-pg"; vol_rm "$P-pgdata"; docker volume create "$P-pgdata" >/dev/null
note "database gone; archived WAL segments kept: $(docker run --rm -v "$P-wal:/wal:ro" --entrypoint sh "$PG_IMG" -c 'ls /wal | wc -l')"

step "7. PITR restore to $T"
RESTORE_START="$(date +%s)"
docker run --rm --user root -v "$P-pgdata:/var/lib/postgresql/data" -v "$P-base:/base:ro" -v "$P-wal:/wal:ro" --entrypoint sh "$PG_IMG" -c "
  set -e; cd /var/lib/postgresql/data
  tar xzf /base/b1/base.tar.gz
  mkdir -p pg_wal && tar xzf /base/b1/pg_wal.tar.gz -C pg_wal
  touch recovery.signal
  cat >> postgresql.auto.conf <<EOF
restore_command = 'cp /wal/%f %p'
recovery_target_time = '$T'
recovery_target_action = 'promote'
EOF
  chown -R postgres:postgres . && chmod 700 ."
start_pg restored
for _ in $(seq 1 60); do [ "$(psql_q 'SELECT pg_is_in_recovery()')" = f ] && break; sleep 1; done
[ "$(psql_q 'SELECT pg_is_in_recovery()')" = f ] || { docker logs "$P-pg" 2>&1 | tail -30; die "recovery did not finish"; }
docker logs "$P-pg" 2>&1 | grep -E "recovery stopping|recovery target|database system is ready" | tee -a "$REPORT" || true
note "database restored; live files now: $(psql_q 'SELECT count(*) FROM files WHERE NOT is_deleted'), last_seq of the vault: $(psql_q 'SELECT max(last_seq) FROM vaults')"

step "8. Restart the cloud; maintenance job reconciles counters"
: >"$WORK/cloud.log"
start_cloud
note "waiting for the maintenance job (first run 30 s after start)"
for _ in $(seq 1 60); do grep -q '"job":"maintenance"' "$WORK/cloud.log" && break; sleep 1; done
grep -E '"job":"maintenance"|drift|corrected|job failed' "$WORK/cloud.log" | tee -a "$REPORT" || true
if grep -q 'job failed' "$WORK/cloud.log"; then die "a job failed after the restore"; fi

step "9. Verification"
D verify -api "$API" -issuer "$ISSUER" -manifest "$MANIFEST" -expect a,b -absent c -stale-cursor "$((LAST_SEQ_BEFORE))" | tee -a "$REPORT"
out="$(vbc)"; echo "$out" | tee -a "$REPORT"; has "$out" 'missing=0 size-mismatch=0' || die "blob consistency check failed after restore"
# New writes after the restore continue the sequence (no reuse problems, idempotent op ids).
D seed -api "$API" -issuer "$ISSUER" -manifest "$MANIFEST" -tag d -n 5 | tee -a "$REPORT"
RESTORE_SECS=$(( $(date +%s) - RESTORE_START ))
note "RTO of the drill (destroy -> verified, tiny data set): ${RESTORE_SECS} s"

step "10. Logical dump restored into a scratch database"
dk_rm "$P-scratch"
docker run -d --name "$P-scratch" -e POSTGRES_PASSWORD=x -v "$P-base:/base:ro" "$PG_IMG" >/dev/null
for _ in $(seq 1 60); do docker exec "$P-scratch" pg_isready -U postgres >/dev/null 2>&1 && break; sleep 1; done
docker exec "$P-scratch" createdb -U postgres scratch
docker exec "$P-scratch" sh -c 'pg_restore -U postgres -d scratch --no-owner /base/clarae.dump' 2>&1 | tail -3 || true
N_DUMP="$(docker exec "$P-scratch" psql -U postgres -d scratch -Atc 'SELECT count(*) FROM files')"
note "files in the dump restored into the scratch DB: $N_DUMP (at backup time: $COUNT_FILES_BACKUP)"
[ "$N_DUMP" = "$COUNT_FILES_BACKUP" ] || die "dump restore row count mismatch"
note ""
note "RESULT: PITR exercised = yes (target $T); object store = $S3_IMPL with versioning; all checks passed."
