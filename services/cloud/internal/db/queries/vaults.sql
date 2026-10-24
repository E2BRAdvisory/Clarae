-- name: CreateVault :one
INSERT INTO vaults (id, owner_id, name, kind) VALUES ($1, $2, $3, $4) RETURNING *;

-- name: GetVault :one
SELECT * FROM vaults WHERE id = $1;

-- name: GetVaultForUpdate :one
SELECT * FROM vaults WHERE id = $1 FOR UPDATE;

-- name: ListOwnedVaults :many
SELECT * FROM vaults WHERE owner_id = $1 AND deleted_at IS NULL ORDER BY lower(name), created_at;

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

-- name: AddVaultUsage :exec
UPDATE vaults SET total_bytes = total_bytes + $2, file_count = file_count + $3 WHERE id = $1;

-- name: SetVaultCompaction :exec
UPDATE vaults SET compaction_seq = GREATEST(compaction_seq, $2) WHERE id = $1;

-- name: ListDeletedVaultsBefore :many
SELECT id FROM vaults WHERE deleted_at IS NOT NULL AND deleted_at < $1;

-- name: DeleteVault :exec
DELETE FROM vaults WHERE id = $1;

-- name: ListVaultTotals :many
-- Source of truth for the nightly usage reconciliation.
SELECT v.id AS vault_id,
       v.owner_id,
       COALESCE(SUM(f.size) FILTER (WHERE NOT f.is_deleted), 0)::bigint AS bytes,
       COUNT(f.id) FILTER (WHERE NOT f.is_deleted)::int AS files
FROM vaults v LEFT JOIN files f ON f.vault_id = v.id
GROUP BY v.id, v.owner_id;

-- name: SetVaultTotals :exec
UPDATE vaults SET total_bytes = $2, file_count = $3 WHERE id = $1;

-- name: ListVaultsOfOwners :many
SELECT id, owner_id, last_seq FROM vaults WHERE owner_id = $1 AND deleted_at IS NULL;

-- name: GetVaultOwner :one
SELECT owner_id, deleted_at FROM vaults WHERE id = $1;

-- name: ListEnvelopes :many
SELECT * FROM vault_key_envelopes WHERE vault_id = $1 ORDER BY kind;

-- name: UpsertEnvelope :one
INSERT INTO vault_key_envelopes (id, vault_id, kind, kdf, wrapped_vmk)
VALUES ($1, $2, $3, $4, $5)
ON CONFLICT (vault_id, kind) DO UPDATE SET kdf = EXCLUDED.kdf, wrapped_vmk = EXCLUDED.wrapped_vmk, created_at = now()
RETURNING *;

-- name: ListUsersWithUsage :many
SELECT id, used_bytes FROM users;
