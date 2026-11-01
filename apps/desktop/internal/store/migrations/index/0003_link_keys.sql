-- +goose Up
-- Name token of the lookups a link resolution makes (links.LinkKey): a change
-- of the file set re-resolves only the links whose key matches a token of the
-- files that appeared, disappeared or changed their aliases, instead of every
-- link of the vault. NULL until computed: rows indexed before this migration
-- are filled by the next full pass (links.ResolveAll) and treated as matching
-- every change until then.
ALTER TABLE links ADD COLUMN target_key TEXT;
CREATE INDEX links_key_ix ON links(target_key);

-- +goose Down
DROP INDEX links_key_ix;
ALTER TABLE links DROP COLUMN target_key;
