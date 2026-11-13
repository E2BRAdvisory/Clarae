//go:build js

package store

import (
	"strings"

	"clarae/apps/desktop/internal/sqlitejs"
)

// Exists reports whether a database is stored under path (in sqlite-wasm's VFS, not in the file
// system the os package sees).
func Exists(path string) (bool, error) { return sqlitejs.Exists(path) }

// removeDatabase deletes a database owned by sqlite-wasm: its files live in the browser's SQLite
// VFS, outside the file system the os package sees.
func removeDatabase(path string) error { return sqlitejs.DeleteDatabase(path) }

// legacyDatabase returns where store.Open before M12 put the database at path, and whether one is
// stored there. The sqlitejs driver read the unescaped DSN only up to its first '?', with no %HH
// decoding, so a '#' or a '%' never moved the database.
func legacyDatabase(path string) (string, bool) {
	legacy, _, _ := strings.Cut(path, "?")
	if legacy == "" || legacy == path {
		return legacy, false
	}
	ok, err := sqlitejs.Exists(legacy)
	return legacy, err == nil && ok
}
