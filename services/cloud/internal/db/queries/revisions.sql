-- name: InsertRevision :one
INSERT INTO file_revisions (id, file_id, vault_id, seq, rev_no, op, path, prev_path, blob_hash, size,
                            base_rev, author_id, device_id, op_id, client_mtime, conflict_of)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
RETURNING *;

-- name: GetRevisionByOpID :one
SELECT * FROM file_revisions WHERE vault_id = $1 AND op_id = $2;

-- name: GetRevision :one
SELECT * FROM file_revisions WHERE vault_id = $1 AND file_id = $2 AND rev_no = $3;

-- name: GetCurrentRevisionID :one
SELECT id FROM file_revisions WHERE file_id = $1 AND rev_no = $2;

-- name: ListChanges :many
SELECT r.*, COALESCE((SELECT c.file_id FROM file_revisions c WHERE c.id = r.conflict_of), '00000000-0000-0000-0000-000000000000'::uuid)::uuid AS conflict_of_file
FROM file_revisions r
WHERE r.vault_id = $1 AND r.seq > $2
ORDER BY r.seq LIMIT $3;

-- name: ListRevisions :many
SELECT * FROM file_revisions
WHERE vault_id = $1 AND file_id = $2 AND (sqlc.arg(before_rev)::int = 0 OR rev_no < sqlc.arg(before_rev)::int)
ORDER BY rev_no DESC LIMIT sqlc.arg(max_rows)::int;

-- name: ListRevisionsForRetention :many
-- Candidates for pruning: every revision older than the cutoff that is not the
-- current revision of its file.
SELECT r.id, r.vault_id, r.file_id, r.blob_hash, r.server_time
FROM file_revisions r JOIN files f ON f.id = r.file_id
WHERE r.server_time < $1 AND r.rev_no <> f.current_rev
ORDER BY r.file_id, r.server_time
LIMIT $2;

-- name: DeleteRevisions :many
DELETE FROM file_revisions WHERE id = ANY($1::uuid[]) RETURNING blob_hash;

-- name: MaxSeqBefore :one
SELECT COALESCE(MAX(seq), 0)::bigint FROM file_revisions WHERE vault_id = $1 AND server_time < $2;

-- name: ListRevisionBlobs :many
SELECT blob_hash FROM file_revisions WHERE vault_id = $1 AND blob_hash IS NOT NULL;

-- name: UserUsedBytes :one
SELECT used_bytes FROM users WHERE id = $1;

-- name: ChargeUser :execrows
-- Atomic quota check and charge: a negative quota means unlimited.
UPDATE users SET used_bytes = used_bytes + sqlc.arg(delta)::bigint, updated_at = now()
WHERE id = $1 AND (sqlc.arg(delta)::bigint <= 0 OR sqlc.arg(quota)::bigint < 0 OR used_bytes + sqlc.arg(delta)::bigint <= sqlc.arg(quota)::bigint);

-- name: ListUserUsage :many
SELECT v.owner_id, COALESCE(SUM(v.total_bytes), 0)::bigint AS bytes
FROM vaults v GROUP BY v.owner_id;

-- name: SetUserUsed :exec
UPDATE users SET used_bytes = $2 WHERE id = $1;
