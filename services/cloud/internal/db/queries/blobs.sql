-- Queries of the blobs module (ADR-0033: one sqlc package per module).

-- name: GetBlob :one
SELECT * FROM blobs WHERE hash = $1;

-- name: GetBlobKeyShare :one
-- A commit locks the blob it references until it has added its reference,
-- so the garbage collector cannot delete it in between (CollectBlobs). KEY
-- SHARE blocks only DELETE: concurrent commits still update ref_count.
SELECT * FROM blobs WHERE hash = $1 FOR KEY SHARE;

-- name: GetVaultBlobKeyShare :one
-- VaultHasBlob and GetBlobKeyShare in one round trip: the size of a blob the
-- vault uploaded, locked against the garbage collector like GetBlobKeyShare.
SELECT b.size FROM vault_blobs vb JOIN blobs b ON b.hash = vb.hash
WHERE vb.vault_id = $1 AND vb.hash = $2
FOR KEY SHARE OF b;

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

-- name: AddBlobRefs :exec
-- AddBlobRef for many blobs in one statement (end of a commit batch). The rows
-- are locked in hash order first, like the one-by-one version did, so
-- concurrent batches never deadlock on them.
WITH d AS (
  SELECT unnest(sqlc.arg(hashes)::text[]) AS hash, unnest(sqlc.arg(deltas)::int[]) AS delta
), locked AS (
  SELECT b.hash FROM blobs b WHERE b.hash = ANY(sqlc.arg(hashes)::text[]) ORDER BY b.hash FOR NO KEY UPDATE
)
UPDATE blobs SET ref_count = blobs.ref_count + d.delta,
  unreferenced_since = CASE WHEN blobs.ref_count + d.delta = 0 THEN now() ELSE NULL END
FROM d JOIN locked l ON l.hash = d.hash
WHERE blobs.hash = d.hash;

-- name: CreateUpload :one
INSERT INTO uploads (id, vault_id, user_id, expected_hash, length, expires_at)
VALUES ($1, $2, $3, $4, $5, $6) RETURNING *;

-- name: GetUpload :one
SELECT * FROM uploads WHERE id = $1;

-- name: AdvanceUpload :execrows
-- Confirms a chunk stored at offset from in its own object: only one PATCH can
-- move the offset on (no row lock is held while the chunk streams in).
UPDATE uploads SET received = received + sqlc.arg(size)::bigint, chunks = chunks + 1,
  chunk_keys = array_append(chunk_keys, sqlc.arg(chunk_key)::text)
WHERE id = $1 AND received = sqlc.arg(from_offset)::bigint;

-- name: DeleteUpload :exec
DELETE FROM uploads WHERE id = $1;

-- name: ListExpiredUploads :many
SELECT * FROM uploads WHERE expires_at < now() LIMIT $1;

-- name: LockOwnerUploads :exec
-- Serializes the upload quota checks of one owner (key: the owner's id) until
-- the transaction ends.
SELECT pg_advisory_xact_lock(hashtextextended(sqlc.arg(key)::text, 0));

-- name: PendingUploadBytes :one
-- Storage an owner's vaults hold but nobody pays for yet (D-03 charges only
-- committed files): blobs uploaded within the window that no revision
-- references, plus the announced length of the resumable uploads in progress
-- (except_upload: the one being finalized, counted as its blob instead).
SELECT (
  COALESCE((SELECT sum(b.size) FROM blobs b JOIN vault_blobs vb ON vb.hash = b.hash
            WHERE b.ref_count = 0 AND vb.vault_id = ANY(sqlc.arg(vault_ids)::uuid[])
              AND vb.created_at > sqlc.arg(since)::timestamptz), 0)
  + COALESCE((SELECT sum(u.length) FROM uploads u
              WHERE u.vault_id = ANY(sqlc.arg(vault_ids)::uuid[]) AND u.expires_at > now()
                AND u.id <> sqlc.arg(except_upload)::uuid), 0)
)::bigint AS pending;

-- name: ListBlobFiles :many
-- The files (by current path) that have a revision with this blob: what a share read is checked against.
SELECT DISTINCT f.id, f.path FROM file_revisions r JOIN files f ON f.id = r.file_id
WHERE r.vault_id = $1 AND r.blob_hash = $2
LIMIT 500;
