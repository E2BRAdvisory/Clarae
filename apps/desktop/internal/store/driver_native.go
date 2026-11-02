//go:build !js

package store

import (
	"errors"
	"io"
	"os"

	_ "modernc.org/sqlite" // database/sql driver "sqlite"
)

// Exists reports whether the database file at path exists.
func Exists(path string) (bool, error) {
	_, err := os.Stat(path)
	if errors.Is(err, os.ErrNotExist) {
		return false, nil
	}
	return err == nil, err
}

// removeDatabase deletes the database file and its journal files.
func removeDatabase(path string) error {
	for _, suffix := range []string{"", "-wal", "-shm", "-journal"} {
		if err := os.Remove(path + suffix); err != nil && !os.IsNotExist(err) {
			return err
		}
	}
	return nil
}

// legacyDatabase returns where store.Open before M12 put the database at path (legacyURIPath)
// and whether an SQLite database is there, when that is not path itself.
func legacyDatabase(path string) (string, bool) {
	legacy := legacyURIPath(path)
	if legacy == "" || legacy == path {
		return legacy, false
	}
	f, err := os.Open(legacy)
	if err != nil {
		return legacy, false
	}
	defer func() { _ = f.Close() }()
	header := make([]byte, len(sqliteHeader))
	_, err = io.ReadFull(f, header)
	return legacy, err == nil && string(header) == sqliteHeader
}

// sqliteHeader opens every SQLite database file.
const sqliteHeader = "SQLite format 3\x00"
