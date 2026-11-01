-- Queries of the revisions module (ADR-0033: one sqlc package per module).

-- name: GetFile :one
SELECT * FROM files WHERE id = $1 AND vault_id = $2;

-- name: GetRevision :one
SELECT * FROM file_revisions WHERE vault_id = $1 AND file_id = $2 AND rev_no = $3;

-- name: ListRevisions :many
SELECT * FROM file_revisions
WHERE vault_id = $1 AND file_id = $2 AND (sqlc.arg(before_rev)::int = 0 OR rev_no < sqlc.arg(before_rev)::int)
ORDER BY rev_no DESC LIMIT sqlc.arg(max_rows)::int;

-- name: ListRevisionsForRetention :many
-- Candidates for pruning: every revision older than the cutoff that is not the
-- current revision of its file, one page after the keyset (file, time, id).
SELECT r.id, r.vault_id, r.file_id, r.blob_hash, r.server_time
FROM file_revisions r JOIN files f ON f.id = r.file_id
WHERE r.server_time < sqlc.arg(cutoff)::timestamptz AND r.rev_no <> f.current_rev
  AND (r.file_id, r.server_time, r.id) > (sqlc.arg(after_file)::uuid, sqlc.arg(after_time)::timestamptz, sqlc.arg(after_id)::uuid)
ORDER BY r.file_id, r.server_time, r.id
LIMIT sqlc.arg(max_rows)::int;

-- name: DeleteRevisions :many
DELETE FROM file_revisions WHERE id = ANY($1::uuid[]) RETURNING vault_id, seq, op, blob_hash;
