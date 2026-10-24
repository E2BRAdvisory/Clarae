-- +goose Up
-- Typed properties, tasks and block ids extracted by the parser (M1-WP7).
-- The index is derived data: after this migration a "Rebuild index" fills them
-- for notes that were indexed before.

CREATE TABLE properties (
  path  TEXT NOT NULL REFERENCES files(path) ON DELETE CASCADE,
  key   TEXT NOT NULL,         -- as written in the frontmatter
  kind  TEXT NOT NULL,         -- inferred: text | list | number | checkbox | date | datetime
  value TEXT NOT NULL          -- JSON
);
CREATE INDEX properties_path_ix ON properties(path);
CREATE INDEX properties_key_ix ON properties(lower(key));

CREATE TABLE tasks (
  path  TEXT NOT NULL REFERENCES files(path) ON DELETE CASCADE,
  line  INTEGER NOT NULL,
  state TEXT NOT NULL,         -- the character between the brackets
  text  TEXT NOT NULL
);
CREATE INDEX tasks_path_ix ON tasks(path);

CREATE TABLE block_ids (
  path TEXT NOT NULL REFERENCES files(path) ON DELETE CASCADE,
  line INTEGER NOT NULL,
  id   TEXT NOT NULL
);
CREATE INDEX block_ids_path_ix ON block_ids(path);

-- +goose Down
DROP TABLE block_ids;
DROP TABLE tasks;
DROP TABLE properties;
