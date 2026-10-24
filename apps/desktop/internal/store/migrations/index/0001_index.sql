-- +goose Up
-- Derived index of a vault (§2.4). Rebuildable: never synchronized.

CREATE TABLE files (
  id         INTEGER PRIMARY KEY, -- also the rowid of the matching fts_content row
  path       TEXT NOT NULL UNIQUE, -- normalized, vault relative
  kind       TEXT NOT NULL,      -- md | canvas | base | excalidraw | attachment | config | other
  mtime_ns   INTEGER NOT NULL,
  size       INTEGER NOT NULL,
  hash       TEXT NOT NULL,      -- sha256 hex of the content
  title      TEXT NOT NULL,      -- file name without extension
  word_count INTEGER NOT NULL DEFAULT 0,
  indexed_at TEXT NOT NULL
);

CREATE TABLE headings (
  path  TEXT NOT NULL REFERENCES files(path) ON DELETE CASCADE,
  level INTEGER NOT NULL,
  text  TEXT NOT NULL,
  line  INTEGER NOT NULL
);
CREATE INDEX headings_path_ix ON headings(path);

CREATE TABLE links (
  path            TEXT NOT NULL REFERENCES files(path) ON DELETE CASCADE,
  line            INTEGER NOT NULL,
  kind            TEXT NOT NULL,   -- wikilink | markdown | external
  target_raw      TEXT NOT NULL,   -- as written
  target_resolved TEXT,            -- resolved vault path, NULL when unresolved (ghost)
  heading         TEXT NOT NULL DEFAULT '',
  block           TEXT NOT NULL DEFAULT '',
  alias           TEXT NOT NULL DEFAULT '',
  embed           INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX links_path_ix ON links(path);
CREATE INDEX links_target_ix ON links(target_resolved);

CREATE TABLE tags (
  path TEXT NOT NULL REFERENCES files(path) ON DELETE CASCADE,
  line INTEGER NOT NULL,
  name TEXT NOT NULL             -- without '#', case preserved
);
CREATE INDEX tags_name_ix ON tags(name);
CREATE INDEX tags_path_ix ON tags(path);

CREATE TABLE aliases (
  path TEXT NOT NULL REFERENCES files(path) ON DELETE CASCADE,
  name TEXT NOT NULL
);
CREATE INDEX aliases_name_ix ON aliases(name);

-- Full-text search over title and body. Its rowid equals files.id, so rows are
-- reached in O(log n); `path` is UNINDEXED and must never be used to look rows up. The trigram tokenizer gives Obsidian
-- style substring matching (3+ characters); case-insensitive.
CREATE VIRTUAL TABLE fts_content USING fts5(
  path UNINDEXED,
  title,
  body,
  tokenize = 'trigram case_sensitive 0'
);

-- +goose Down
DROP TABLE fts_content;
DROP TABLE aliases;
DROP TABLE tags;
DROP TABLE links;
DROP TABLE headings;
DROP TABLE files;
