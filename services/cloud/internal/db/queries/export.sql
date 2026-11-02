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

-- name: GetReusableExportJobOfVault :one
-- The newest ready archive of a vault built at its current changelog position
-- and still valid for a while: a new request gets it instead of a copy.
SELECT * FROM export_jobs
WHERE vault_id = $1 AND status = 'ready' AND source_seq = sqlc.arg(last_seq)::bigint
  AND expires_at > sqlc.arg(valid_after)::timestamptz
ORDER BY created_at DESC LIMIT 1;

-- name: SupersedeReadyExportJobsOfVault :execrows
-- A new archive of a vault (keep) makes the older ones obsolete: they stay
-- downloadable at most until valid_until, then Expire deletes them.
UPDATE export_jobs SET expires_at = LEAST(expires_at, sqlc.arg(valid_until)::timestamptz)
WHERE vault_id = $1 AND status = 'ready' AND id <> sqlc.arg(keep)::uuid;

-- name: FinishExportJob :execrows
-- Only a job still running: one cancelled meanwhile (account deletion) stays
-- failed, and the caller deletes the archive it uploaded.
UPDATE export_jobs SET status = 'ready', size = $2, object_key = $3, source_seq = $4, finished_at = now(), expires_at = $5
WHERE id = $1 AND status = 'running';

-- name: FailExportJob :execrows
UPDATE export_jobs SET status = 'failed', error = $2, finished_at = now(), expires_at = NULL
WHERE id = $1 AND status = 'running';

-- name: ReleaseExportJob :execrows
-- A build interrupted by the shutdown of its worker goes back to the queue.
UPDATE export_jobs SET status = 'queued', expires_at = NULL WHERE id = $1 AND status = 'running';

-- name: ExpireExportJobs :many
UPDATE export_jobs SET status = 'expired' WHERE status = 'ready' AND expires_at < sqlc.arg(now)::timestamptz RETURNING id, object_key;

-- name: RequeueStaleExportJobs :execrows
-- Running jobs whose lease ran out (their worker died). Rows claimed before
-- leases existed have none: they fall back to their age.
UPDATE export_jobs SET status = 'queued', expires_at = NULL
WHERE status = 'running'
  AND (expires_at < sqlc.arg(now)::timestamptz OR (expires_at IS NULL AND created_at < sqlc.arg(before)::timestamptz));
