-- Queries of the notify module (ADR-0033: one sqlc package per module).

-- name: GetShare :one
SELECT * FROM shares WHERE id = $1;

-- name: ListShareRecipients :many
-- Users that currently see a share: accepted or pending grants, directly or via groups.
SELECT DISTINCT u FROM (
  SELECT g.principal_id AS u FROM share_grants g WHERE g.share_id = $1 AND g.principal_type = 'user'
  UNION
  SELECT m.user_id FROM share_grants g JOIN group_members m ON m.group_id = g.principal_id
  WHERE g.share_id = $1 AND g.principal_type = 'group'
) r;

-- name: ListVaultRecipients :many
-- Users who may read the vault through an accepted grant on a live share.
SELECT DISTINCT u FROM (
  SELECT g.principal_id AS u FROM share_grants g JOIN shares s ON s.id = g.share_id
  WHERE s.vault_id = $1 AND s.revoked_at IS NULL AND (s.expires_at IS NULL OR s.expires_at > now())
    AND g.status = 'accepted' AND g.principal_type = 'user'
  UNION
  SELECT m.user_id FROM share_grants g JOIN shares s ON s.id = g.share_id
  JOIN group_members m ON m.group_id = g.principal_id
  WHERE s.vault_id = $1 AND s.revoked_at IS NULL AND (s.expires_at IS NULL OR s.expires_at > now())
    AND g.status = 'accepted' AND g.principal_type = 'group'
) r;

-- name: ListSharedVaultSeqs :many
-- Vaults reached by a user through accepted grants, with their last seq (event replay).
SELECT DISTINCT v.id, v.last_seq FROM share_grants g
JOIN shares s ON s.id = g.share_id
JOIN vaults v ON v.id = s.vault_id
WHERE g.status = 'accepted' AND s.revoked_at IS NULL AND (s.expires_at IS NULL OR s.expires_at > now()) AND v.deleted_at IS NULL
  AND ((g.principal_type = 'user' AND g.principal_id = $1)
    OR (g.principal_type = 'group' AND g.principal_id IN (SELECT group_id FROM group_members WHERE user_id = $1)));

-- name: ListVaultsOfOwners :many
SELECT id, owner_id, last_seq FROM vaults WHERE owner_id = $1 AND deleted_at IS NULL;

-- name: GetVaultOwner :one
SELECT owner_id, deleted_at FROM vaults WHERE id = $1;
