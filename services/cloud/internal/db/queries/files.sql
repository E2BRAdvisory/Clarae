-- name: GetFile :one
SELECT * FROM files WHERE id = $1 AND vault_id = $2;

-- name: GetFileForUpdate :one
SELECT * FROM files WHERE id = $1 AND vault_id = $2 FOR UPDATE;

-- name: FileIDExists :one
SELECT EXISTS (SELECT 1 FROM files WHERE id = $1);

-- name: InsertFile :exec
INSERT INTO files (id, vault_id, path, path_key, kind, current_rev, current_seq, blob_hash, size, is_deleted)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, FALSE);

-- name: UpdateFile :exec
UPDATE files SET path = $2, path_key = $3, kind = $4, current_rev = $5, current_seq = $6,
  blob_hash = $7, size = $8, is_deleted = $9, updated_at = now()
WHERE id = $1;

-- name: ListFilesUnderPrefix :many
-- Locks the affected rows in a stable order (deadlock avoidance).
SELECT * FROM files
WHERE vault_id = $1 AND NOT is_deleted AND (path_key = sqlc.arg(exact)::text OR path_key LIKE sqlc.arg(descendants)::text ESCAPE '\')
ORDER BY id FOR UPDATE;

-- name: ListTree :many
SELECT id, path, kind, current_rev, blob_hash, size FROM files
WHERE vault_id = $1 AND NOT is_deleted ORDER BY path_key;

-- name: PathKeyTaken :one
SELECT id FROM files WHERE vault_id = $1 AND path_key = $2 AND NOT is_deleted LIMIT 1;

-- name: PurgeDeletedFiles :execrows
-- Tombstones whose every revision is gone.
DELETE FROM files f WHERE f.is_deleted AND f.vault_id = $1
  AND NOT EXISTS (SELECT 1 FROM file_revisions r WHERE r.file_id = f.id);
