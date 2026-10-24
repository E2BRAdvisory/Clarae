-- +goose Up
-- Vaults, key envelopes, content-addressed blobs, files, revisions and upload
-- sessions (Specifications.md §3.2.2, M2-WP1/WP2).

CREATE TABLE vaults (
  id             UUID PRIMARY KEY,
  owner_id       UUID NOT NULL REFERENCES users(id),
  name           TEXT NOT NULL,
  kind           TEXT NOT NULL CHECK (kind IN ('private','shared')),
  last_seq       BIGINT NOT NULL DEFAULT 0,       -- monotonic changelog counter
  compaction_seq BIGINT NOT NULL DEFAULT 0,       -- changelog entries up to here are no longer served
  total_bytes    BIGINT NOT NULL DEFAULT 0 CHECK (total_bytes >= 0),
  file_count     INT    NOT NULL DEFAULT 0 CHECK (file_count >= 0),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at     TIMESTAMPTZ
);
-- Soft-deleted vaults release their name; restoring may therefore conflict.
CREATE UNIQUE INDEX vaults_owner_name_uq ON vaults (owner_id, name) WHERE deleted_at IS NULL;
CREATE INDEX vaults_owner_ix ON vaults (owner_id);

-- +goose StatementBegin
CREATE FUNCTION vault_kind_immutable() RETURNS trigger AS $$
BEGIN
  IF NEW.kind <> OLD.kind THEN
    RAISE EXCEPTION 'VAULT_KIND_IMMUTABLE' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
-- +goose StatementEnd
CREATE TRIGGER vault_kind_immutable BEFORE UPDATE ON vaults
  FOR EACH ROW EXECUTE FUNCTION vault_kind_immutable();

-- Wrapped VMKs of private vaults. The server never sees the VMK in clear.
CREATE TABLE vault_key_envelopes (
  id          UUID PRIMARY KEY,
  vault_id    UUID NOT NULL REFERENCES vaults(id) ON DELETE CASCADE,
  kind        TEXT NOT NULL CHECK (kind IN ('passphrase','recovery')),
  kdf         JSONB NOT NULL,
  wrapped_vmk BYTEA NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (vault_id, kind)
);

CREATE TABLE blobs (
  hash        CHAR(64) PRIMARY KEY,
  size        BIGINT   NOT NULL CHECK (size >= 0),
  storage_key TEXT     NOT NULL,
  ref_count   INT      NOT NULL DEFAULT 0 CHECK (ref_count >= 0),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  unreferenced_since TIMESTAMPTZ DEFAULT now()    -- set while ref_count = 0, drives the GC grace period
);
CREATE INDEX blobs_gc_ix ON blobs (unreferenced_since) WHERE ref_count = 0;

-- A blob is identified globally by hash (deduplication) but a vault may only
-- read or reference blobs it uploaded itself: this table is that capability,
-- and keeps "blobs:check" from revealing what other users store.
CREATE TABLE vault_blobs (
  vault_id   UUID NOT NULL REFERENCES vaults(id) ON DELETE CASCADE,
  hash       CHAR(64) NOT NULL REFERENCES blobs(hash) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (vault_id, hash)
);
CREATE INDEX vault_blobs_hash_ix ON vault_blobs (hash);

CREATE TABLE files (
  id          UUID PRIMARY KEY,
  vault_id    UUID NOT NULL REFERENCES vaults(id) ON DELETE CASCADE,
  path        TEXT NOT NULL,
  path_key    TEXT NOT NULL,
  kind        TEXT NOT NULL DEFAULT 'other',
  current_rev INT  NOT NULL,
  current_seq BIGINT NOT NULL,
  blob_hash   CHAR(64) REFERENCES blobs(hash),
  size        BIGINT NOT NULL DEFAULT 0,
  is_deleted  BOOLEAN NOT NULL DEFAULT FALSE,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX files_path_uq ON files (vault_id, path_key) WHERE NOT is_deleted;
CREATE INDEX files_vault_prefix_ix ON files (vault_id, path_key text_pattern_ops);
CREATE INDEX files_vault_ix ON files (vault_id) WHERE NOT is_deleted;

CREATE TABLE file_revisions (                      -- append-only (retention aside)
  id           UUID PRIMARY KEY,
  file_id      UUID   NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  vault_id     UUID   NOT NULL REFERENCES vaults(id) ON DELETE CASCADE,
  seq          BIGINT NOT NULL,
  rev_no       INT    NOT NULL,
  op           TEXT   NOT NULL CHECK (op IN ('create','modify','move','delete','restore')),
  path         TEXT   NOT NULL,
  prev_path    TEXT,
  blob_hash    CHAR(64) REFERENCES blobs(hash),
  size         BIGINT NOT NULL DEFAULT 0,
  base_rev     INT,
  author_id    UUID NOT NULL REFERENCES users(id),
  device_id    UUID REFERENCES devices(id),
  op_id        UUID,                                -- client operation id: makes retries idempotent (ADR-0009)
  client_mtime TIMESTAMPTZ,
  server_time  TIMESTAMPTZ NOT NULL DEFAULT now(),
  conflict_of  UUID REFERENCES file_revisions(id),
  UNIQUE (vault_id, seq),
  UNIQUE (file_id, rev_no)
);
CREATE INDEX file_revisions_changes_ix ON file_revisions (vault_id, seq);
CREATE UNIQUE INDEX file_revisions_op_uq ON file_revisions (vault_id, op_id) WHERE op_id IS NOT NULL;
CREATE INDEX file_revisions_blob_ix ON file_revisions (blob_hash) WHERE blob_hash IS NOT NULL;
CREATE INDEX file_revisions_time_ix ON file_revisions (server_time);

-- tus 1.0 resumable uploads: the chunks live in object storage until the
-- upload is complete and its hash verified.
CREATE TABLE uploads (
  id          UUID PRIMARY KEY,
  vault_id    UUID NOT NULL REFERENCES vaults(id) ON DELETE CASCADE,
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expected_hash CHAR(64) NOT NULL,
  length      BIGINT NOT NULL CHECK (length > 0),
  received    BIGINT NOT NULL DEFAULT 0,
  chunks      INT    NOT NULL DEFAULT 0,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at  TIMESTAMPTZ NOT NULL
);
CREATE INDEX uploads_expiry_ix ON uploads (expires_at);

INSERT INTO settings (key, value) VALUES
  ('sync.changelog_window_days', '90'::jsonb),
  ('blobs.gc_grace_hours',       '24'::jsonb),
  ('uploads.expiry_hours',       '24'::jsonb)
ON CONFLICT (key) DO NOTHING;

-- +goose Down
DELETE FROM settings WHERE key IN ('sync.changelog_window_days', 'blobs.gc_grace_hours', 'uploads.expiry_hours');
DROP TABLE uploads;
DROP TABLE file_revisions;
DROP TABLE files;
DROP TABLE vault_blobs;
DROP TABLE blobs;
DROP TABLE vault_key_envelopes;
DROP TRIGGER vault_kind_immutable ON vaults;
DROP FUNCTION vault_kind_immutable();
DROP TABLE vaults;
