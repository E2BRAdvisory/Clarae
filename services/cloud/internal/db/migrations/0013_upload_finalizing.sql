-- +goose Up
-- The finalization of a resumable upload is claimed before it starts: a HEAD
-- and a PATCH (or two HEADs) at the final offset no longer assemble the same
-- chunks twice, and the second one waits for the first instead of telling the
-- client to start again. The claim is a lease, so a finalizer that died does
-- not block the upload beyond it (M12-W1).
ALTER TABLE uploads ADD COLUMN finalizing_until TIMESTAMPTZ;

-- +goose Down
ALTER TABLE uploads DROP COLUMN finalizing_until;
