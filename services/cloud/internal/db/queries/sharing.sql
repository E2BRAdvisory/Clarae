-- Queries of the sharing module (ADR-0033: one sqlc package per module).

-- name: GetFile :one
SELECT * FROM files WHERE id = $1 AND vault_id = $2;

-- name: PathKeyTaken :one
SELECT id FROM files WHERE vault_id = $1 AND path_key = $2 AND NOT is_deleted LIMIT 1;

-- name: CountFilesUnderPrefix :one
SELECT count(*)::int FROM files
WHERE vault_id = $1 AND NOT is_deleted AND (path_key = sqlc.arg(exact)::text OR path_key LIKE sqlc.arg(descendants)::text ESCAPE '\');

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
-- A grant given again keeps its answer, except a declined one: inviting again
-- asks again (pending).
INSERT INTO share_grants (id, share_id, principal_type, principal_id, permission, status, granted_by)
VALUES ($1, $2, $3, $4, $5, $6, $7)
ON CONFLICT (share_id, principal_type, principal_id)
DO UPDATE SET permission = EXCLUDED.permission, granted_by = EXCLUDED.granted_by,
              status = CASE WHEN share_grants.status = 'declined' THEN 'pending' ELSE share_grants.status END
RETURNING *;

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
-- Shares of the vaults a user owns, plus those the user manages or created as
-- a manager (ADR-0041 §8: the service keeps a created one only while the
-- creator still manages a share around it), with what a list shows of their
-- vault and owner (one query per list, not per share).
SELECT sqlc.embed(s), v.name AS vault_name, v.owner_id, COALESCE(u.username, '')::text AS owner_name
FROM shares s JOIN vaults v ON v.id = s.vault_id LEFT JOIN users u ON u.id = v.owner_id
WHERE s.revoked_at IS NULL AND v.deleted_at IS NULL
  AND (v.owner_id = sqlc.arg(user_id)
       OR s.created_by = sqlc.arg(user_id)
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

-- name: ListFolderSharesOfVault :many
-- Every folder share of a vault, revoked and expired ones included (a folder
-- rename carries them all: RebasePrefixShares matches them in Go by path key).
SELECT id, path_prefix FROM shares
WHERE vault_id = $1 AND resource_type = 'folder' AND path_prefix IS NOT NULL;

-- name: SetSharePrefix :exec
UPDATE shares SET path_prefix = $2 WHERE id = $1;

-- name: DeleteGrantsOfPrincipal :execrows
DELETE FROM share_grants WHERE principal_type = $1 AND principal_id = $2;

-- name: ListSharesByIDs :many
-- The shares of a list with their vault and owner (ListReceived).
SELECT sqlc.embed(s), v.name AS vault_name, v.owner_id, COALESCE(u.username, '')::text AS owner_name
FROM shares s JOIN vaults v ON v.id = s.vault_id LEFT JOIN users u ON u.id = v.owner_id
WHERE s.id = ANY(sqlc.arg(ids)::uuid[]);

-- name: ListUserGrantsOnShares :many
-- ListUserGrantsOnShare for many shares at once.
SELECT g.* FROM share_grants g
WHERE g.share_id = ANY(sqlc.arg(share_ids)::uuid[])
  AND ((g.principal_type = 'user' AND g.principal_id = sqlc.arg(user_id))
    OR (g.principal_type = 'group' AND g.principal_id IN (SELECT group_id FROM group_members WHERE user_id = sqlc.arg(user_id))));

-- name: ListGrantsOfShares :many
-- ListGrants for many shares at once.
SELECT g.*,
       CASE g.principal_type WHEN 'user' THEN (SELECT username FROM users WHERE id = g.principal_id)
                             ELSE (SELECT name::text FROM groups WHERE id = g.principal_id) END::text AS principal_name
FROM share_grants g WHERE g.share_id = ANY(sqlc.arg(share_ids)::uuid[]) ORDER BY g.share_id, g.created_at;

-- name: ListManagedSharesOfVault :many
-- The live shares of a vault on which a user holds an accepted manager grant,
-- directly or through a group (ADR-0041 §8: where a manager may share).
SELECT s.* FROM shares s
WHERE s.vault_id = sqlc.arg(vault_id) AND s.revoked_at IS NULL AND (s.expires_at IS NULL OR s.expires_at > now())
  AND EXISTS (SELECT 1 FROM share_grants g
              WHERE g.share_id = s.id AND g.status = 'accepted' AND g.permission = 'manager'
                AND ((g.principal_type = 'user' AND g.principal_id = sqlc.arg(user_id))
                  OR (g.principal_type = 'group' AND g.principal_id IN (SELECT group_id FROM group_members WHERE user_id = sqlc.arg(user_id)))))
ORDER BY s.created_at;

-- name: ListManagedSharesOfUser :many
-- ListManagedSharesOfVault over every vault (the lists of shares).
SELECT s.* FROM shares s
WHERE s.revoked_at IS NULL AND (s.expires_at IS NULL OR s.expires_at > now())
  AND EXISTS (SELECT 1 FROM share_grants g
              WHERE g.share_id = s.id AND g.status = 'accepted' AND g.permission = 'manager'
                AND ((g.principal_type = 'user' AND g.principal_id = sqlc.arg(user_id))
                  OR (g.principal_type = 'group' AND g.principal_id IN (SELECT group_id FROM group_members WHERE user_id = sqlc.arg(user_id)))))
ORDER BY s.created_at;

-- name: ListLiveSharesOfGroup :many
-- The live shares granted to a group, with the level of that grant (the shares
-- a change of its members or its removal can give or take).
SELECT s.id, s.vault_id, g.permission FROM share_grants g JOIN shares s ON s.id = g.share_id
WHERE g.principal_type = 'group' AND g.principal_id = $1
  AND s.revoked_at IS NULL AND (s.expires_at IS NULL OR s.expires_at > now());

-- name: ListReachOfUsers :many
-- Which of some users each of some shares reaches, directly or through a group
-- (pending or accepted; a declined grant of their own reaches them no more, so
-- leaving a group that kept them on the share takes it away).
SELECT g.share_id, g.principal_id AS user_id FROM share_grants g
WHERE g.share_id = ANY(sqlc.arg(share_ids)::uuid[]) AND g.principal_type = 'user'
  AND g.principal_id = ANY(sqlc.arg(user_ids)::uuid[]) AND g.status <> 'declined'
UNION
SELECT g.share_id, m.user_id FROM share_grants g JOIN group_members m ON m.group_id = g.principal_id
WHERE g.share_id = ANY(sqlc.arg(share_ids)::uuid[]) AND g.principal_type = 'group'
  AND m.user_id = ANY(sqlc.arg(user_ids)::uuid[]);

-- name: ListCreatorGrantsOfVault :many
-- The grants that managers hold, as users, on the shares of a vault they
-- created, except those the owner gave (ADR-0041 §8: they last only while the
-- creator still manages a share around them).
SELECT g.id AS grant_id, sqlc.embed(s) FROM share_grants g
JOIN shares s ON s.id = g.share_id JOIN vaults v ON v.id = s.vault_id
WHERE s.vault_id = $1 AND s.revoked_at IS NULL AND s.created_by <> v.owner_id
  AND g.principal_type = 'user' AND g.principal_id = s.created_by AND g.granted_by <> v.owner_id;

-- name: DeleteGrantByID :exec
DELETE FROM share_grants WHERE id = $1;
