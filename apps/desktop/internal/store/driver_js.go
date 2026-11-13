//go:build js

package store

import (
	"os"
	"path/filepath"
	"slices"
	"strings"

	"clarae/apps/desktop/internal/sqlitejs"
	"clarae/shared/pathrules"
)

// prepareDir creates the folder of a database. A database of the browser core is a name in
// sqlite-wasm's pool, not a file, so the folder only has to exist for what else the core keeps in
// it; the one that must not be created is a former configuration folder: a profile of 1.x keeps
// its databases under that key (vaultdir.DB), and an empty folder of that name would end up in
// the ZIP of the vault.
func prepareDir(dir string) error {
	if slices.Contains(pathrules.LegacyConfigDirs, filepath.Base(dir)) {
		return nil
	}
	return os.MkdirAll(dir, 0o700)
}

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
