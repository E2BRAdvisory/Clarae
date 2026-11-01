-- +goose Up
-- Revision retention vs. conflict copies and changelog indexes.
--
-- A conflict copy points at the revision of the original it was derived from
-- (conflict_of). Retention prunes that revision once it is no longer current,
-- and the foreign key without an action made the whole retention batch fail
-- (23503) forever. The reference now clears itself, and the file id of the
-- original, which the changelog serves, is stored on the copy at commit time
-- so it no longer depends on the referenced revision surviving.
ALTER TABLE file_revisions ADD COLUMN conflict_of_file UUID;
UPDATE file_revisions r SET conflict_of_file = c.file_id
FROM file_revisions c WHERE c.id = r.conflict_of;

ALTER TABLE file_revisions
  DROP CONSTRAINT file_revisions_conflict_of_fkey,
  ADD CONSTRAINT file_revisions_conflict_of_fkey
    FOREIGN KEY (conflict_of) REFERENCES file_revisions(id) ON DELETE SET NULL;
-- The ON DELETE action looks up the referencing rows of every pruned revision.
CREATE INDEX file_revisions_conflict_of_ix ON file_revisions (conflict_of) WHERE conflict_of IS NOT NULL;

-- Keyset pagination of the retention scan (file, time, id).
CREATE INDEX file_revisions_retention_ix ON file_revisions (file_id, server_time, id);

-- The blob collector checks that no file still references a blob.
CREATE INDEX files_blob_ix ON files (blob_hash) WHERE blob_hash IS NOT NULL;

-- Duplicate of the index behind UNIQUE (vault_id, seq).
DROP INDEX file_revisions_changes_ix;

-- +goose Down
CREATE INDEX file_revisions_changes_ix ON file_revisions (vault_id, seq);
DROP INDEX files_blob_ix;
DROP INDEX file_revisions_retention_ix;
DROP INDEX file_revisions_conflict_of_ix;
ALTER TABLE file_revisions
  DROP CONSTRAINT file_revisions_conflict_of_fkey,
  ADD CONSTRAINT file_revisions_conflict_of_fkey
    FOREIGN KEY (conflict_of) REFERENCES file_revisions(id);
ALTER TABLE file_revisions DROP COLUMN conflict_of_file;
