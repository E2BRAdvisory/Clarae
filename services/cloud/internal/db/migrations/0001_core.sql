-- +goose Up
-- Identity and organisation (Specifications.md §3.2.2). Vaults, sharing and
-- configuration profiles arrive with later migrations (M2, M4, M5).

CREATE EXTENSION IF NOT EXISTS citext;

CREATE TABLE users (
  id                    UUID PRIMARY KEY,
  keycloak_sub          TEXT        NOT NULL UNIQUE,
  username              TEXT        NOT NULL,
  email                 CITEXT      NOT NULL,
  display_name          TEXT,
  role                  TEXT        NOT NULL DEFAULT 'user'
                         CHECK (role IN ('admin','user')),
  status                TEXT        NOT NULL DEFAULT 'active'
                         CHECK (status IN ('pending','active','suspended','deleted')),
  quota_bytes_override  BIGINT      CHECK (quota_bytes_override >= -1),
  used_bytes            BIGINT      NOT NULL DEFAULT 0 CHECK (used_bytes >= 0),
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_login_at         TIMESTAMPTZ
);
CREATE UNIQUE INDEX users_email_uq ON users (email) WHERE status <> 'deleted';

CREATE TABLE settings (
  key        TEXT PRIMARY KEY,
  value      JSONB       NOT NULL,
  updated_by UUID REFERENCES users(id),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE devices (
  id           UUID PRIMARY KEY,
  user_id      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name         TEXT NOT NULL,
  platform     TEXT NOT NULL,
  app_version  TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at TIMESTAMPTZ,
  revoked_at   TIMESTAMPTZ
);
CREATE INDEX devices_user_ix ON devices (user_id) WHERE revoked_at IS NULL;

CREATE TABLE audit_log (
  id          BIGSERIAL PRIMARY KEY,
  at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  actor_id    UUID REFERENCES users(id),
  action      TEXT NOT NULL,
  target_type TEXT,
  target_id   TEXT,
  details     JSONB,
  ip          INET
);
CREATE INDEX audit_log_at_ix ON audit_log (at DESC);

-- +goose Down
DROP TABLE audit_log;
DROP TABLE devices;
DROP TABLE settings;
DROP TABLE users;
