-- name: GetUserBySub :one
SELECT * FROM users WHERE keycloak_sub = $1;

-- name: GetUserByID :one
SELECT * FROM users WHERE id = $1;

-- name: GetUserStatus :one
SELECT status FROM users WHERE id = $1;

-- name: UpsertUserFromToken :one
-- Just-in-time provisioning on login: creates the user on first sight and
-- refreshes profile fields and the realm role mirror afterwards.
INSERT INTO users (id, keycloak_sub, username, email, display_name, role, status, last_login_at)
VALUES ($1, $2, $3, $4, $5, $6, 'active', now())
ON CONFLICT (keycloak_sub) DO UPDATE SET
  username      = EXCLUDED.username,
  email         = EXCLUDED.email,
  display_name  = EXCLUDED.display_name,
  role          = EXCLUDED.role,
  last_login_at = now(),
  updated_at    = now()
RETURNING *;
