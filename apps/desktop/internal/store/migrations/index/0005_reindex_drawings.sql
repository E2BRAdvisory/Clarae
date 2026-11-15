-- +goose Up
-- The text extracted from a drawing changed (what the user typed instead of the wrapped lines,
-- plus the TeX of formulas). A drawing whose file did not change is skipped by the full pass, so
-- its row is made to look stale (mtime and hash that match nothing) and the next pass parses it
-- again. The pass that follows the open restores both; nothing reads them in between.
UPDATE files SET mtime_ns = 0, hash = '' WHERE kind = 'excalidraw';

-- +goose Down
-- Nothing to undo: the rows are rebuilt from the files.
SELECT 1;
