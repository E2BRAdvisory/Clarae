-- +goose Up
-- The identity of the changelog cursor (ADR-0046): the id of the change at
-- last_seq, as the server reported it. After a point-in-time restore of the
-- cloud database the same seqs are handed out again to other changes, and
-- only the id tells the server that this cursor belongs to the lost timeline.
-- '' = unknown (a cursor from before this migration, or a position the server
-- reported without an id): the server then does not verify it.
ALTER TABLE sync_cursor ADD COLUMN last_id TEXT NOT NULL DEFAULT '';

-- +goose Down
ALTER TABLE sync_cursor DROP COLUMN last_id;
