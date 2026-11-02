-- Queries of the jobs module (ADR-0033: one sqlc package per module).

-- name: ListUnreferencedBlobs :many
-- Keyset page of the collectable blobs after (after_since, after_hash): a
-- blob that cannot be collected is skipped rather than listed again first.
SELECT hash, unreferenced_since::timestamptz AS unreferenced_since FROM blobs
WHERE ref_count = 0 AND unreferenced_since IS NOT NULL AND unreferenced_since < sqlc.arg(cutoff)::timestamptz
  AND (unreferenced_since, hash) > (sqlc.arg(after_since)::timestamptz, sqlc.arg(after_hash)::text)
ORDER BY unreferenced_since, hash
LIMIT sqlc.arg(max_rows)::int;

-- name: DeleteCollectableBlob :one
-- Deletes the row only if it is still unreferenced past the grace period: a
-- commit that referenced the blob meanwhile keeps it (no row returned).
DELETE FROM blobs
WHERE hash = $1 AND ref_count = 0 AND unreferenced_since IS NOT NULL AND unreferenced_since < $2
RETURNING storage_key;

-- name: ListBlobRefCountsAfter :many
-- Reconciliation, one keyset page of blobs at a time: the stored and the
-- actual number of revisions referencing each blob (file_revisions_blob_ix).
SELECT b.hash, b.ref_count,
       (SELECT COUNT(*) FROM file_revisions r WHERE r.blob_hash = b.hash)::int AS actual
FROM blobs b
WHERE b.hash > sqlc.arg(after)::text
ORDER BY b.hash
LIMIT sqlc.arg(max_rows)::int;

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

-- name: ListExpiredTombstones :many
-- Tombstone purge (ADR-0038): deleted files whose delete revision (the
-- current one) is older than the cutoff, or already gone, one keyset page on
-- (vault, id) at a time (files_tombstone_ix). A tombstone a file share still
-- points at stays: deleting it would violate shares.file_id.
SELECT f.vault_id, f.id FROM files f
LEFT JOIN file_revisions r ON r.file_id = f.id AND r.rev_no = f.current_rev
WHERE f.is_deleted
  AND (f.vault_id, f.id) > (sqlc.arg(after_vault)::uuid, sqlc.arg(after_id)::uuid)
  AND (r.id IS NULL OR r.server_time < sqlc.arg(cutoff)::timestamptz)
  AND NOT EXISTS (SELECT 1 FROM shares s WHERE s.file_id = f.id)
ORDER BY f.vault_id, f.id
LIMIT sqlc.arg(max_rows)::int;

-- name: LockExpiredTombstones :many
-- The candidates of one vault that are still expired tombstones, locked: the
-- caller holds the vault row, so no commit can bring them back meanwhile.
SELECT f.id FROM files f
LEFT JOIN file_revisions r ON r.file_id = f.id AND r.rev_no = f.current_rev
WHERE f.vault_id = sqlc.arg(vault_id)::uuid AND f.id = ANY(sqlc.arg(ids)::uuid[]) AND f.is_deleted
  AND (r.id IS NULL OR r.server_time < sqlc.arg(cutoff)::timestamptz)
  AND NOT EXISTS (SELECT 1 FROM shares s WHERE s.file_id = f.id)
ORDER BY f.id
FOR UPDATE OF f;

-- name: ListFileBlobRefs :many
-- The blob references held by every revision of these files, grouped and in
-- hash order (the order a commit locks blob rows in): what deleting the files
-- releases when their revisions go with them.
SELECT blob_hash::text AS hash, COUNT(*)::int AS refs FROM file_revisions
WHERE file_id = ANY(sqlc.arg(ids)::uuid[]) AND blob_hash IS NOT NULL
GROUP BY blob_hash ORDER BY blob_hash;

