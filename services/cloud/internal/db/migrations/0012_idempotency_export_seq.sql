-- +goose Up
-- The Idempotency-Key of the POST that created a vault or registered a
-- device: a retry carrying the same key gets the resource of the first
-- attempt back instead of a NAME_IN_USE error or a second, orphaned device
-- (M12, idempotency-key-ignored). The key lives as long as the resource it
-- created, so no expiry is needed: clients send a fresh random key per
-- logical operation.
ALTER TABLE vaults ADD COLUMN idempotency_key TEXT;
CREATE UNIQUE INDEX vaults_idempotency_key_uq ON vaults (owner_id, idempotency_key) WHERE idempotency_key IS NOT NULL;
ALTER TABLE devices ADD COLUMN idempotency_key TEXT;
CREATE UNIQUE INDEX devices_idempotency_key_uq ON devices (user_id, idempotency_key) WHERE idempotency_key IS NOT NULL;

-- The changelog position (vaults.last_seq) an export archive was built at: a
-- new request on a vault that has not changed since gets the ready archive
-- back instead of a second copy in the exports bucket. Older rows have none
-- and are never reused.
ALTER TABLE export_jobs ADD COLUMN source_seq BIGINT;

-- +goose Down
ALTER TABLE export_jobs DROP COLUMN source_seq;
DROP INDEX devices_idempotency_key_uq;
ALTER TABLE devices DROP COLUMN idempotency_key;
DROP INDEX vaults_idempotency_key_uq;
ALTER TABLE vaults DROP COLUMN idempotency_key;
