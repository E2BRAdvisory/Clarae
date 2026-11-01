-- Queries of the users module (ADR-0033: one sqlc package per module).

-- name: InsertProvisionedUser :one
-- A user created by an administrator: the row exists before the first login,
-- which then links to it through the Keycloak subject.
INSERT INTO users (id, keycloak_sub, username, email, display_name, role, status)
VALUES ($1, $2, $3, $4, $5, $6, 'active') RETURNING *;

-- name: SetUserStatus :one
UPDATE users SET status = $2, updated_at = now() WHERE id = $1 AND status <> 'deleted' RETURNING *;

-- name: SetUserRole :one
-- role_changed_at makes the new role authoritative over tokens issued before
-- the change (see UpsertUserFromToken).
UPDATE users SET role = $2, role_changed_at = now(), updated_at = now()
WHERE id = $1 AND status <> 'deleted' RETURNING *;

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

-- name: LockActiveAdmins :many
-- Takes the row lock of every active administrator, in id order, so the
-- operations that can remove one (suspension, deletion, demotion) serialise
-- their last-admin check: the count that follows sees every committed change.
SELECT id FROM users WHERE role = 'admin' AND status = 'active' ORDER BY id FOR UPDATE;

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
-- Substring match on username and display name (pattern is q with the LIKE
-- wildcards escaped); the e-mail matches only exactly, case-insensitively, so
-- the directory cannot be used to guess addresses piece by piece (ADR-0041).
SELECT id, username, display_name FROM users
WHERE status = 'active'
  AND (sqlc.arg(q)::text = ''
       OR username ILIKE '%' || sqlc.arg(pattern)::text || '%'
       OR display_name ILIKE '%' || sqlc.arg(pattern)::text || '%'
       OR email = sqlc.arg(q)::citext)
ORDER BY lower(username)
LIMIT sqlc.arg(max_rows)::int;

-- name: GetUserBrief :one
SELECT id, username, display_name, status FROM users WHERE id = $1;

-- name: GetUserByID :one
SELECT * FROM users WHERE id = $1;

-- name: GetUserBySub :one
-- The read path of just-in-time provisioning: most requests find the row
-- unchanged and write nothing.
SELECT * FROM users WHERE keycloak_sub = $1;

-- name: UpsertUserFromToken :one
-- Just-in-time provisioning on login: creates the user on first sight and
-- refreshes profile fields and the realm role mirror afterwards. The role
-- comes from the token only when the token was issued after the last role
-- change made by an administrator (issued_at is the token's iat): an older
-- token still carries the previous role and must not restore it (ADR-0041).
INSERT INTO users (id, keycloak_sub, username, email, display_name, role, status, last_login_at)
VALUES (sqlc.arg(id), sqlc.arg(keycloak_sub), sqlc.arg(username), sqlc.arg(email), sqlc.narg(display_name),
        sqlc.arg(role), 'active', now())
ON CONFLICT (keycloak_sub) DO UPDATE SET
  -- A deleted account keeps its tombstone: a token must never write personal data back.
  username      = CASE WHEN users.status = 'deleted' THEN users.username      ELSE EXCLUDED.username     END,
  email         = CASE WHEN users.status = 'deleted' THEN users.email         ELSE EXCLUDED.email        END,
  display_name  = CASE WHEN users.status = 'deleted' THEN users.display_name  ELSE EXCLUDED.display_name END,
  role          = CASE WHEN users.status = 'deleted' THEN users.role
                       WHEN users.role_changed_at IS NOT NULL AND sqlc.arg(issued_at)::timestamptz <= users.role_changed_at THEN users.role
                       ELSE EXCLUDED.role END,
  -- A suspended account does not log in: its last login stays the real one.
  last_login_at = CASE WHEN users.status IN ('deleted', 'suspended') THEN users.last_login_at ELSE now() END,
  updated_at    = CASE WHEN users.status = 'deleted' THEN users.updated_at    ELSE now()                 END
RETURNING *;
