-- +goose Up
-- The database role becomes authoritative after an administrator changes it
-- (ADR-0041): just-in-time provisioning keeps mirroring the realm role from
-- the token, but only from tokens issued after the last change, so an access
-- token minted before a demotion cannot restore the old role.
ALTER TABLE users ADD COLUMN role_changed_at TIMESTAMPTZ;

-- +goose Down
ALTER TABLE users DROP COLUMN role_changed_at;
