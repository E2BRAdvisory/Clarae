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
