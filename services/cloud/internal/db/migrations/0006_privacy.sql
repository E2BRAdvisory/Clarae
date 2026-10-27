-- +goose Up
-- GDPR account deletion (ADR-0021): deletion and purge timestamps on users, and the
-- retention setting that governs when the purge job removes what is left.

ALTER TABLE users
  ADD COLUMN deleted_at TIMESTAMPTZ,
  ADD COLUMN purged_at  TIMESTAMPTZ;
CREATE INDEX users_purge_ix ON users (deleted_at) WHERE status = 'deleted' AND purged_at IS NULL;

INSERT INTO settings (key, value) VALUES
  ('privacy.account_purge_days', '30'::jsonb)
ON CONFLICT (key) DO NOTHING;

-- +goose Down
DELETE FROM settings WHERE key = 'privacy.account_purge_days';
DROP INDEX users_purge_ix;
ALTER TABLE users DROP COLUMN purged_at, DROP COLUMN deleted_at;
