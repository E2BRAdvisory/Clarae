// Package vaultdir owns the move of the configuration folder of a vault from the name
// it had up to 1.4.0 (pathrules.LegacyConfigDirs) to the current one (ADR-0052, M17 C2).
//
// The folder holds two kinds of things:
//
//   - the local part: index.db, sync.db and their journals, cache/, snapshots/, workspace*.json,
//     that is, everything pathrules.IsExcluded says is never synchronized. Ensure moves it to the
//     current folder, once, the first time a vault is opened (and before SQLite opens anything);
//   - the settings that sync (editor.json, hotkeys.json, templates/, ...). A vault linked to the
//     cloud keeps them where they are: a 1.4.0 client sharing the vault still reads and writes the
//     former folder, and the move is made later by the sync engine, as an ordinary move with the
//     same file id (internal/sync, features.config_dir_v2). A vault that is not linked has nobody
//     to stay compatible with: AdoptSettings moves them too.
//
// DB is the only way to obtain the path of index.db or sync.db: it calls Ensure, so that the
// databases of a folder that is not open (a mount under mounts/) are found in the same place as
// those of an open vault.
//
// The moves follow one rule per entry: what is in the former folder and not in the current one
// is renamed (atomic for each entry), so a crash at any point leaves a state the next call
// finishes. When an entry exists in both, the current folder wins and the former one stays where
// it is (logged): nothing is ever deleted or overwritten. The former folder itself is removed only
// when it is empty.
package vaultdir

import (
	"errors"
	"fmt"
	"io/fs"
	"log/slog"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"

	"clarae/shared/pathrules"
)

// afterRename, when set (tests), runs after each rename: it stands for a crash at that point.
var afterRename func(newPath string)

// locks serializes the moves of one folder inside the process (a vault opened by the UI while
// the same folder is read as a mount, say).
var locks sync.Map // root -> *sync.Mutex

func lock(root string) (unlock func()) {
	key := filepath.Clean(root)
	if r, err := filepath.EvalSymlinks(key); err == nil {
		key = r
	}
	m, _ := locks.LoadOrStore(key, new(sync.Mutex))
	mu := m.(*sync.Mutex)
	mu.Lock()
	return mu.Unlock
}

// DB returns the path of the database name ("index.db" or "sync.db") of the vault at root,
// after Ensure has moved the local part of a former configuration folder. It is the only place
// that builds that path.
func DB(root, name string) (string, error) {
	if err := Ensure(root); err != nil {
		return "", err
	}
	return dbPath(root, name), nil
}

// Ensure moves the local part of the former configuration folder of the vault at root to the
// current one (see the package comment). It is idempotent, resumable after a crash, and costs one
// Lstat when there is nothing to do. It never overwrites or deletes: an entry present in both
// folders stays in the former one.
func Ensure(root string) error {
	unlock := lock(root)
	defer unlock()
	return moveFromLegacy(root, func(rel string) bool { return pathrules.IsExcluded(rel, false) })
}

// AdoptSettings moves the whole former configuration folder, settings included, to the current
// one. It is for a vault that is not linked to the cloud: no other client reads the former
// folder. The caller must not use it while the vault is open to the UI (nothing else may be
// writing the settings).
func AdoptSettings(root string) error {
	unlock := lock(root)
	defer unlock()
	return moveFromLegacy(root, func(string) bool { return true })
}

// moveFromLegacy moves the entries of each former configuration folder of root for which want
// (given the vault-relative path of the entry in the former folder) is true.
func moveFromLegacy(root string, want func(rel string) bool) error {
	for _, legacy := range pathrules.LegacyConfigDirs {
		oldDir := filepath.Join(root, legacy)
		st, err := os.Lstat(oldDir)
		switch {
		case errors.Is(err, fs.ErrNotExist):
			continue
		case err != nil:
			return err
		case !st.IsDir():
			// A symlink or a file: moving what it points to is not ours to do.
			slog.Warn("vaultdir: the former configuration folder is not a directory; left alone", "path", oldDir)
			continue
		}
		newDir := filepath.Join(root, pathrules.ConfigDir)
		if err := ensureDir(newDir, st.Mode().Perm()); err != nil {
			return err
		}
		entries, err := os.ReadDir(oldDir)
		if err != nil {
			return err
		}
		for _, name := range orderedNames(entries) {
			if !want(legacy + "/" + name) {
				continue
			}
			if err := moveEntry(filepath.Join(oldDir, name), filepath.Join(newDir, name), isSidecar(name)); err != nil {
				return err
			}
		}
		// Only an empty folder goes (os.Remove refuses a non-empty one, on every platform and in
		// the browser's file system).
		if err := os.Remove(oldDir); err != nil && !isNotEmpty(err) && !errors.Is(err, fs.ErrNotExist) {
			slog.Warn("vaultdir: cannot remove the former configuration folder", "path", oldDir, "err", err)
		}
	}
	return nil
}

