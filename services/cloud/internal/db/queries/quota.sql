-- Queries of the quota module (ADR-0033: one sqlc package per module).

-- name: UserUsedBytes :one
SELECT used_bytes FROM users WHERE id = $1;

-- name: ChargeUser :execrows
-- Atomic quota check and charge: a negative quota means unlimited.
UPDATE users SET used_bytes = used_bytes + sqlc.arg(delta)::bigint, updated_at = now()
WHERE id = $1 AND (sqlc.arg(delta)::bigint <= 0 OR sqlc.arg(quota)::bigint < 0 OR used_bytes + sqlc.arg(delta)::bigint <= sqlc.arg(quota)::bigint);
