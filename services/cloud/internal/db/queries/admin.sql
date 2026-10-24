-- name: ListUsersAdmin :many
SELECT u.*, COUNT(*) OVER()::int AS total FROM users u
WHERE u.status <> 'deleted'
  AND (sqlc.arg(q)::text = ''
       OR u.username ILIKE '%' || sqlc.arg(q)::text || '%'
       OR u.email::text ILIKE '%' || sqlc.arg(q)::text || '%'
       OR u.display_name ILIKE '%' || sqlc.arg(q)::text || '%')
  AND (sqlc.arg(status)::text = '' OR u.status = sqlc.arg(status)::text)
  AND (sqlc.arg(role)::text = '' OR u.role = sqlc.arg(role)::text)
  AND (sqlc.narg(group_id)::uuid IS NULL
       OR EXISTS (SELECT 1 FROM group_members m WHERE m.user_id = u.id AND m.group_id = sqlc.narg(group_id)::uuid))
ORDER BY
  CASE WHEN sqlc.arg(sort)::text = 'used' THEN u.used_bytes END DESC,
  CASE WHEN sqlc.arg(sort)::text = 'created' THEN u.created_at END DESC,
  lower(u.username)
LIMIT sqlc.arg(max_rows)::int OFFSET sqlc.arg(skip_rows)::int;

-- name: InsertProvisionedUser :one
-- A user created by an administrator: the row exists before the first login,
-- which then links to it through the Keycloak subject.
INSERT INTO users (id, keycloak_sub, username, email, display_name, role, status)
VALUES ($1, $2, $3, $4, $5, $6, 'active') RETURNING *;

-- name: SetUserStatus :one
UPDATE users SET status = $2, updated_at = now() WHERE id = $1 AND status <> 'deleted' RETURNING *;

-- name: SetUserRole :one
UPDATE users SET role = $2, updated_at = now() WHERE id = $1 AND status <> 'deleted' RETURNING *;

-- name: SetUserQuotaOverride :one
UPDATE users SET quota_bytes_override = $2, updated_at = now() WHERE id = $1 AND status <> 'deleted' RETURNING *;

-- name: BulkSetUserQuota :execrows
UPDATE users SET quota_bytes_override = sqlc.narg(quota)::bigint, updated_at = now()
WHERE id = ANY(sqlc.arg(ids)::uuid[]) AND status <> 'deleted';

-- name: UpdateUserProfile :one
UPDATE users SET display_name = COALESCE(sqlc.narg(display_name), display_name),
                 email = COALESCE(sqlc.narg(email), email), updated_at = now()
WHERE id = $1 AND status <> 'deleted' RETURNING *;

-- name: ListVaultsOfUserAdmin :many
SELECT id, name, kind, total_bytes, file_count, created_at, deleted_at
FROM vaults WHERE owner_id = $1 ORDER BY lower(name);

-- name: SoftDeleteVaultsOfOwner :execrows
UPDATE vaults SET deleted_at = now() WHERE owner_id = $1 AND deleted_at IS NULL;

-- name: CountActiveAdmins :one
SELECT COUNT(*)::int FROM users WHERE role = 'admin' AND status = 'active';

-- name: ListDevicesOfUserAdmin :many
SELECT * FROM devices WHERE user_id = $1 AND revoked_at IS NULL ORDER BY created_at;

-- name: StorageTotals :one
SELECT COALESCE(SUM(used_bytes), 0)::bigint AS total_used, COUNT(*)::int AS user_count
FROM users WHERE status <> 'deleted';

-- name: TopConsumers :many
SELECT id, username, used_bytes, COALESCE(quota_bytes_override, sqlc.arg(default_quota)::bigint)::bigint AS quota_bytes
FROM users WHERE status <> 'deleted'
ORDER BY used_bytes DESC, lower(username)
LIMIT sqlc.arg(max_rows)::int;

-- name: CountUsersOverPercent :one
-- Users whose usage reached the given percentage of a finite quota.
SELECT COUNT(*)::int FROM users u
WHERE u.status <> 'deleted'
  AND COALESCE(u.quota_bytes_override, sqlc.arg(default_quota)::bigint) > 0
  AND u.used_bytes * 100 >= COALESCE(u.quota_bytes_override, sqlc.arg(default_quota)::bigint) * sqlc.arg(percent)::bigint;

