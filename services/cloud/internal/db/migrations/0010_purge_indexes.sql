-- +goose Up
-- Indexes for the foreign key checks and the maintenance scans that had none
-- (M12-W1, missing-indexes). Created inside the migration's transaction like
-- those of 0007: they block writes to the tables for the duration, which is
-- fine at the current sizes (ADR-0038, Conseguenze).

-- Deleting a file (tombstone purge, vault purge) checks that no file share
-- still points at it.
CREATE INDEX shares_file_ix ON shares (file_id) WHERE file_id IS NOT NULL;

-- Deleting the devices of an account (privacy) checks that no revision still
-- names them, and the device foreign key is checked on every device delete.
CREATE INDEX file_revisions_device_ix ON file_revisions (device_id) WHERE device_id IS NOT NULL;

-- The audit console filters by target, newest first; the account deletion
-- looks up the entries about a user (target_type = 'user' AND target_id).
CREATE INDEX audit_log_target_ix ON audit_log (target_id, id DESC) WHERE target_id IS NOT NULL;

-- The tombstone purge walks the deleted files vault by vault in keyset pages;
-- every other index on files covers only the live ones.
CREATE INDEX files_tombstone_ix ON files (vault_id, id) WHERE is_deleted;

-- The pending-upload quota check sums the blobs a vault linked within a
-- window (PendingUploadBytes), and the vault purge removes its uploads.
CREATE INDEX vault_blobs_created_ix ON vault_blobs (vault_id, created_at);
CREATE INDEX uploads_vault_ix ON uploads (vault_id);

-- +goose Down
DROP INDEX uploads_vault_ix;
DROP INDEX vault_blobs_created_ix;
DROP INDEX files_tombstone_ix;
DROP INDEX audit_log_target_ix;
DROP INDEX file_revisions_device_ix;
DROP INDEX shares_file_ix;
