package vaultdir

import (
	"crypto/sha256"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"log/slog"
	"os"
	"path/filepath"
	"strings"

	"clarae/shared/pathrules"
)

// CleanupLegacy removes what Ensure and AdoptSettings left in the former configuration folder
// (ADR-0059): they never overwrite or delete, so an entry that exists in both folders stays in
// the former one for good. It runs when a vault is opened, once per version of the application
// (the marker is a file under .clarae/cache/, which is never synchronized), and only ever takes
// away a copy that the current folder makes redundant:
//
//   - the local-only entries (index.db*, sync.db*, workspace*.json, cache/) that the current folder
//     has: deleted. Only while the sync.db in use is the one of the current folder (in the browser
//     core a database keeps the key it was created under, dbPath): then the former files are
//     the ones in use and nothing of them is touched;
//   - snapshots/: an entry the current folder does not have moves there; an identical one is
//     deleted; one that differs stays, as it is the only copy of that version;
//   - the settings that sync, of a vault that is not linked to the cloud: deleted when identical
//     to the current copy, moved to the vault's trash when different. A linked vault keeps them:
//     the sync engine deletes their rows on the server and takes them off the disk
//     (internal/sync, configmigrate.go);
//   - OS junk files (.DS_Store, ...), and every folder the cleanup empties, the former folder
//     itself included.
//
// Anything else, symlinks included, stays where it is. The former folder is removed only when
// nothing is left in it.
func CleanupLegacy(root string, o CleanupOptions) (CleanupResult, error) {
	unlock := lock(root)
	defer unlock()
	var res CleanupResult
	marker := filepath.Join(root, pathrules.ConfigDir, "cache", cleanupMarker)
	version := o.Version
	if version == "" {
		version = "unknown"
	}
	if b, err := os.ReadFile(marker); err == nil && strings.TrimSpace(string(b)) == version {
		return res, nil
	}
	found := false
	for _, name := range pathrules.LegacyConfigDirs {
		oldDir := filepath.Join(root, name)
		st, err := os.Lstat(oldDir)
		if errors.Is(err, fs.ErrNotExist) {
			continue
		}
		if err != nil {
			return res, err
		}
		if !st.IsDir() {
			continue // a symlink or a file: not ours
		}
		found = true
		c := &cleaner{root: root, legacyName: name, opts: o, res: &res}
		c.dbCurrent = dbPath(root, "sync.db") == filepath.Join(root, pathrules.ConfigDir, "sync.db") &&
			dbPath(root, "index.db") == filepath.Join(root, pathrules.ConfigDir, "index.db")
		if err := c.dir(oldDir, ""); err != nil {
			return res, err
		}
	}
	if !found {
		return res, nil // nothing to clean, nothing written
	}
	if err := os.MkdirAll(filepath.Dir(marker), 0o755); err != nil {
		return res, err
	}
	if err := os.WriteFile(marker, []byte(version+"\n"), 0o644); err != nil {
		return res, err
	}
	return res, nil
}

// cleanupMarker is the file, in .clarae/cache/, that holds the version that last ran the cleanup.
const cleanupMarker = "legacy-config-cleanup"

// CleanupOptions are the inputs of CleanupLegacy.
type CleanupOptions struct {
	// Version is the version of the application: the cleanup runs once for each.
	Version string
	// Linked says that the vault is linked to the cloud (or that this is not known): its settings
	// are left to the sync engine.
	Linked bool
	// Trash moves a vault-relative path to the vault's trash (vault.FS.Trash). nil leaves the
	// settings of an unlinked vault that differ from the current ones where they are.
	Trash func(rel string) error
}

// CleanupResult counts what CleanupLegacy did.
type CleanupResult struct {
	Deleted, Moved, Trashed, Kept int
}

type cleaner struct {
	root       string
	legacyName string
	opts       CleanupOptions
	res        *CleanupResult
	dbCurrent  bool
}

// dir cleans the folder abs (rel is its path inside the former folder, "" for the folder itself)
// and removes it when it is left empty.
func (c *cleaner) dir(abs, rel string) error {
	entries, err := os.ReadDir(abs)
	if err != nil {
		return err
	}
	for _, e := range entries {
		childRel := e.Name()
		if rel != "" {
			childRel = rel + "/" + e.Name()
		}
		childAbs := filepath.Join(abs, e.Name())
		// DirEntry.Type does not follow symlinks: a link is never entered or removed.
		switch {
		case e.Type()&fs.ModeSymlink != 0:
			c.res.Kept++
		case e.IsDir():
			if err := c.dir(childAbs, childRel); err != nil {
				return err
			}
		case e.Type().IsRegular():
			if err := c.file(childAbs, childRel); err != nil {
				return err
			}
		default:
			c.res.Kept++
		}
	}
	if err := os.Remove(abs); err != nil && !isNotEmpty(err) && !errors.Is(err, fs.ErrNotExist) {
		slog.Warn("vaultdir: cannot remove an emptied former folder", "path", abs, "err", err)
	}
	return nil
}

