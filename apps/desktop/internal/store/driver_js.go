//go:build js

package store

import "memobrain/apps/desktop/internal/sqlitejs"

// Exists reports whether a database is stored under path (in sqlite-wasm's VFS, not in the file
// system the os package sees).
func Exists(path string) (bool, error) { return sqlitejs.Exists(path) }

// removeDatabase deletes a database owned by sqlite-wasm: its files live in the browser's SQLite
// VFS, outside the file system the os package sees.
func removeDatabase(path string) error { return sqlitejs.DeleteDatabase(path) }
