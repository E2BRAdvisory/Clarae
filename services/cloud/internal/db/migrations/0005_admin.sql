-- +goose Up
-- Admin console and export (Specifications.md §3.5.5, M5): history of configuration
-- profiles, export jobs, daily storage snapshots for the dashboard trend and audit indexes.

CREATE TABLE config_profile_versions (
  profile_id  UUID NOT NULL REFERENCES config_profiles(id) ON DELETE CASCADE,
  version     INT  NOT NULL,
  name        TEXT NOT NULL,
  description TEXT,
  is_global   BOOLEAN NOT NULL,
  config      JSONB NOT NULL,
  locked_keys TEXT[] NOT NULL DEFAULT '{}',
  updated_by  UUID REFERENCES users(id),
  updated_at  TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (profile_id, version)
);

-- Profiles created before the history existed start it at their current version.
INSERT INTO config_profile_versions (profile_id, version, name, description, is_global, config, locked_keys, updated_by, updated_at)
SELECT id, version, name, description, is_global, config, locked_keys, updated_by, updated_at FROM config_profiles;

CREATE TABLE export_jobs (
  id           UUID PRIMARY KEY,
  vault_id     UUID NOT NULL REFERENCES vaults(id) ON DELETE CASCADE,
  requested_by UUID NOT NULL REFERENCES users(id),
  status       TEXT NOT NULL DEFAULT 'queued'
                CHECK (status IN ('queued','running','ready','failed','expired')),
  size         BIGINT,
  object_key   TEXT,
  error        TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at  TIMESTAMPTZ,
  expires_at   TIMESTAMPTZ
);
CREATE INDEX export_jobs_vault_ix ON export_jobs (vault_id, created_at DESC);
CREATE INDEX export_jobs_pending_ix ON export_jobs (created_at) WHERE status IN ('queued','running');

CREATE TABLE storage_snapshots (
  day         DATE PRIMARY KEY,
  total_bytes BIGINT NOT NULL CHECK (total_bytes >= 0)
);

CREATE INDEX audit_log_actor_ix  ON audit_log (actor_id, at DESC);
CREATE INDEX audit_log_action_ix ON audit_log (action, at DESC);

-- +goose Down
DROP INDEX audit_log_action_ix;
DROP INDEX audit_log_actor_ix;
DROP TABLE storage_snapshots;
DROP TABLE export_jobs;
DROP TABLE config_profile_versions;
