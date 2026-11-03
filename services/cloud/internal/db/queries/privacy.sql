-- Queries of the privacy module (ADR-0033: one sqlc package per module).

-- name: TombstoneUser :one
-- Replaces every personal field by a tombstone; ids, role and timestamps stay so audit
-- rows and revisions keep pointing at a valid row. Idempotent.
UPDATE users SET
  status       = 'deleted',
  deleted_at   = COALESCE(deleted_at, now()),
  username     = 'deleted-' || substr(id::text, 1, 8),
  email        = 'deleted-' || id::text || '@deleted.invalid',
  display_name = NULL,
  updated_at   = now()
WHERE id = $1
RETURNING *;

-- name: CountLivePrivateVaultsOfOwner :one
SELECT COUNT(*)::int FROM vaults WHERE owner_id = $1 AND kind = 'private' AND deleted_at IS NULL;

-- name: ListAllDevicesOfUser :many
SELECT * FROM devices WHERE user_id = $1 ORDER BY created_at;

-- name: DeleteDevicesOfUser :execrows
DELETE FROM devices d WHERE d.user_id = $1
  AND NOT EXISTS (SELECT 1 FROM file_revisions r WHERE r.device_id = d.id);

-- name: RevokeDevicesOfUser :exec
-- Devices still referenced by revisions cannot be deleted; they are revoked and de-identified.
UPDATE devices SET revoked_at = COALESCE(revoked_at, now()), name = 'deleted device', app_version = NULL WHERE user_id = $1;

-- name: ExpireUploadsOfUser :execrows
-- The uploads of a deleted account end at once; the uploads job deletes their
-- chunk objects together with the rows (deleting only the rows here would
-- leave the chunks in the object store for ever).
UPDATE uploads SET expires_at = now() - interval '1 second'
WHERE user_id = $1 AND expires_at >= now();

-- name: DeleteMembershipsOfUser :execrows
DELETE FROM group_members WHERE user_id = $1;

-- name: ReattributeForeignGrants :many
-- Grants the account gave as a manager on vaults of other owners stay valid:
-- the vault owner becomes their grantor (ADR-0041). Returns the shares touched.
UPDATE share_grants g SET granted_by = v.owner_id
FROM shares s JOIN vaults v ON v.id = s.vault_id
WHERE g.share_id = s.id AND g.granted_by = $1 AND v.owner_id <> $1
RETURNING g.share_id, v.owner_id;

-- name: DeleteGrantsGrantedBy :execrows
-- Runs after ReattributeForeignGrants: what is left sits on the account's own
-- vaults, which the deletion puts in retention.
DELETE FROM share_grants WHERE granted_by = $1;

-- name: ExpireExportsOfUser :execrows
-- Ready archives expire at once (the export job deletes them); queued and
-- running jobs fail, so no archive is built after the deletion (a running
-- build finds its job no longer running and deletes what it uploaded).
UPDATE export_jobs SET
  status      = CASE WHEN status = 'ready' THEN 'ready' ELSE 'failed' END,
  error       = CASE WHEN status = 'ready' THEN error ELSE 'the account was deleted' END,
  finished_at = COALESCE(finished_at, now()),
  expires_at  = CASE WHEN status = 'ready' THEN now() ELSE NULL END
WHERE requested_by = $1 AND status IN ('queued', 'running', 'ready');

-- name: AnonymiseAuditOfUser :execrows
-- Keeps actor_id/target_id (the trail) but drops the network address and the username
-- copied into details.
UPDATE audit_log SET ip = NULL, details = CASE WHEN details IS NULL THEN NULL ELSE details - 'username' END
WHERE actor_id = $1 OR (target_type = 'user' AND target_id = $1::text);

-- name: ListAuditAboutUser :many
-- One page of the entries about a user, after the id after_id (keyset
-- pagination): the export reads them all, page by page.
SELECT id, at, actor_id, action, target_type, target_id, details
FROM audit_log
WHERE (actor_id = sqlc.arg(user_id)::uuid OR (target_type = 'user' AND target_id = sqlc.arg(user_id)::uuid::text))
  AND id > sqlc.arg(after_id)::bigint
ORDER BY id LIMIT sqlc.arg(page_size)::int;

-- name: ListVaultsOfOwnerExport :many
SELECT id, name, kind, total_bytes, file_count, created_at, deleted_at
FROM vaults WHERE owner_id = $1 ORDER BY created_at;

-- name: ListSharesOfUserExport :many
-- Shares the user created or that sit on a vault the user owns.
SELECT s.id, s.vault_id, v.name AS vault_name, s.resource_type, s.path_prefix, s.display_name,
       s.created_by, s.created_at, s.expires_at, s.revoked_at
FROM shares s JOIN vaults v ON v.id = s.vault_id
WHERE s.created_by = $1 OR v.owner_id = $1
ORDER BY s.created_at;

-- name: ListEnvelopeKindsOfOwner :many
SELECT e.vault_id, e.kind, e.created_at FROM vault_key_envelopes e JOIN vaults v ON v.id = e.vault_id
WHERE v.owner_id = $1 ORDER BY e.created_at;
