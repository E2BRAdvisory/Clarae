//go:build !js

package vaultdir

import (
	"path/filepath"

	"clarae/shared/pathrules"
)

// dbPath is where the database name lives: databases are files, and Ensure has moved them.
func dbPath(root, name string) string {
	return filepath.Join(root, pathrules.ConfigDir, name)
}
