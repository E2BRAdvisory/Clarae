//go:build js

package vaultdir

import (
	"path/filepath"

	"clarae/apps/desktop/internal/store"
	"clarae/shared/pathrules"
)

// dbPath is the key the database name is stored under in the browser's SQLite pool.
//
// There the databases are not files: sqlite-wasm keeps them in an OPFS pool (opfs-sahpool) under
// an opaque name, the path the core opened them with, and the pool has no rename. Moving one
// would mean copying its bytes (VACUUM INTO is not atomic and a crash would leave half of the
// sync state), which nothing in the core can do safely. So the key a profile of 1.x created stays
// the key of that database for as long as it is the one that exists: the current key when there is
// one, else the former key when a database is stored there, else the current key (a new database).
// Ensure moves the files of the folder as everywhere else; only these keys keep their name (class
// "legacy" of the rebrand guard).
func dbPath(root, name string) string {
	current := filepath.Join(root, pathrules.ConfigDir, name)
	if ok, _ := store.Exists(current); ok {
		return current
	}
	for _, dir := range pathrules.LegacyConfigDirs {
		former := filepath.Join(root, dir, name)
		if ok, _ := store.Exists(former); ok {
			return former
		}
	}
	return current
}
