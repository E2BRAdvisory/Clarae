-- Queries of the groups module (ADR-0033: one sqlc package per module).

-- name: CreateGroup :one
INSERT INTO groups (id, name, description) VALUES ($1, $2, $3) RETURNING *;

-- name: GetGroup :one
SELECT * FROM groups WHERE id = $1;

-- name: UpdateGroup :one
UPDATE groups SET name = $2, description = $3 WHERE id = $1 RETURNING *;

-- name: DeleteGroup :execrows
DELETE FROM groups WHERE id = $1;

-- name: UpsertGroupMember :exec
INSERT INTO group_members (group_id, user_id, member_role) VALUES ($1, $2, $3)
ON CONFLICT (group_id, user_id) DO UPDATE SET member_role = EXCLUDED.member_role;

-- name: RemoveGroupMember :execrows
DELETE FROM group_members WHERE group_id = $1 AND user_id = $2;

-- name: ListGroupMembers :many
-- A page of the members of a group by username, after the position (lower
-- username, user id) ending the previous page; sort_key is that position.
SELECT u.id, u.username, u.email, u.display_name, m.member_role, lower(u.username)::text AS sort_key
FROM group_members m JOIN users u ON u.id = m.user_id
WHERE m.group_id = sqlc.arg(group_id) AND u.status <> 'deleted'
  AND (sqlc.narg(after_key)::text IS NULL
       OR (lower(u.username), u.id) > (sqlc.narg(after_key)::text, sqlc.narg(after_id)::uuid))
ORDER BY lower(u.username), u.id
LIMIT sqlc.arg(max_rows)::int;

-- name: ListGroupMemberIDs :many
-- Every member of a group, whatever the state of their account (the users a
-- removal of the group concerns).
SELECT user_id FROM group_members WHERE group_id = $1;

-- name: ListGroupsOfUser :many
SELECT g.id, g.name, g.description, m.member_role
FROM group_members m JOIN groups g ON g.id = m.group_id
WHERE m.user_id = $1
ORDER BY lower(g.name);

-- name: SearchDirectoryGroups :many
SELECT id, name, description FROM groups
WHERE sqlc.arg(q)::text = '' OR name::text ILIKE '%' || sqlc.arg(q)::text || '%'
ORDER BY lower(name)
LIMIT sqlc.arg(max_rows)::int;
