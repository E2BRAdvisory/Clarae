-- Queries of the configprofiles module (ADR-0033: one sqlc package per module).

-- name: InsertProfileVersion :exec
INSERT INTO config_profile_versions (profile_id, version, name, description, is_global, config, locked_keys, updated_by, updated_at)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
ON CONFLICT (profile_id, version) DO NOTHING;

-- name: ListProfileVersions :many
SELECT * FROM config_profile_versions WHERE profile_id = $1 ORDER BY version DESC;

-- name: GetProfileVersion :one
SELECT * FROM config_profile_versions WHERE profile_id = $1 AND version = $2;

-- name: ListConfigProfiles :many
SELECT * FROM config_profiles ORDER BY is_global DESC, lower(name);

-- name: GetConfigProfile :one
SELECT * FROM config_profiles WHERE id = $1;

-- name: CreateConfigProfile :one
INSERT INTO config_profiles (id, name, description, is_global, config, locked_keys, updated_by)
VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *;

-- name: UpdateConfigProfile :one
UPDATE config_profiles
SET name = $2, description = $3, is_global = $4, config = $5, locked_keys = $6,
    updated_by = $7, version = version + 1, updated_at = now()
WHERE id = $1 RETURNING *;

-- name: DeleteConfigProfile :execrows
DELETE FROM config_profiles WHERE id = $1;

-- name: GetGlobalConfigProfile :one
SELECT * FROM config_profiles WHERE is_global;

-- name: ListUserConfigProfiles :many
-- Profiles assigned to the groups of a user, lowest priority first (the last one wins).
SELECT p.*, a.priority FROM config_profiles p
JOIN config_assignments a ON a.profile_id = p.id
WHERE a.group_id IN (SELECT group_id FROM group_members WHERE user_id = $1)
ORDER BY a.priority ASC, lower(p.name);

-- name: ClearGroupAssignments :exec
DELETE FROM config_assignments WHERE group_id = $1;

-- name: AssignProfile :exec
INSERT INTO config_assignments (profile_id, group_id, priority) VALUES ($1, $2, $3)
ON CONFLICT (profile_id, group_id) DO UPDATE SET priority = EXCLUDED.priority;

-- name: ListGroupAssignments :many
SELECT * FROM config_assignments WHERE group_id = $1 ORDER BY priority;
