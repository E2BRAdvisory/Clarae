-- Queries of the jobs module (ADR-0033: one sqlc package per module).

-- name: ListUnreferencedBlobs :many
SELECT hash, storage_key FROM blobs
WHERE ref_count = 0 AND unreferenced_since IS NOT NULL AND unreferenced_since < $1
ORDER BY unreferenced_since LIMIT $2;

-- name: DeleteCollectableBlob :one
-- Deletes the row only if it is still unreferenced past the grace period: a
-- commit that referenced the blob meanwhile keeps it (no row returned).
DELETE FROM blobs
WHERE hash = $1 AND ref_count = 0 AND unreferenced_since IS NOT NULL AND unreferenced_since < $2
RETURNING storage_key;

-- name: ListBlobRefCounts :many
-- Reconciliation: actual number of revisions referencing each blob.
SELECT b.hash, b.ref_count, COUNT(r.id)::int AS actual
FROM blobs b LEFT JOIN file_revisions r ON r.blob_hash = b.hash
GROUP BY b.hash, b.ref_count
HAVING b.ref_count <> COUNT(r.id);

-- name: GetBlobRefForUpdate :one
-- Reconciliation locks the blob before counting, so the count includes every
-- change whose reference delta is already applied (see ReconcileBlobRefs).
SELECT ref_count FROM blobs WHERE hash = $1 FOR UPDATE;

-- name: CountBlobRefs :one
SELECT COUNT(*)::int FROM file_revisions WHERE blob_hash = $1;

-- name: SetBlobRef :exec
UPDATE blobs SET ref_count = $2,
  unreferenced_since = CASE WHEN $2 = 0 THEN COALESCE(unreferenced_since, now()) ELSE NULL END
WHERE hash = $1;

-- name: PurgeDeletedFiles :execrows
-- Tombstones whose every revision is gone.
DELETE FROM files f WHERE f.is_deleted AND f.vault_id = $1
  AND NOT EXISTS (SELECT 1 FROM file_revisions r WHERE r.file_id = f.id);

-- name: MarkUserPurged :exec
UPDATE users SET purged_at = now(), keycloak_sub = 'purged:' || id::text, updated_at = now() WHERE id = $1;

-- name: ListUsersToPurge :many
SELECT id FROM users
WHERE status = 'deleted' AND purged_at IS NULL AND COALESCE(deleted_at, updated_at) < $1;

-- name: ListAllVaultIDsOfOwner :many
SELECT id FROM vaults WHERE owner_id = $1;

-- name: MaxSeqBefore :one
SELECT COALESCE(MAX(seq), 0)::bigint FROM file_revisions WHERE vault_id = $1 AND server_time < $2;

-- name: ListRevisionBlobs :many
SELECT blob_hash FROM file_revisions WHERE vault_id = $1 AND blob_hash IS NOT NULL;

-- name: GetUserUsedForUpdate :one
SELECT used_bytes FROM users WHERE id = $1 FOR UPDATE;

-- name: OwnerActualUsage :one
-- Bytes of the live files in every vault of an owner, soft-deleted vaults
-- included (their quota is released when they are purged).
SELECT COALESCE(SUM(f.size), 0)::bigint FROM files f JOIN vaults v ON v.id = f.vault_id
WHERE v.owner_id = $1 AND NOT f.is_deleted;

-- name: SetUserUsed :exec
UPDATE users SET used_bytes = $2 WHERE id = $1;

-- name: GetVaultForUpdate :one
SELECT * FROM vaults WHERE id = $1 FOR UPDATE;

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
       v.total_bytes AS stored_bytes,
       v.file_count AS stored_files,
       COALESCE(SUM(f.size) FILTER (WHERE NOT f.is_deleted), 0)::bigint AS bytes,
       COUNT(f.id) FILTER (WHERE NOT f.is_deleted)::int AS files
FROM vaults v LEFT JOIN files f ON f.vault_id = v.id
GROUP BY v.id, v.owner_id, v.total_bytes, v.file_count;

-- name: VaultActualTotals :one
SELECT COALESCE(SUM(size), 0)::bigint AS bytes, COUNT(*)::int AS files
FROM files WHERE vault_id = $1 AND NOT is_deleted;

-- name: SetVaultTotals :exec
UPDATE vaults SET total_bytes = $2, file_count = $3 WHERE id = $1;

-- name: ListUsersWithUsage :many
SELECT id, used_bytes FROM users;
