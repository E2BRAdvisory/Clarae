-- name: CreateGroup :one
INSERT INTO groups (id, name, description) VALUES ($1, $2, $3) RETURNING *;

-- name: GetGroup :one
SELECT * FROM groups WHERE id = $1;

-- name: ListGroups :many
SELECT * FROM groups ORDER BY lower(name);

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
SELECT u.id, u.username, u.email, u.display_name, m.member_role
FROM group_members m JOIN users u ON u.id = m.user_id
WHERE m.group_id = $1 AND u.status <> 'deleted'
ORDER BY lower(u.username);

-- name: ListGroupsOfUser :many
SELECT g.id, g.name, g.description, m.member_role
FROM group_members m JOIN groups g ON g.id = m.group_id
WHERE m.user_id = $1
ORDER BY lower(g.name);

-- name: SearchDirectoryUsers :many
SELECT id, username, display_name FROM users
WHERE status = 'active'
  AND (sqlc.arg(q)::text = ''
       OR username ILIKE '%' || sqlc.arg(q)::text || '%'
       OR email::text ILIKE '%' || sqlc.arg(q)::text || '%'
       OR display_name ILIKE '%' || sqlc.arg(q)::text || '%')
ORDER BY lower(username)
LIMIT sqlc.arg(max_rows)::int;

-- name: SearchDirectoryGroups :many
SELECT id, name, description FROM groups
WHERE sqlc.arg(q)::text = '' OR name::text ILIKE '%' || sqlc.arg(q)::text || '%'
ORDER BY lower(name)
LIMIT sqlc.arg(max_rows)::int;

-- name: GetUserBrief :one
SELECT id, username, display_name, status FROM users WHERE id = $1;