-- name: DeleteTombstones :one
-- Deletes the locked tombstones (their revisions go by cascade) and returns
-- the highest changelog seq among them: the compaction point moves past it.
WITH d AS (
  DELETE FROM files WHERE id = ANY(sqlc.arg(ids)::uuid[]) AND is_deleted RETURNING current_seq
)
SELECT COALESCE(MAX(current_seq), 0)::bigint AS max_seq FROM d;

-- name: MarkUserPurged :exec
UPDATE users SET purged_at = now(), keycloak_sub = 'purged:' || id::text, updated_at = now() WHERE id = $1;

-- name: ListUsersToPurge :many
SELECT id FROM users
WHERE status = 'deleted' AND purged_at IS NULL AND COALESCE(deleted_at, updated_at) < $1;

-- name: ListAllVaultIDsOfOwner :many
SELECT id FROM vaults WHERE owner_id = $1;

-- name: VaultHasRevisions :one
SELECT EXISTS (SELECT 1 FROM file_revisions WHERE vault_id = $1);

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

-- name: ListVaultIDsAfter :many
-- Keyset pagination over every vault (maintenance batches).
SELECT id FROM vaults WHERE id > sqlc.arg(after)::uuid ORDER BY id LIMIT sqlc.arg(max_rows)::int;

-- name: CompactVaults :execrows
-- Advances compaction_seq of a batch of vaults to the last changelog entry
-- older than the window, in one statement; it never moves backwards.
UPDATE vaults v SET compaction_seq = m.seq
FROM (
  SELECT r.vault_id, MAX(r.seq)::bigint AS seq FROM file_revisions r
  WHERE r.vault_id = ANY(sqlc.arg(ids)::uuid[]) AND r.server_time < sqlc.arg(before)::timestamptz
  GROUP BY r.vault_id
) m
WHERE v.id = m.vault_id AND m.seq > v.compaction_seq;

-- name: ListDeletedVaultsBefore :many
SELECT id FROM vaults WHERE deleted_at IS NOT NULL AND deleted_at < $1 ORDER BY id;

-- name: DeleteVaultFilesPage :execrows
-- Vault purge, once VaultHasRevisions found none in the same transaction
-- (the vault row lock it holds keeps any from being added, so the cascade
-- drops no revision without releasing its blob reference): one page of its
-- files, in no particular order so that the scan stops at the page size
-- (files_vault_prefix_ix) instead of sorting the whole vault on every page.
-- Files a file share points at stay (the shares go with the vault row).
DELETE FROM files WHERE id IN (
  SELECT f.id FROM files f
  WHERE f.vault_id = sqlc.arg(vault_id)::uuid
    AND NOT EXISTS (SELECT 1 FROM shares s WHERE s.file_id = f.id)
  LIMIT sqlc.arg(max_rows)::int
);

-- name: DeleteVault :exec
DELETE FROM vaults WHERE id = $1;

-- name: ListVaultTotalsAfter :many
-- Source of truth for the nightly usage reconciliation, one keyset page of
-- vaults at a time (files_vault_ix serves each vault's live files).
SELECT v.id AS vault_id,
       v.owner_id,
       v.total_bytes AS stored_bytes,
       v.file_count AS stored_files,
       COALESCE(t.bytes, 0)::bigint AS bytes,
       COALESCE(t.files, 0)::int AS files
FROM vaults v
LEFT JOIN LATERAL (
  SELECT SUM(f.size) AS bytes, COUNT(*) AS files FROM files f WHERE f.vault_id = v.id AND NOT f.is_deleted
) t ON true
WHERE v.id > sqlc.arg(after)::uuid
ORDER BY v.id
LIMIT sqlc.arg(max_rows)::int;

-- name: VaultActualTotals :one
SELECT COALESCE(SUM(size), 0)::bigint AS bytes, COUNT(*)::int AS files
FROM files WHERE vault_id = $1 AND NOT is_deleted;

-- name: SetVaultTotals :exec
UPDATE vaults SET total_bytes = $2, file_count = $3 WHERE id = $1;

-- name: ListUsersWithUsage :many
SELECT id, used_bytes FROM users;