// ensureDir creates dir when it is missing and refuses to go on when something else is there (a
// symlink would send the databases outside the vault).
func ensureDir(dir string, perm fs.FileMode) error {
	st, err := os.Lstat(dir)
	switch {
	case err == nil && st.IsDir():
		return nil
	case err == nil:
		return fmt.Errorf("vaultdir: %s is not a directory", dir)
	case !errors.Is(err, fs.ErrNotExist):
		return err
	}
	if perm == 0 {
		perm = 0o755
	}
	if err := os.Mkdir(dir, perm); err != nil && !errors.Is(err, fs.ErrExist) {
		return err
	}
	return nil
}

// moveEntry renames oldPath to newPath when newPath does not exist. Two directories are merged,
// entry by entry, with the same rule (a rename of a whole directory may be a copy in the browser's
// file system, so a directory already present is never replaced as a whole). When newPath exists
// and is not a directory pair, oldPath stays where it is. sidecar is set for the journal of an
// SQLite database (see moveSidecar).
func moveEntry(oldPath, newPath string, sidecar bool) error {
	if sidecar && !sidecarMayMove(oldPath, newPath) {
		return nil
	}
	oldSt, err := os.Lstat(oldPath)
	if err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			return nil // gone since the listing
		}
		return err
	}
	newSt, err := os.Lstat(newPath)
	switch {
	case errors.Is(err, fs.ErrNotExist):
		if err := os.Rename(oldPath, newPath); err != nil {
			return fmt.Errorf("vaultdir: move %s to %s: %w", oldPath, newPath, err)
		}
		if afterRename != nil {
			afterRename(newPath)
		}
		return nil
	case err != nil:
		return err
	}
	if oldSt.IsDir() && newSt.IsDir() {
		entries, err := os.ReadDir(oldPath)
		if err != nil {
			return err
		}
		for _, e := range entries {
			if err := moveEntry(filepath.Join(oldPath, e.Name()), filepath.Join(newPath, e.Name()), false); err != nil {
				return err
			}
		}
		if err := os.Remove(oldPath); err != nil && !isNotEmpty(err) && !errors.Is(err, fs.ErrNotExist) {
			slog.Warn("vaultdir: cannot remove an emptied folder", "path", oldPath, "err", err)
		}
		return nil
	}
	slog.Warn("vaultdir: the current configuration folder already has this entry; the former one is kept as it is",
		"former", oldPath, "current", newPath)
	return nil
}

// sidecarSuffixes are the side files of an SQLite database. They belong to one main file: they
// move before it, and only while the current folder has no main file of that name, so that a
// write-ahead log is never applied to another database than the one it was written for. A crash
// after the journals and before the main file leaves the main file in the former folder, where
// the next call finds it (the rule "in the former folder, not in the current one").
var sidecarSuffixes = []string{"-wal", "-shm", "-journal"}

func isSidecar(name string) bool {
	_, ok := mainOf(name)
	return ok
}

// mainOf returns the database file a journal file belongs to ("sync.db-wal" -> "sync.db").
func mainOf(name string) (string, bool) {
	for _, s := range sidecarSuffixes {
		if strings.HasSuffix(name, ".db"+s) {
			return strings.TrimSuffix(name, s), true
		}
	}
	return "", false
}

// sidecarMayMove tells whether the journal oldPath may go to newPath: the current folder must not
// hold a main database of that name (that one has its own journal, or none).
func sidecarMayMove(oldPath, newPath string) bool {
	main, _ := mainOf(filepath.Base(newPath))
	if _, err := os.Lstat(filepath.Join(filepath.Dir(newPath), main)); err == nil {
		slog.Warn("vaultdir: the current configuration folder already has this database; its former journal is kept as it is",
			"journal", oldPath)
		return false
	}
	return true
}

// orderedNames lists the entries so that the journals of a database come before its main file.
func orderedNames(entries []fs.DirEntry) []string {
	names := make([]string, 0, len(entries))
	for _, e := range entries {
		names = append(names, e.Name())
	}
	sort.SliceStable(names, func(i, j int) bool {
		si, sj := isSidecar(names[i]), isSidecar(names[j])
		if si != sj {
			return si
		}
		return names[i] < names[j]
	})
	return names
}

func isNotEmpty(err error) bool {
	if errors.Is(err, fs.ErrExist) { // ENOTEMPTY is reported as EEXIST on some systems
		return true
	}
	var pe *fs.PathError
	if errors.As(err, &pe) {
		return strings.Contains(strings.ToLower(pe.Err.Error()), "not empty")
	}
	return false
}
