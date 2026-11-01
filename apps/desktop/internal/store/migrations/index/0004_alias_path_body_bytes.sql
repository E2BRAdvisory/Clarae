-- +goose Up
-- aliases is read and cleared by path for every file the indexer writes or
-- removes (and by the ON DELETE CASCADE from files): without an index each of
-- those was a scan of the whole table.
CREATE INDEX aliases_path_ix ON aliases(path);
-- Length in bytes of the searchable text stored in fts_content (the body of a
-- note, the extracted text of a drawing or canvas). The search cache sizes
-- itself on it: a drawing's file size counts its embedded images, which are
-- never cached. NULL until the file is indexed again (the file size stands in).
ALTER TABLE files ADD COLUMN body_bytes INTEGER;

-- +goose Down
ALTER TABLE files DROP COLUMN body_bytes;
DROP INDEX aliases_path_ix;
