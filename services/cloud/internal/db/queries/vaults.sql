-- Queries of the vaults module (ADR-0033: one sqlc package per module).

-- name: SoftDeleteVaultsOfOwner :execrows
UPDATE vaults SET deleted_at = now() WHERE owner_id = $1 AND deleted_at IS NULL;

-- name: ListTreePage :many
-- One page of the manifest after the key "after" (path keys of current files
-- are unique, files_path_uq), optionally only below a folder (descendants: an
-- escaped LIKE pattern, '' for the whole vault). A manifest is read page by
-- page inside one REPEATABLE READ snapshot, so it is never held in memory.
SELECT id, path, path_key, kind, current_rev, blob_hash, size FROM files
WHERE vault_id = $1 AND NOT is_deleted AND path_key > sqlc.arg(after)::text
  AND (sqlc.arg(descendants)::text = '' OR path_key LIKE sqlc.arg(descendants)::text ESCAPE '\')
ORDER BY path_key LIMIT sqlc.arg(max_rows)::int;

-- name: GetTreeFile :many
-- The manifest of a document share: its one file, if current.
SELECT id, path, path_key, kind, current_rev, blob_hash, size FROM files
WHERE vault_id = $1 AND id = $2 AND NOT is_deleted;

-- name: CreateVault :one
INSERT INTO vaults (id, owner_id, name, kind, idempotency_key)
VALUES ($1, $2, $3, $4, sqlc.narg('idempotency_key')) RETURNING *;

-- name: GetVaultByIdempotencyKey :one
-- The vault a POST /vaults carrying this Idempotency-Key created, deleted or not.
SELECT * FROM vaults WHERE owner_id = $1 AND idempotency_key = $2;

-- name: GetVault :one
SELECT * FROM vaults WHERE id = $1;

-- name: ListVaultIDsOfOwner :many
-- Every vault of an owner, soft-deleted ones included (their blobs still
-- take space until the purge): the scope of the upload quota check, and of
-- an account deletion, which locks the rows in this order (vault first, then
-- the owner's usage, as a commit does).
SELECT id FROM vaults WHERE owner_id = $1 ORDER BY id;

-- name: ListOwnedVaults :many
SELECT * FROM vaults WHERE owner_id = $1 AND deleted_at IS NULL ORDER BY lower(name), created_at;

-- name: ListOwnedVaultsWithDeleted :many
-- The owner's vaults plus the soft-deleted ones still restorable (deleted after
-- deleted_after, i.e. within the retention period).
SELECT * FROM vaults
WHERE owner_id = $1 AND (deleted_at IS NULL OR deleted_at > sqlc.arg(deleted_after)::timestamptz)
ORDER BY lower(name), created_at;

-- name: RenameVault :one
UPDATE vaults SET name = $2 WHERE id = $1 AND deleted_at IS NULL RETURNING *;

-- name: SoftDeleteVault :execrows
UPDATE vaults SET deleted_at = now() WHERE id = $1 AND deleted_at IS NULL;

-- name: RestoreVault :one
UPDATE vaults SET deleted_at = NULL WHERE id = $1 AND deleted_at IS NOT NULL RETURNING *;

-- name: NextVaultSeq :one
-- Takes the per-vault row lock that totally orders the changelog; the lock is
-- held until the surrounding transaction ends.
UPDATE vaults SET last_seq = last_seq + 1 WHERE id = $1 RETURNING last_seq;

-- name: LockVault :one
-- Takes the same per-vault row lock as NextVaultSeq up front. FOR NO KEY
-- UPDATE (what an UPDATE of non-key columns takes) leaves the foreign-key
-- checks of rows referencing the vault (blob uploads, shares) unblocked.
SELECT id FROM vaults WHERE id = $1 FOR NO KEY UPDATE;

-- name: LockVaultSeq :one
-- LockVault for a commit batch: the same row lock, plus the changelog position
-- the batch continues from (it hands out the next seqs itself while holding
-- the lock and stores the last one with FinishVaultBatch).
SELECT last_seq FROM vaults WHERE id = $1 FOR NO KEY UPDATE;

-- name: FinishVaultBatch :exec
-- End of a commit batch: one update of the hot vault row instead of two per
-- operation (NextVaultSeq, AddVaultUsage).
UPDATE vaults SET last_seq = GREATEST(last_seq, sqlc.arg(last_seq)::bigint),
  total_bytes = total_bytes + sqlc.arg(total_bytes)::bigint, file_count = file_count + sqlc.arg(file_count)::int
WHERE id = $1;

-- name: AdvanceCompaction :exec
-- Changelog entries up to seq are no longer served (cursors before it expire).
UPDATE vaults SET compaction_seq = GREATEST(compaction_seq, sqlc.arg(seq)::bigint) WHERE id = $1;

-- name: AddVaultUsage :exec
UPDATE vaults SET total_bytes = total_bytes + $2, file_count = file_count + $3 WHERE id = $1;

-- name: ListEnvelopes :many
SELECT * FROM vault_key_envelopes WHERE vault_id = $1 ORDER BY kind;

-- name: UpsertEnvelope :one
INSERT INTO vault_key_envelopes (id, vault_id, kind, kdf, wrapped_vmk)
VALUES ($1, $2, $3, $4, $5)
ON CONFLICT (vault_id, kind) DO UPDATE SET kdf = EXCLUDED.kdf, wrapped_vmk = EXCLUDED.wrapped_vmk, created_at = now()
RETURNING *;
