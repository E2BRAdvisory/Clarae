-- Queries of the export module (ADR-0033: one sqlc package per module).

-- name: CreateExportJob :one
INSERT INTO export_jobs (id, vault_id, requested_by) VALUES ($1, $2, $3) RETURNING *;

-- name: GetExportJob :one
SELECT * FROM export_jobs WHERE id = $1 AND vault_id = $2;

-- name: ClaimExportJob :one
-- While a job runs, expires_at is the worker's lease (renewed by RenewExportLease):
-- past it the job counts as abandoned and is queued again.
UPDATE export_jobs SET status = 'running', expires_at = sqlc.arg(lease_until)::timestamptz
WHERE id = (SELECT j.id FROM export_jobs j WHERE j.status = 'queued' ORDER BY j.created_at LIMIT 1 FOR UPDATE SKIP LOCKED)
RETURNING *;

-- name: RenewExportLease :exec
UPDATE export_jobs SET expires_at = sqlc.arg(lease_until)::timestamptz WHERE id = $1 AND status = 'running';

-- name: LockExportRequests :exec
-- Serializes the export requests of one user (key: the user's id) until the transaction ends.
SELECT pg_advisory_xact_lock(hashtextextended(sqlc.arg(key)::text, 0));

-- name: GetActiveExportJobOfVault :one
-- The queued or running job of a vault, if any: a new request joins it.
SELECT * FROM export_jobs WHERE vault_id = $1 AND status IN ('queued', 'running')
ORDER BY created_at LIMIT 1;

-- name: CountActiveExportJobsOfUser :one
SELECT count(*)::int FROM export_jobs WHERE requested_by = $1 AND status IN ('queued', 'running');

-- name: FinishExportJob :exec
UPDATE export_jobs SET status = 'ready', size = $2, object_key = $3, finished_at = now(), expires_at = $4 WHERE id = $1;

-- name: FailExportJob :exec
UPDATE export_jobs SET status = 'failed', error = $2, finished_at = now(), expires_at = NULL WHERE id = $1;

-- name: ExpireExportJobs :many
UPDATE export_jobs SET status = 'expired' WHERE status = 'ready' AND expires_at < sqlc.arg(now)::timestamptz RETURNING id, object_key;

-- name: RequeueStaleExportJobs :execrows
-- Running jobs whose lease ran out (their worker died). Rows claimed before
-- leases existed have none: they fall back to their age.
UPDATE export_jobs SET status = 'queued', expires_at = NULL
WHERE status = 'running'
  AND (expires_at < sqlc.arg(now)::timestamptz OR (expires_at IS NULL AND created_at < sqlc.arg(before)::timestamptz));
