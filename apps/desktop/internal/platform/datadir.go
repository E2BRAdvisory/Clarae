// Package platform holds OS integration that is not vault specific: the
// application data directory, the clarae:// URL scheme and the single-instance
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
const DataDirEnv = "CLARAE_DATA_DIR"

// DataDir returns the application data directory, creating it if needed:
// $CLARAE_DATA_DIR, otherwise <user config dir>/Clarae notanda
// (~/Library/Application Support/Clarae notanda, %AppData%\Clarae notanda, ~/.config/Clarae notanda).
func DataDir() (string, error) {
	dir := os.Getenv(DataDirEnv)
	if dir == "" {
		base, err := os.UserConfigDir()
		if err != nil {
			return "", err
		}
		dir = filepath.Join(base, "Clarae notanda")
	}
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return "", err
	}
	return dir, nil
}

// instanceIDPrefix starts every single-instance id. Wails v3 turns the id into a D-Bus name on
// Linux, and D-Bus refuses a dot-separated element that starts with a digit: the element that holds
// the hash starts with a letter ("i"), so no data directory can produce a name that is refused (a
// bare hex element starts with a digit in 10 cases out of 16).
const instanceIDPrefix = "dev.clarae.desktop.i"

// InstanceID derives the single-instance lock id from the data directory so
// that instances with different data directories do not redirect to each
// other (Wails SingleInstance UniqueID): "dev.clarae.desktop.i<16 hex>".
func InstanceID(dataDir string) string {
	sum := sha256.Sum256([]byte(filepath.Clean(dataDir)))
	return instanceIDPrefix + hex.EncodeToString(sum[:8])
}

// InstanceKey is the key that encrypts the messages between a second instance and the first one
// (SingleInstance EncryptionKey). It is derived from the id, not random: both instances compute
// it with no state to share, and a stale file or a different key between versions cannot lock the
// application out. It keeps other processes from injecting arguments by accident; the arguments
// stay untrusted either way (ParseSchemeURL).
func InstanceKey(id string) [32]byte {
	return sha256.Sum256([]byte("clarae/single-instance/" + id))
}
