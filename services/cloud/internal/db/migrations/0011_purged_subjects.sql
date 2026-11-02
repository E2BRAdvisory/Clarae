-- +goose Up
-- Fingerprints (SHA-256 of the Keycloak subject) of the purged accounts. The
-- purge replaces users.keycloak_sub, so without them a login with an identity
-- provider account that was never disabled would provision a new, active
-- account for the same person; provisioning refuses these subjects instead
-- (§2.6.5: USER_SUSPENDED). Only the hash is kept: the purge erases the
-- personal data, and the subject is needed only to recognise it again.
-- Owned by the users module.
CREATE TABLE purged_subjects (
  sub_hash  BYTEA PRIMARY KEY,
  purged_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- +goose Down
DROP TABLE purged_subjects;
