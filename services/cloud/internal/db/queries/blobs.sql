-- Queries of the blobs module (ADR-0033: one sqlc package per module).

-- name: GetBlob :one
SELECT * FROM blobs WHERE hash = $1;

-- name: GetBlobKeyShare :one
-- A commit locks the blob it references until it has added its reference,
-- so the garbage collector cannot delete it in between (CollectBlobs). KEY
-- SHARE blocks only DELETE: concurrent commits still update ref_count.
SELECT * FROM blobs WHERE hash = $1 FOR KEY SHARE;

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

-- name: ListBlobFiles :many
-- The files (by current path) that have a revision with this blob: what a share read is checked against.
SELECT DISTINCT f.id, f.path FROM file_revisions r JOIN files f ON f.id = r.file_id
WHERE r.vault_id = $1 AND r.blob_hash = $2
LIMIT 500;
