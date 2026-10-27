// Package platform holds OS integration that is not vault specific: the
// application data directory, the nodus:// URL scheme and the single-instance
// identity.
package platform

import (
	"crypto/sha256"
	"encoding/hex"
	"os"
	"path/filepath"
)

// DataDirEnv overrides the application data directory. Two instances with
// different data directories can run side by side (useful to simulate two
// devices while developing sync).
const DataDirEnv = "NODUS_DATA_DIR"

// DataDir returns the application data directory, creating it if needed:
// $NODUS_DATA_DIR, otherwise <user config dir>/Nodus
// (~/Library/Application Support/Nodus, %AppData%\Nodus, ~/.config/Nodus).
func DataDir() (string, error) {
	dir := os.Getenv(DataDirEnv)
	if dir == "" {
		base, err := os.UserConfigDir()
		if err != nil {
			return "", err
		}
		dir = filepath.Join(base, "Nodus")
	}
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return "", err
	}
	return dir, nil
}

// InstanceID derives the single-instance lock id from the data directory so
// that instances with different data directories do not redirect to each
// other (Wails v2 SingleInstanceLock.UniqueId).
func InstanceID(dataDir string) string {
	sum := sha256.Sum256([]byte(filepath.Clean(dataDir)))
	return "dev.nodus.desktop." + hex.EncodeToString(sum[:8])
}
