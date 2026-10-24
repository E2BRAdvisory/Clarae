-- +goose Up
CREATE TABLE recent_vaults (
  path           TEXT PRIMARY KEY,
  name           TEXT NOT NULL,
  last_opened_at TEXT NOT NULL
);

CREATE TABLE app_settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL -- JSON
);

-- +goose Down
DROP TABLE app_settings;
DROP TABLE recent_vaults;
