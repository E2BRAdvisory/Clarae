-- Queries of the audit module (ADR-0033: one sqlc package per module).

-- name: InsertAudit :exec
INSERT INTO audit_log (actor_id, action, target_type, target_id, details, ip)
VALUES ($1, $2, $3, $4, $5, $6);

-- name: CountAudit :one
-- Size and age of the log (with OldestAudit), written to the log at start so an
-- upgrade that came up on an emptied database is noticed.
SELECT count(*)::bigint FROM audit_log;

-- name: OldestAudit :one
-- No rows when the log is empty.
SELECT at FROM audit_log ORDER BY at LIMIT 1;
