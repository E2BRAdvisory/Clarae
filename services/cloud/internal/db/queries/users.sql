-- Queries of the users module (ADR-0033: one sqlc package per module).

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

-- name: CountActiveAdmins :one
SELECT COUNT(*)::int FROM users WHERE role = 'admin' AND status = 'active';

-- name: ListDevices :many
SELECT * FROM devices
WHERE user_id = $1 AND revoked_at IS NULL
ORDER BY created_at;

-- name: GetDevice :one
SELECT * FROM devices WHERE id = $1 AND user_id = $2;

-- name: CreateDevice :one
INSERT INTO devices (id, user_id, name, platform, app_version, last_seen_at)
VALUES ($1, $2, $3, $4, $5, now())
RETURNING *;

-- name: TouchDevice :exec
UPDATE devices SET last_seen_at = now(), app_version = COALESCE(sqlc.narg('app_version'), app_version)
WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL;

-- name: RevokeDevice :execrows
UPDATE devices SET revoked_at = now()
WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL;

-- name: SearchDirectoryUsers :many
SELECT id, username, display_name FROM users
WHERE status = 'active'
  AND (sqlc.arg(q)::text = ''
       OR username ILIKE '%' || sqlc.arg(q)::text || '%'
       OR email::text ILIKE '%' || sqlc.arg(q)::text || '%'
       OR display_name ILIKE '%' || sqlc.arg(q)::text || '%')
ORDER BY lower(username)
LIMIT sqlc.arg(max_rows)::int;

-- name: GetUserBrief :one
SELECT id, username, display_name, status FROM users WHERE id = $1;

-- name: GetUserByID :one
SELECT * FROM users WHERE id = $1;

-- name: UpsertUserFromToken :one
-- Just-in-time provisioning on login: creates the user on first sight and
-- refreshes profile fields and the realm role mirror afterwards.
INSERT INTO users (id, keycloak_sub, username, email, display_name, role, status, last_login_at)
VALUES ($1, $2, $3, $4, $5, $6, 'active', now())
ON CONFLICT (keycloak_sub) DO UPDATE SET
  -- A deleted account keeps its tombstone: a token must never write personal data back.
  username      = CASE WHEN users.status = 'deleted' THEN users.username      ELSE EXCLUDED.username     END,
  email         = CASE WHEN users.status = 'deleted' THEN users.email         ELSE EXCLUDED.email        END,
  display_name  = CASE WHEN users.status = 'deleted' THEN users.display_name  ELSE EXCLUDED.display_name END,
  role          = CASE WHEN users.status = 'deleted' THEN users.role          ELSE EXCLUDED.role         END,
  last_login_at = CASE WHEN users.status = 'deleted' THEN users.last_login_at ELSE now()                 END,
  updated_at    = CASE WHEN users.status = 'deleted' THEN users.updated_at    ELSE now()                 END
RETURNING *;
