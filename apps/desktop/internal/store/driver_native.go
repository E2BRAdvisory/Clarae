//go:build !js

package store

import (
	"errors"
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
