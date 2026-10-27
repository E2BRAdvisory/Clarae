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
  -- A deleted account keeps its tombstone: a token must never write personal data back.
  username      = CASE WHEN users.status = 'deleted' THEN users.username      ELSE EXCLUDED.username     END,
  email         = CASE WHEN users.status = 'deleted' THEN users.email         ELSE EXCLUDED.email        END,
  display_name  = CASE WHEN users.status = 'deleted' THEN users.display_name  ELSE EXCLUDED.display_name END,
  role          = CASE WHEN users.status = 'deleted' THEN users.role          ELSE EXCLUDED.role         END,
  last_login_at = CASE WHEN users.status = 'deleted' THEN users.last_login_at ELSE now()                 END,
  updated_at    = CASE WHEN users.status = 'deleted' THEN users.updated_at    ELSE now()                 END
RETURNING *;
