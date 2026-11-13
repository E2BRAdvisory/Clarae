// Package platform holds OS integration that is not vault specific: the
// application data directory, the clarae:// URL scheme and the single-instance
// identity.
package platform

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"clarae/shared/envcompat"
)

// DataDirEnvName is the name, without the prefix, of the variable that overrides the application
// data directory (CLARAE_DATA_DIR; the name with the prefix of 1.x still works, see envcompat). Two instances
// with different data directories can run side by side (useful to simulate two devices while
// developing sync).
const DataDirEnvName = "DATA_DIR"

const (
	appDirName = "Clarae notanda"
	// legacyProductName is the name of the product up to 1.x, which is also the name of its data
	// directory, a sibling of the current one (dropped in 2.0).
	legacyProductName = "MemoBrain Notes"
	legacyAppDirName  = legacyProductName
	appDatabaseName   = "app.db"
)

// rename is os.Rename, replaced by the tests that make a move fail half way.
var rename = os.Rename

// Note is something DataDir did that the log should say: the logger lives inside the data
// directory, so it does not exist yet when the directory is resolved.
type Note struct {
	Warn bool
	Msg  string
}

// DataDirInfo is the result of ResolveDataDir.
type DataDirInfo struct {
	// Dir is the application data directory, created.
	Dir string
	// Explicit: Dir was asked for (flag or environment), so nothing was taken over from 1.x.
	Explicit bool
	// LegacyDir is the data directory of 1.x next to Dir, set when Dir is the default one (even if
	// it does not exist, or was left alone). The references to paths inside it are rewritten from it
	// (the recent vaults).
	LegacyDir string
	// Migrated: this call moved LegacyDir to Dir.
	Migrated bool
	// Notes are for the log.
	Notes []Note
}

// LegacyDataDirError says that the data directory of 1.x exists, could not be taken over, and that
// working in a second folder would split the user's data in two. The application tells the user and
// does not start.
type LegacyDataDirError struct {
	Legacy string
	// InUse: an instance of the old application has the folder open.
	InUse bool
	Err   error
}

func (e *LegacyDataDirError) Error() string {
	if e.InUse {
		return fmt.Sprintf("the data directory %q of the previous version is in use by another instance", e.Legacy)
	}
	return fmt.Sprintf("cannot take over the data directory %q of the previous version: %v", e.Legacy, e.Err)
}

func (e *LegacyDataDirError) Unwrap() error { return e.Err }

// UserMessage is what the dialog at startup says.
func (e *LegacyDataDirError) UserMessage() string {
	if e.InUse {
		return appDirName + " found the data of " + legacyProductName + " and needs to move it, but " + legacyProductName + " is still running.\n\n" +
			"Close " + legacyProductName + " and start " + appDirName + " again."
	}
	return appDirName + " found the data of " + legacyProductName + " and could not move it:\n" + e.Err.Error() + "\n\n" +
		"Close " + legacyProductName + " and any program that uses the folder, then start " + appDirName + " again."
}

// ResolveDataDir finds the application data directory, takes over the one of 1.x, and creates it.
//
//  1. explicit (the flag --data-dir), otherwise $CLARAE_DATA_DIR, otherwise the variable of 1.x
//     with the same name and the old prefix: used as it is, nothing is migrated;
//  2. otherwise <user config dir>/Clarae notanda
//     (~/Library/Application Support, %AppData%, ~/.config), and then:
//     - it has an app.db: it is the one; a folder of 1.x still there stays as it is, and is logged;
//     - there is only the data directory of 1.x, next to it: it is moved (adoptLegacy);
//     - neither: a new one.
//
// A *LegacyDataDirError is returned when the folder of 1.x cannot be taken over.
func ResolveDataDir(explicit string) (DataDirInfo, error) {
	return resolveDataDir(explicit, os.UserConfigDir, quiesceDatabase)
}

func resolveDataDir(explicit string, userConfigDir func() (string, error), quiesce func(dbPath string) error) (DataDirInfo, error) {
	var info DataDirInfo
	switch {
	case explicit != "":
		info.Dir, info.Explicit = explicit, true
	default:
		if v, deprecated := envcompat.Lookup(DataDirEnvName); v != "" {
			info.Dir, info.Explicit = v, true
			if deprecated {
				info.Notes = append(info.Notes, Note{Warn: true, Msg: envcompat.LegacyPrefix + DataDirEnvName + " is deprecated: use " + envcompat.Prefix + DataDirEnvName})
			}
		}
	}
	if !info.Explicit {
		base, err := userConfigDir()
		if err != nil {
			return info, err
		}
		info.Dir = filepath.Join(base, appDirName)
		info.LegacyDir = filepath.Join(base, legacyAppDirName)
		if err := adoptLegacy(&info, quiesce); err != nil {
			return info, err
		}
	}
	if err := os.MkdirAll(info.Dir, 0o700); err != nil {
		return info, err
	}
	return info, nil
}

