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

-- name: LockBlobHash :exec
-- Serializes, per hash, the publication of a blob row with the deletion of
-- its object by the garbage collector until the transaction ends: under this
-- lock a row is inserted only once its object is verified, and the collector
-- deletes an object only when no row exists (see ingestFile and LockObject).
SELECT pg_advisory_xact_lock(hashtextextended('memobrain.blob:' || sqlc.arg(hash)::text, 0));

-- name: RenewUnreferencedBlob :exec
-- An upload linking a blob nobody references restarts its grace period: the
-- garbage collector must not take it right after a deduplicated upload.
UPDATE blobs SET unreferenced_since = now() WHERE hash = $1 AND ref_count = 0;

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
-- concurrent batches never deadlock on them. The hashes are compared as
-- CHAR(64), the type of blobs.hash: compared as text the primary key cannot
-- be used and every call scanned the whole table twice.
WITH d AS (
  SELECT unnest(sqlc.arg(hashes)::text[])::char(64) AS hash, unnest(sqlc.arg(deltas)::int[]) AS delta
), locked AS (
  SELECT b.hash FROM blobs b WHERE b.hash = ANY(sqlc.arg(hashes)::text[]::char(64)[]) ORDER BY b.hash FOR NO KEY UPDATE
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

-- name: ClaimUploadFinalization :execrows
-- Takes the finalization of a complete upload for lease_seconds: one request
-- assembles the chunks, the others wait for it (or take over once the lease
-- of a finalizer that died has run out).
UPDATE uploads SET finalizing_until = now() + make_interval(secs => sqlc.arg(lease_seconds)::double precision)
WHERE id = $1 AND received = length AND (finalizing_until IS NULL OR finalizing_until < now());

-- name: ReleaseUploadFinalization :exec
-- A finalization that failed for a transient reason lets the next retry in at once.
UPDATE uploads SET finalizing_until = NULL WHERE id = $1;

-- name: ListExpiredUploads :many
-- Keyset page of the expired uploads (a failing one does not hide the
-- others); an upload being finalized is left to its finalizer.
SELECT * FROM uploads
WHERE expires_at < now() AND (finalizing_until IS NULL OR finalizing_until < now())
  AND id > sqlc.arg(after)::uuid
ORDER BY id
LIMIT sqlc.arg(max_rows)::int;

-- name: ListUploadsOfVault :many
-- The uploads in progress in a vault, whose chunks the purge of the vault deletes.
SELECT * FROM uploads WHERE vault_id = $1;

-- name: ListExistingUploads :many
-- Which of these uploads still exist: the sweep of the chunk objects deletes
-- the chunks of the others.
SELECT id FROM uploads WHERE id = ANY(sqlc.arg(ids)::uuid[]);

-- name: LockOwnerUploads :exec
-- Serializes the upload quota checks of one owner (key: the owner's id) until
-- the transaction ends.
SELECT pg_advisory_xact_lock(hashtextextended(sqlc.arg(key)::text, 0));

-- name: PendingUploadBytes :one
-- Storage an owner's vaults hold but nobody pays for yet (D-03 charges only
-- committed files): blobs uploaded within the window that no revision
-- references, plus the announced length of the resumable uploads in progress
-- (except_upload: the one being finalized, counted as its blob instead).
-- The condition on unreferenced_since adds nothing to the result: a blob is
-- linked with ref_count = 0 only after RenewUnreferencedBlob, in the same
-- transaction, and unreferenced_since only moves forward while ref_count is
-- 0, so it is never older than the link (the hour absorbs the length of a
-- concurrent transaction that dropped the last reference). It lets the
-- planner start from blobs_gc_ix, the few blobs nobody references, instead of
-- every blob the owner linked within the window: during a first sync that is
-- each blob uploaded so far, read again for every upload (M12-W6.1).
SELECT (
  COALESCE((SELECT sum(b.size) FROM blobs b JOIN vault_blobs vb ON vb.hash = b.hash
            WHERE b.ref_count = 0
              AND b.unreferenced_since > sqlc.arg(since)::timestamptz - interval '1 hour'
              AND vb.vault_id = ANY(sqlc.arg(vault_ids)::uuid[])
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
