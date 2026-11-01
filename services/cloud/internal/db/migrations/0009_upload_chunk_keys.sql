-- +goose Up
-- The objects holding the confirmed chunks of a resumable upload, in order. A
-- PATCH streams its chunk into an object of its own and appends the key when
-- it confirms the offset: a stale PATCH racing a newer one at the same offset
-- can no longer overwrite the confirmed chunk (W8, tus-patch-holds-tx).
-- Uploads created before keep an empty array and their chunks numbered 0..chunks-1.
ALTER TABLE uploads ADD COLUMN chunk_keys TEXT[] NOT NULL DEFAULT '{}';

-- +goose Down
ALTER TABLE uploads DROP COLUMN chunk_keys;