func isJunk(name string) bool {
	switch name {
	case ".DS_Store", "Thumbs.db", "desktop.ini":
		return true
	}
	return false
}

// file decides what becomes of one file of the former folder.
func (c *cleaner) file(abs, rel string) error {
	if isJunk(filepath.Base(abs)) {
		return c.delete(abs)
	}
	cur := filepath.Join(c.root, pathrules.ConfigDir, filepath.FromSlash(rel))
	curSt, curErr := os.Lstat(cur)
	switch {
	case curErr == nil && !curSt.Mode().IsRegular():
		c.res.Kept++ // a folder or a link where the file would be: not ours to judge
		return nil
	case curErr != nil && !errors.Is(curErr, fs.ErrNotExist):
		return curErr
	}
	has := curErr == nil
	legacyRel := c.legacyName + "/" + rel

	if pathrules.IsExcluded(legacyRel, false) {
		if strings.HasPrefix(rel, "snapshots/") {
			return c.snapshot(abs, cur, has)
		}
		if !c.dbCurrent {
			c.res.Kept++ // the former file may be the one in use
			return nil
		}
		if !has && c.journalOfCurrentDB(cur) {
			has = true // the journal of a database that the current folder has: stale, like the former main file
		}
		if !has {
			c.res.Kept++ // the move did not happen: not ours to decide
			return nil
		}
		return c.delete(abs)
	}

	// A setting that syncs.
	if c.opts.Linked || !has {
		c.res.Kept++
		return nil
	}
	same, err := sameContent(abs, cur)
	if err != nil {
		return err
	}
	if same {
		return c.delete(abs)
	}
	if c.opts.Trash == nil {
		c.res.Kept++
		return nil
	}
	if err := c.opts.Trash(legacyRel); err != nil {
		return fmt.Errorf("vaultdir: move %s to the trash: %w", legacyRel, err)
	}
	c.res.Trashed++
	return nil
}

// journalOfCurrentDB tells whether cur (a path in the current folder) is the journal of a database
// that the current folder has.
func (c *cleaner) journalOfCurrentDB(cur string) bool {
	main, ok := mainOf(filepath.Base(cur))
	if !ok {
		return false
	}
	st, err := os.Lstat(filepath.Join(filepath.Dir(cur), main))
	return err == nil && st.Mode().IsRegular()
}

// snapshot moves a local history snapshot to the current folder, or drops it when the current
// folder has the same one.
func (c *cleaner) snapshot(abs, cur string, has bool) error {
	if !has {
		if err := os.MkdirAll(filepath.Dir(cur), 0o755); err != nil {
			return err
		}
		if err := os.Rename(abs, cur); err != nil {
			return fmt.Errorf("vaultdir: move %s to %s: %w", abs, cur, err)
		}
		c.res.Moved++
		return nil
	}
	same, err := sameContent(abs, cur)
	if err != nil {
		return err
	}
	if !same {
		c.res.Kept++ // two different versions under one name: the former one is kept
		return nil
	}
	return c.delete(abs)
}

func (c *cleaner) delete(abs string) error {
	if err := os.Remove(abs); err != nil && !errors.Is(err, fs.ErrNotExist) {
		return err
	}
	c.res.Deleted++
	return nil
}

// sameContent compares two files by SHA-256, reading both as streams.
func sameContent(a, b string) (bool, error) {
	ha, err := hashOf(a)
	if err != nil {
		return false, err
	}
	hb, err := hashOf(b)
	if err != nil {
		return false, err
	}
	return ha == hb, nil
}

func hashOf(path string) ([sha256.Size]byte, error) {
	var out [sha256.Size]byte
	f, err := os.Open(path)
	if err != nil {
		return out, err
	}
	defer func() { _ = f.Close() }()
	h := sha256.New()
	if _, err := io.Copy(h, f); err != nil {
		return out, err
	}
	copy(out[:], h.Sum(nil))
	return out, nil
}
