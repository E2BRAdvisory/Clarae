-- Queries of the settings module (ADR-0033: one sqlc package per module).

-- name: BumpConfigRevision :one
UPDATE settings SET value = to_jsonb((value #>> '{}')::bigint + 1), updated_at = now()
WHERE key = 'config.revision' RETURNING (value #>> '{}')::bigint AS revision;

-- name: GetConfigRevision :one
SELECT (value #>> '{}')::bigint AS revision FROM settings WHERE key = 'config.revision';

-- name: GetSetting :one
SELECT value FROM settings WHERE key = $1;

-- name: UpsertSetting :exec
INSERT INTO settings (key, value, updated_by, updated_at)
VALUES ($1, $2, $3, now())
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now();
