-- +goose Up
-- A manager no longer grants anything to themselves (ADR-0041 §8): a grant of
-- their own making on a share they created outlived the manager grant the
-- owner can take back, and an expiry, which happens without any write, never
-- triggers the cleanup that now follows every other loss of management. The
-- grants a manager gave themselves before the rule go: while they still manage
-- the share around it they reach the same files through that share.
DELETE FROM share_grants g
USING shares s
WHERE s.id = g.share_id
  AND g.principal_type = 'user'
  AND g.principal_id = s.created_by
  AND g.granted_by = s.created_by;

-- +goose Down
-- The grants removed are not restored.
SELECT 1;
