-- +goose Up
-- Groups, shares and grants, distributed configuration (Specifications.md §3.2.2,
-- M4-WP1..WP3). Numbered 0004: 0003 already holds the vault tables (M2).

CREATE TABLE groups (
  id          UUID PRIMARY KEY,
  name        CITEXT      NOT NULL UNIQUE,
  description TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE group_members (
  group_id    UUID NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  user_id     UUID NOT NULL REFERENCES users(id)  ON DELETE CASCADE,
  member_role TEXT NOT NULL DEFAULT 'member' CHECK (member_role IN ('member','manager')),
  added_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (group_id, user_id)
);
CREATE INDEX group_members_user_ix ON group_members (user_id);

CREATE TABLE shares (
  id            UUID PRIMARY KEY,
  vault_id      UUID NOT NULL REFERENCES vaults(id) ON DELETE CASCADE,
  resource_type TEXT NOT NULL CHECK (resource_type IN ('vault','folder','file')),
  path_prefix   TEXT,                              -- folder shares: no trailing slash
  file_id       UUID REFERENCES files(id),         -- file shares
  display_name  TEXT NOT NULL,
  created_by    UUID NOT NULL REFERENCES users(id),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at    TIMESTAMPTZ,
  revoked_at    TIMESTAMPTZ,
  CHECK ((resource_type = 'folder' AND path_prefix IS NOT NULL)
      OR (resource_type = 'file'   AND file_id     IS NOT NULL)
      OR (resource_type = 'vault'))
);
CREATE INDEX shares_vault_ix ON shares (vault_id);

-- Private vaults can never be shared (D-02): enforced here as well as by the service.
-- +goose StatementBegin
CREATE FUNCTION shares_vault_kind_chk() RETURNS trigger AS $$
BEGIN
  IF (SELECT kind FROM vaults WHERE id = NEW.vault_id) <> 'shared' THEN
    RAISE EXCEPTION 'VAULT_ENCRYPTED' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
-- +goose StatementEnd
CREATE TRIGGER shares_vault_kind_chk BEFORE INSERT OR UPDATE OF vault_id ON shares
  FOR EACH ROW EXECUTE FUNCTION shares_vault_kind_chk();

CREATE TABLE share_grants (
  id             UUID PRIMARY KEY,
  share_id       UUID NOT NULL REFERENCES shares(id) ON DELETE CASCADE,
  principal_type TEXT NOT NULL CHECK (principal_type IN ('user','group')),
  principal_id   UUID NOT NULL,
  permission     TEXT NOT NULL CHECK (permission IN ('viewer','editor','manager')),
  status         TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','accepted','declined')),
  granted_by     UUID NOT NULL REFERENCES users(id),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (share_id, principal_type, principal_id)
);
CREATE INDEX share_grants_principal_ix ON share_grants (principal_type, principal_id);

CREATE TABLE config_profiles (
  id          UUID PRIMARY KEY,
  name        CITEXT NOT NULL UNIQUE,
  description TEXT,
  is_global   BOOLEAN NOT NULL DEFAULT FALSE,      -- at most one
  version     INT NOT NULL DEFAULT 1,
  config      JSONB NOT NULL,
  locked_keys TEXT[] NOT NULL DEFAULT '{}',
  updated_by  UUID REFERENCES users(id),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX config_one_global ON config_profiles (is_global) WHERE is_global;

CREATE TABLE config_assignments (
  profile_id UUID NOT NULL REFERENCES config_profiles(id) ON DELETE CASCADE,
  group_id   UUID NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  priority   INT  NOT NULL DEFAULT 100,
  PRIMARY KEY (profile_id, group_id)
);
CREATE INDEX config_assignments_group_ix ON config_assignments (group_id);

-- Monotonic revision of the distributed configuration: bumped by any change of a
-- profile, an assignment or a group membership, it is the version clients see.
INSERT INTO settings (key, value) VALUES ('config.revision', '0') ON CONFLICT (key) DO NOTHING;

-- +goose Down
DROP TABLE config_assignments;
DROP TABLE config_profiles;
DROP TABLE share_grants;
DROP TRIGGER shares_vault_kind_chk ON shares;
DROP FUNCTION shares_vault_kind_chk();
DROP TABLE shares;
DROP TABLE group_members;
DROP TABLE groups;
