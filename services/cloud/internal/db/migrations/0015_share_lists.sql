-- +goose Up
-- Paginated share lists (M12): the shares a user created are one of the three
-- ways into GET /shares?scope=owned (ListSharesOfVaultOwner), looked up by
-- creator instead of scanning every share. Only live shares are listed.
CREATE INDEX shares_created_by_ix ON shares (created_by) WHERE revoked_at IS NULL;

-- +goose Down
DROP INDEX shares_created_by_ix;
