-- name: LockActiveAdmins :many
-- Serialises concurrent deletions of administrators (last-admin guard).
SELECT id FROM users WHERE role = 'admin' AND status = 'active' ORDER BY id FOR UPDATE;

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

-- name: MarkUserPurged :exec
UPDATE users SET purged_at = now(), keycloak_sub = 'purged:' || id::text, updated_at = now() WHERE id = $1;

-- name: ListUsersToPurge :many
SELECT id FROM users
WHERE status = 'deleted' AND purged_at IS NULL AND COALESCE(deleted_at, updated_at) < $1;

-- name: ListAllVaultIDsOfOwner :many
SELECT id FROM vaults WHERE owner_id = $1;

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

-- name: DeleteUploadsOfUser :execrows
DELETE FROM uploads WHERE user_id = $1;

-- name: DeleteMembershipsOfUser :execrows
DELETE FROM group_members WHERE user_id = $1;

-- name: DeleteGrantsGrantedBy :execrows
DELETE FROM share_grants WHERE granted_by = $1;

-- name: ExpireExportsOfUser :execrows
UPDATE export_jobs SET expires_at = now() WHERE requested_by = $1 AND status = 'ready';

-- name: AnonymiseAuditOfUser :execrows
-- Keeps actor_id/target_id (the trail) but drops the network address and the username
-- copied into details.
UPDATE audit_log SET ip = NULL, details = CASE WHEN details IS NULL THEN NULL ELSE details - 'username' END
WHERE actor_id = $1 OR (target_type = 'user' AND target_id = $1::text);

-- name: ListAuditAboutUser :many
SELECT id, at, actor_id, action, target_type, target_id, details
FROM audit_log WHERE actor_id = $1 OR (target_type = 'user' AND target_id = $1::text)
ORDER BY id LIMIT 10000;

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