// adoptLegacy moves the data directory of 1.x to the current one, when that is what is called for.
func adoptLegacy(info *DataDirInfo, quiesce func(string) error) error {
	dir, legacy := info.Dir, info.LegacyDir
	li, err := os.Stat(legacy) // a link to a folder counts: it is moved as a link
	if errors.Is(err, fs.ErrNotExist) || err == nil && !li.IsDir() {
		return nil // nothing of 1.x here
	}
	if err != nil {
		return &LegacyDataDirError{Legacy: legacy, Err: err}
	}
	if present, _ := fileExists(filepath.Join(dir, appDatabaseName)); present {
		// The migration was done (app.db is the last thing it moves), or Clarae notanda was used on
		// its own: this is the data that counts. The old folder is not merged: whatever it holds
		// stays there for the user.
		info.Notes = append(info.Notes, Note{Msg: "the data directory of the previous version is still at " + legacy + " and is not used"})
		return nil
	}

	if present, _ := fileExists(filepath.Join(legacy, appDatabaseName)); present {
		switch err := quiesce(filepath.Join(legacy, appDatabaseName)); {
		case errors.Is(err, errInUse):
			return &LegacyDataDirError{Legacy: legacy, InUse: true, Err: err}
		case err != nil:
			// Not readable as a database: nobody can be using it, and moving a file does not make it worse.
			info.Notes = append(info.Notes, Note{Warn: true, Msg: "the database of the previous version could not be checked: " + err.Error()})
		}
	}

	var notes []Note
	if _, err := os.Lstat(dir); errors.Is(err, fs.ErrNotExist) {
		// Same parent: one atomic step.
		if err := rename(legacy, dir); err != nil {
			return &LegacyDataDirError{Legacy: legacy, Err: err}
		}
	} else if err != nil {
		return &LegacyDataDirError{Legacy: legacy, Err: err}
	} else if err := moveEntries(legacy, dir, &notes); err != nil {
		return &LegacyDataDirError{Legacy: legacy, Err: err}
	}
	info.Migrated = true
	info.Notes = append(info.Notes, Note{Msg: "moved the data directory of the previous version from " + legacy + " to " + dir})
	info.Notes = append(info.Notes, notes...)
	return nil
}

// moveEntries moves what the folder src holds into dst, which exists: the case of a migration that
// stopped half way, or of a dst made in the meantime (a log, say). app.db goes last, so that its
// presence in dst says the migration is complete, and a restart picks up where this stopped.
func moveEntries(src, dst string, notes *[]Note) error {
	entries, err := os.ReadDir(src)
	if errors.Is(err, fs.ErrNotExist) {
		return nil // another instance of this version, started at the same moment, took it over
	}
	if err != nil {
		return err
	}
	rank := func(name string) int {
		switch {
		case name == appDatabaseName:
			return 2
		case strings.HasPrefix(name, appDatabaseName+"-"):
			return 1 // -wal, -shm, -journal: with the database they belong to, not after it
		}
		return 0
	}
	sort.SliceStable(entries, func(i, j int) bool { return rank(entries[i].Name()) < rank(entries[j].Name()) })
	for _, e := range entries {
		if err := moveTree(filepath.Join(src, e.Name()), filepath.Join(dst, e.Name()), notes); err != nil {
			return err
		}
	}
	_ = os.Remove(src) // only if it is empty now
	return nil
}

// moveTree renames src to dst. If dst exists, two folders are merged entry by entry, and for
// anything else dst wins and src stays where it is: nothing is overwritten.
func moveTree(src, dst string, notes *[]Note) error {
	di, err := os.Lstat(dst)
	if errors.Is(err, fs.ErrNotExist) {
		return rename(src, dst)
	}
	if err != nil {
		return err
	}
	si, err := os.Lstat(src)
	if err != nil {
		return err
	}
	if si.IsDir() && di.IsDir() {
		return moveEntries(src, dst, notes)
	}
	*notes = append(*notes, Note{Warn: true, Msg: "left " + src + " where it is: " + dst + " exists"})
	return nil
}

func fileExists(path string) (bool, error) {
	_, err := os.Stat(path)
	if errors.Is(err, fs.ErrNotExist) {
		return false, nil
	}
	return err == nil, err
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
