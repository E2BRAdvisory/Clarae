-- +goose Up
-- The author of the revision whose content a row holds (the head revision as far as this device has
-- applied it): the account that made the change the server version of the file comes from. The editor asks
-- for it to decide whether a merge of its unsaved text with a newer version on disk is allowed (D-04: on a
-- shared vault only the same author's drawings, canvases and bases are merged; a note always is).
-- '' = unknown (a row from before this migration, or one adopted without a revision at hand): it is not
-- taken for the user's own.
ALTER TABLE sync_files ADD COLUMN head_author TEXT NOT NULL DEFAULT '';

-- +goose Down
ALTER TABLE sync_files DROP COLUMN head_author;
