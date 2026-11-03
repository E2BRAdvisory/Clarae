-- Queries of the revisions module (ADR-0033: one sqlc package per module).

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

-- name: DeleteVaultRevisionsPage :many
-- Purge of a deleted vault (jobs module): one page of its revisions, oldest
-- first, and the blob references they held grouped by hash, in hash order
-- (the order a commit locks blob rows in); a NULL hash counts the revisions
-- without content. Rows another transaction holds (retention) are skipped
-- rather than waited for: retention locks them before the vault row, the
-- purge after it.
WITH d AS (
  DELETE FROM file_revisions WHERE id IN (
    SELECT r.id FROM file_revisions r WHERE r.vault_id = sqlc.arg(vault_id)::uuid
    ORDER BY r.seq LIMIT sqlc.arg(max_rows)::int
    FOR UPDATE SKIP LOCKED
  ) RETURNING blob_hash
)
SELECT d.blob_hash, COUNT(*)::int AS refs FROM d GROUP BY d.blob_hash ORDER BY d.blob_hash NULLS LAST;
