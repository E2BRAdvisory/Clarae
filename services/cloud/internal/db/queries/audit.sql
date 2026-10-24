-- name: InsertAudit :exec
INSERT INTO audit_log (actor_id, action, target_type, target_id, details, ip)
VALUES ($1, $2, $3, $4, $5, $6);
