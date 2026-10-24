-- name: CreateShare :one
INSERT INTO shares (id, vault_id, resource_type, path_prefix, file_id, display_name, created_by, expires_at)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *;

-- name: GetShare :one
SELECT * FROM shares WHERE id = $1;

-- name: UpdateShare :one
UPDATE shares SET display_name = $2, expires_at = $3 WHERE id = $1 AND revoked_at IS NULL RETURNING *;

-- name: RevokeShare :execrows
UPDATE shares SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL;

-- name: UpsertGrant :one
INSERT INTO share_grants (id, share_id, principal_type, principal_id, permission, status, granted_by)
VALUES ($1, $2, $3, $4, $5, $6, $7)
ON CONFLICT (share_id, principal_type, principal_id)
DO UPDATE SET permission = EXCLUDED.permission, granted_by = EXCLUDED.granted_by
RETURNING *;

-- name: GetGrant :one
SELECT * FROM share_grants WHERE share_id = $1 AND principal_type = $2 AND principal_id = $3;

-- name: DeleteGrant :execrows
DELETE FROM share_grants WHERE share_id = $1 AND principal_type = $2 AND principal_id = $3;

-- name: SetGrantStatus :exec
UPDATE share_grants SET status = $2 WHERE id = $1;

-- name: ListGrants :many
SELECT g.*,
       CASE g.principal_type WHEN 'user' THEN (SELECT username FROM users WHERE id = g.principal_id)
                             ELSE (SELECT name::text FROM groups WHERE id = g.principal_id) END::text AS principal_name
FROM share_grants g WHERE g.share_id = $1 ORDER BY g.created_at;

-- name: ListSharesOfVaultOwner :many
-- Shares of the vaults a user owns, plus those the user manages.
SELECT s.* FROM shares s JOIN vaults v ON v.id = s.vault_id
WHERE s.revoked_at IS NULL AND v.deleted_at IS NULL
  AND (v.owner_id = sqlc.arg(user_id)
       OR EXISTS (SELECT 1 FROM share_grants g
                  WHERE g.share_id = s.id AND g.status = 'accepted' AND g.permission = 'manager'
                    AND ((g.principal_type = 'user' AND g.principal_id = sqlc.arg(user_id))
                      OR (g.principal_type = 'group' AND g.principal_id IN (SELECT group_id FROM group_members WHERE user_id = sqlc.arg(user_id))))))
ORDER BY s.created_at DESC;

-- name: ListGrantsOfUser :many
-- Every grant that reaches a user, directly or through a group, on live shares.
SELECT g.*, s.vault_id, s.resource_type, s.path_prefix, s.file_id, s.display_name, s.created_by, s.expires_at,
       v.owner_id, v.name AS vault_name,
       (SELECT username FROM users WHERE id = v.owner_id) AS owner_name
FROM share_grants g
JOIN shares s ON s.id = g.share_id
JOIN vaults v ON v.id = s.vault_id
WHERE s.revoked_at IS NULL AND (s.expires_at IS NULL OR s.expires_at > now()) AND v.deleted_at IS NULL
  AND ((g.principal_type = 'user' AND g.principal_id = $1)
    OR (g.principal_type = 'group' AND g.principal_id IN (SELECT group_id FROM group_members WHERE user_id = $1)))
ORDER BY s.created_at DESC;

-- name: ListUserGrantsOnShare :many
SELECT g.* FROM share_grants g
WHERE g.share_id = $1
  AND ((g.principal_type = 'user' AND g.principal_id = $2)
    OR (g.principal_type = 'group' AND g.principal_id IN (SELECT group_id FROM group_members WHERE user_id = $2)));

-- name: ListLiveSharesOfVault :many
SELECT * FROM shares
WHERE vault_id = $1 AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > now());

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

-- name: RebasePrefixShares :exec
-- A folder rename (move_prefix) carries the shares rooted at or below it.
UPDATE shares SET path_prefix = sqlc.arg(to_path)::text || substr(path_prefix, char_length(sqlc.arg(from_path)::text) + 1)
WHERE vault_id = sqlc.arg(vault_id) AND resource_type = 'folder'
  AND (lower(path_prefix) = lower(sqlc.arg(from_path)::text) OR lower(path_prefix) LIKE lower(sqlc.arg(like_from)::text));

-- name: GetFileLive :one
SELECT * FROM files WHERE id = $1 AND vault_id = $2;

-- name: DeleteGrantsOfPrincipal :execrows
DELETE FROM share_grants WHERE principal_type = $1 AND principal_id = $2;
