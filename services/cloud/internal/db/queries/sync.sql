-- Queries of the sync module (ADR-0033: one sqlc package per module).

-- name: ListExportFiles :many
SELECT path, blob_hash, size, updated_at FROM files
WHERE vault_id = $1 AND NOT is_deleted AND blob_hash IS NOT NULL ORDER BY path_key;

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

-- name: PathKeyTaken :one
SELECT id FROM files WHERE vault_id = $1 AND path_key = $2 AND NOT is_deleted LIMIT 1;

-- name: CountFilesUnderPrefix :one
SELECT count(*)::int FROM files
WHERE vault_id = $1 AND NOT is_deleted AND (path_key = sqlc.arg(exact)::text OR path_key LIKE sqlc.arg(descendants)::text ESCAPE '\');

-- name: InsertRevision :one
INSERT INTO file_revisions (id, file_id, vault_id, seq, rev_no, op, path, prev_path, blob_hash, size,
                            base_rev, author_id, device_id, op_id, client_mtime, conflict_of, conflict_of_file)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)
RETURNING *;

-- name: GetRevisionByOpID :one
SELECT * FROM file_revisions WHERE vault_id = $1 AND op_id = $2;

-- name: GetRevision :one
SELECT * FROM file_revisions WHERE vault_id = $1 AND file_id = $2 AND rev_no = $3;

-- name: GetCurrentRevisionID :one
SELECT id FROM file_revisions WHERE file_id = $1 AND rev_no = $2;

-- name: ListChanges :many
-- conflict_of_file is stored at commit time: the revision conflict_of points
-- at may be pruned meanwhile.
SELECT * FROM file_revisions
WHERE vault_id = $1 AND seq > $2
ORDER BY seq LIMIT $3;