-- name: UpsertStorageSnapshot :exec
INSERT INTO storage_snapshots (day, total_bytes) VALUES (CURRENT_DATE, $1)
ON CONFLICT (day) DO UPDATE SET total_bytes = EXCLUDED.total_bytes;

-- name: ListStorageSnapshots :many
SELECT day, total_bytes FROM storage_snapshots WHERE day >= CURRENT_DATE - sqlc.arg(days)::int ORDER BY day;

-- name: ListAuditEntries :many
SELECT a.id, a.at, a.actor_id, u.username AS actor_name, a.action, a.target_type, a.target_id, a.details, COALESCE(host(a.ip), '')::text AS ip
FROM audit_log a LEFT JOIN users u ON u.id = a.actor_id
WHERE (sqlc.narg(actor_id)::uuid IS NULL OR a.actor_id = sqlc.narg(actor_id)::uuid)
  AND (sqlc.arg(action)::text = '' OR a.action LIKE sqlc.arg(action)::text || '%')
  AND (sqlc.arg(target)::text = '' OR a.target_id = sqlc.arg(target)::text)
  AND (sqlc.narg(from_at)::timestamptz IS NULL OR a.at >= sqlc.narg(from_at)::timestamptz)
  AND (sqlc.narg(to_at)::timestamptz IS NULL OR a.at < sqlc.narg(to_at)::timestamptz)
  AND (sqlc.narg(before_id)::bigint IS NULL OR a.id < sqlc.narg(before_id)::bigint)
ORDER BY a.id DESC
LIMIT sqlc.arg(max_rows)::int;

-- name: InsertProfileVersion :exec
INSERT INTO config_profile_versions (profile_id, version, name, description, is_global, config, locked_keys, updated_by, updated_at)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
ON CONFLICT (profile_id, version) DO NOTHING;

-- name: ListProfileVersions :many
SELECT * FROM config_profile_versions WHERE profile_id = $1 ORDER BY version DESC;

-- name: GetProfileVersion :one
SELECT * FROM config_profile_versions WHERE profile_id = $1 AND version = $2;

-- name: CreateExportJob :one
INSERT INTO export_jobs (id, vault_id, requested_by) VALUES ($1, $2, $3) RETURNING *;

-- name: GetExportJob :one
SELECT * FROM export_jobs WHERE id = $1 AND vault_id = $2;

-- name: ClaimExportJob :one
UPDATE export_jobs SET status = 'running'
WHERE id = (SELECT j.id FROM export_jobs j WHERE j.status = 'queued' ORDER BY j.created_at LIMIT 1 FOR UPDATE SKIP LOCKED)
RETURNING *;

-- name: FinishExportJob :exec
UPDATE export_jobs SET status = 'ready', size = $2, object_key = $3, finished_at = now(), expires_at = $4 WHERE id = $1;

-- name: FailExportJob :exec
UPDATE export_jobs SET status = 'failed', error = $2, finished_at = now() WHERE id = $1;

-- name: ExpireExportJobs :many
UPDATE export_jobs SET status = 'expired' WHERE status = 'ready' AND expires_at < sqlc.arg(now)::timestamptz RETURNING id, object_key;

-- name: RequeueStaleExportJobs :execrows
UPDATE export_jobs SET status = 'queued' WHERE status = 'running' AND created_at < sqlc.arg(before)::timestamptz;

-- name: ListGroupsWithCounts :many
SELECT g.id, g.name, g.description, g.created_at,
       (SELECT COUNT(*) FROM group_members m JOIN users u ON u.id = m.user_id
         WHERE m.group_id = g.id AND u.status <> 'deleted')::int AS member_count
FROM groups g ORDER BY lower(g.name);

-- name: GetGroupWithCount :one
SELECT g.id, g.name, g.description, g.created_at,
       (SELECT COUNT(*) FROM group_members m JOIN users u ON u.id = m.user_id
         WHERE m.group_id = g.id AND u.status <> 'deleted')::int AS member_count
FROM groups g WHERE g.id = $1;

-- name: ListExportFiles :many
SELECT path, blob_hash, size, updated_at FROM files
WHERE vault_id = $1 AND NOT is_deleted AND blob_hash IS NOT NULL ORDER BY path_key;
