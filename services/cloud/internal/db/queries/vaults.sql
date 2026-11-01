-- Queries of the vaults module (ADR-0033: one sqlc package per module).

-- name: SoftDeleteVaultsOfOwner :execrows
UPDATE vaults SET deleted_at = now() WHERE owner_id = $1 AND deleted_at IS NULL;

-- name: ListTree :many
SELECT id, path, kind, current_rev, blob_hash, size FROM files
WHERE vault_id = $1 AND NOT is_deleted ORDER BY path_key;

-- name: CreateVault :one
INSERT INTO vaults (id, owner_id, name, kind) VALUES ($1, $2, $3, $4) RETURNING *;

-- name: GetVault :one
SELECT * FROM vaults WHERE id = $1;

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
