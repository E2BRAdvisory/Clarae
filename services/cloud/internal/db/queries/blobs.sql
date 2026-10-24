-- name: GetBlob :one
SELECT * FROM blobs WHERE hash = $1;

-- name: InsertBlob :execrows
INSERT INTO blobs (hash, size, storage_key) VALUES ($1, $2, $3) ON CONFLICT (hash) DO NOTHING;

-- name: LinkVaultBlob :exec
INSERT INTO vault_blobs (vault_id, hash) VALUES ($1, $2) ON CONFLICT DO NOTHING;

-- name: VaultHasBlob :one
SELECT EXISTS (SELECT 1 FROM vault_blobs WHERE vault_id = $1 AND hash = $2);

-- name: ListVaultBlobsAmong :many
SELECT hash FROM vault_blobs WHERE vault_id = $1 AND hash = ANY(sqlc.arg(hashes)::text[]);

-- name: AddBlobRef :exec
UPDATE blobs SET ref_count = ref_count + $2,
  unreferenced_since = CASE WHEN ref_count + $2 = 0 THEN now() ELSE NULL END
WHERE hash = $1;

-- name: ListUnreferencedBlobs :many
SELECT hash, storage_key FROM blobs
WHERE ref_count = 0 AND unreferenced_since IS NOT NULL AND unreferenced_since < $1
ORDER BY unreferenced_since LIMIT $2;

-- name: DeleteBlobRow :exec
DELETE FROM blobs WHERE hash = $1 AND ref_count = 0;

-- name: ListBlobRefCounts :many
-- Reconciliation: actual number of revisions referencing each blob.
SELECT b.hash, b.ref_count, COUNT(r.id)::int AS actual
FROM blobs b LEFT JOIN file_revisions r ON r.blob_hash = b.hash
GROUP BY b.hash, b.ref_count
HAVING b.ref_count <> COUNT(r.id);

-- name: SetBlobRef :exec
UPDATE blobs SET ref_count = $2,
  unreferenced_since = CASE WHEN $2 = 0 THEN COALESCE(unreferenced_since, now()) ELSE NULL END
WHERE hash = $1;

-- name: CreateUpload :one
INSERT INTO uploads (id, vault_id, user_id, expected_hash, length, expires_at)
VALUES ($1, $2, $3, $4, $5, $6) RETURNING *;

-- name: GetUploadForUpdate :one
SELECT * FROM uploads WHERE id = $1 FOR UPDATE;

-- name: GetUpload :one
SELECT * FROM uploads WHERE id = $1;

-- name: AdvanceUpload :exec
UPDATE uploads SET received = received + $2, chunks = chunks + 1 WHERE id = $1;

-- name: DeleteUpload :exec
DELETE FROM uploads WHERE id = $1;

-- name: ListExpiredUploads :many
SELECT id, chunks FROM uploads WHERE expires_at < now() LIMIT $1;
