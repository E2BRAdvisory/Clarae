-- Queries of the export module (ADR-0033: one sqlc package per module).

-- name: CreateExportJob :one
INSERT INTO export_jobs (id, vault_id, requested_by) VALUES ($1, $2, $3) RETURNING *;

-- name: GetExportJob :one
SELECT * FROM export_jobs WHERE id = $1 AND vault_id = $2;

-- name: ClaimExportJob :one
UPDATE export_jobs SET status = 'running'
WHERE id = (SELECT j.id FROM export_jobs j WHERE j.status = 'queued' ORDER BY j.created_at LIMIT 1 FOR UPDATE SKIP LOCKED)
RETURNING *;

-- name: FinishExportJob :exec
UPDATE export_jobs SET status = 'ready', size = $2, object_key = $3, finished_at = now(), expires_at = $4 WHERE id = $1;

-- name: FailExportJob :exec
UPDATE export_jobs SET status = 'failed', error = $2, finished_at = now() WHERE id = $1;

-- name: ExpireExportJobs :many
UPDATE export_jobs SET status = 'expired' WHERE status = 'ready' AND expires_at < sqlc.arg(now)::timestamptz RETURNING id, object_key;

-- name: RequeueStaleExportJobs :execrows
UPDATE export_jobs SET status = 'queued' WHERE status = 'running' AND created_at < sqlc.arg(before)::timestamptz;
