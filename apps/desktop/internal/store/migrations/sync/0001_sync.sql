-- +goose Up
-- Synchronization state of one vault (Specifications.md §3.4.3). The file is
-- local to the device and never synchronized: it can be rebuilt by linking the
-- vault again, at the price of a bootstrap from the server manifest.

-- Key/value metadata: cloud_vault_id, kind (private|shared), server_url,
-- device_id, linked_at, user_id, paused.
CREATE TABLE sync_meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE sync_files (
  path        TEXT PRIMARY KEY,                 -- vault-relative, clear text, NFC
  file_id     TEXT NOT NULL UNIQUE,             -- UUID v7, identity across renames
  server_rev  INTEGER NOT NULL DEFAULT 0,       -- current revision of the file on the server as far as we know (base_rev of our next op); 0 = never uploaded
  base_rev    INTEGER NOT NULL DEFAULT 0,       -- revision whose CONTENT our local copy derives from (merge ancestor); differs from server_rev after a remote move
  server_hash TEXT NOT NULL DEFAULT '',         -- blob hash on the server (ciphertext hash in private vaults)
  local_hash  TEXT NOT NULL DEFAULT '',         -- SHA-256 of the plaintext as last seen on disk
  local_size  INTEGER NOT NULL DEFAULT 0,
  local_mtime INTEGER NOT NULL DEFAULT 0,       -- unix nanoseconds
  state       TEXT NOT NULL CHECK (state IN ('synced','local_modified','local_new','local_deleted','local_moved','conflict')),
  moved_from  TEXT NOT NULL DEFAULT '',         -- server-side path before a local move
  dirty       INTEGER NOT NULL DEFAULT 0,       -- moved AND content changed
  tombstoned  INTEGER NOT NULL DEFAULT 0,       -- the server has this file deleted (revive on push)
  conflict_of TEXT NOT NULL DEFAULT '',         -- file_id this file is a conflict copy of
  attempts    INTEGER NOT NULL DEFAULT 0,       -- consecutive failed reconciliations (limit 5)
  last_error  TEXT NOT NULL DEFAULT ''
);
CREATE INDEX sync_files_state_ix ON sync_files (state);
CREATE INDEX sync_files_hash_ix ON sync_files (local_hash);

CREATE TABLE sync_cursor (
  id       INTEGER PRIMARY KEY CHECK (id = 1),
  last_seq INTEGER NOT NULL DEFAULT 0
);
INSERT INTO sync_cursor (id, last_seq) VALUES (1, 0);

-- Operations prepared for the server. Keeping the operation id (and, in
-- private vaults, the ciphertext) makes a retry after a crash or a lost
-- response idempotent instead of creating a second revision.
CREATE TABLE outbox (
  path       TEXT PRIMARY KEY,
  op_id      TEXT NOT NULL,
  kind       TEXT NOT NULL,
  local_hash TEXT NOT NULL DEFAULT '',
  blob_hash  TEXT NOT NULL DEFAULT '',
  upload_url TEXT NOT NULL DEFAULT '',          -- tus resumption
  created_at INTEGER NOT NULL,
  attempts   INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE conflicts (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  file_id     TEXT NOT NULL,
  path        TEXT NOT NULL,
  copy_path   TEXT NOT NULL DEFAULT '',         -- where our version was saved
  strategy    TEXT NOT NULL,
  local_hash  TEXT NOT NULL DEFAULT '',
  remote_rev  INTEGER NOT NULL DEFAULT 0,
  detail      TEXT NOT NULL DEFAULT '',         -- JSON: hunks
  created_at  INTEGER NOT NULL,
  status      TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','resolved','dismissed'))
);
CREATE INDEX conflicts_status_ix ON conflicts (status);

-- +goose Down
DROP TABLE conflicts;
DROP TABLE outbox;
DROP TABLE sync_cursor;
DROP TABLE sync_files;
DROP TABLE sync_meta;
