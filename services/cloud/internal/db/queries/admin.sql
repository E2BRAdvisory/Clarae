-- Queries of the admin module (ADR-0033: one sqlc package per module).

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

-- name: ListVaultsOfUserAdmin :many
SELECT id, name, kind, total_bytes, file_count, created_at, deleted_at
FROM vaults WHERE owner_id = $1 ORDER BY lower(name);

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
