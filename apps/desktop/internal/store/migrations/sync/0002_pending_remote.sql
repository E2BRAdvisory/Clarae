-- +goose Up
-- Remote changes that hit a locally modified file are parked here until the
-- merge succeeded (§3.4.4 B, §3.4.5). They are written in the same transaction
-- that moves the changelog cursor past them: once the cursor moved the server
-- never sends them again, so they must survive a failed merge, a cancelled
-- cycle or a restart of the application (D-04, no silent loss).
CREATE TABLE pending_remote (
  file_id     TEXT PRIMARY KEY,
  rev         INTEGER NOT NULL,
  change      TEXT NOT NULL,                    -- JSON of the changelog entry (transport.Change)
  created_at  INTEGER NOT NULL
);

-- Server entries this device cannot read (a path token that does not decrypt
-- with the vault key). They are never applied nor treated as deletions; the
-- record explains why the file is missing and lets a later version retry.
CREATE TABLE quarantine (
  file_id     TEXT PRIMARY KEY,
  rev         INTEGER NOT NULL,
  reason      TEXT NOT NULL,
  created_at  INTEGER NOT NULL
);

-- +goose Down
DROP TABLE quarantine;
DROP TABLE pending_remote;
