package app

import (
	"context"
	"errors"
	"io/fs"
	"os"
	"path"
	"path/filepath"
	"strings"

	"memobrain/apps/desktop/internal/indexer"
	"memobrain/apps/desktop/internal/vault"
	"memobrain/shared/syncproto"
)

// ChangeType says what happened to the path of a FileChange.
type ChangeType string

// Change types of FileChange.
const (
	ChangeCreate ChangeType = "create"
	ChangeModify ChangeType = "modify"
	ChangeDelete ChangeType = "delete"
)

// FileChange tells the frontend what happened to one path of a vault:file-changed batch, so it
// can patch its caches (the file tree, link resolutions) instead of reloading them. The watcher
// does not classify events; the type comes from a stat of the path and from the index as it was
// before the batch was applied: a file the index did not know is a creation.
type FileChange struct {
	Type ChangeType `json:"type"`
	Path string     `json:"path"`
	// Entry is the file or folder as it is now; absent for a deletion (and when the path could
	// not be read).
	Entry *vault.Entry `json:"entry,omitempty"`
}

// classifyChanges must run before the indexer sees the batch. A folder is always a creation (its
// contents arrive as paths of their own); when the index cannot be queried every file that
// exists counts as created, which only costs the frontend a few extra link resolutions.
func classifyChanges(ctx context.Context, v *openVault, paths []string) []FileChange {
	known := indexedPaths(ctx, v, paths)
	out := make([]FileChange, 0, len(paths))
	for _, p := range paths {
		if c, ok := statChange(v, p, known); ok {
			out = append(out, c)
		}
	}
	return out
}

// statChange describes what happened to one path from a stat of it now; known lists the files
// the index had before the change. ok is false for a path outside the vault.
func statChange(v *openVault, p string, known map[string]bool) (c FileChange, ok bool) {
	abs, normalized, err := v.FS.Resolve(p)
	if err != nil {
		return FileChange{}, false
	}
	st, err := os.Lstat(abs)
	switch {
	case errors.Is(err, fs.ErrNotExist):
		return FileChange{Type: ChangeDelete, Path: normalized}, true
	case err != nil || st.Mode()&fs.ModeSymlink != 0:
		// Unreadable, or a symlink (never part of the tree): content may have changed.
		return FileChange{Type: ChangeModify, Path: normalized}, true
	}
	e := &vault.Entry{Path: normalized, Name: filepath.Base(abs), IsDir: st.IsDir(), Mtime: st.ModTime()}
	typ := ChangeCreate
	if !e.IsDir {
		e.Kind = syncproto.KindOf(normalized)
		e.Size = st.Size()
		if known[normalized] {
			typ = ChangeModify
		}
	}
	return FileChange{Type: typ, Path: normalized, Entry: e}, true
}

// maxTypedChanges bounds the changes a reconciliation describes one by one: past it the event
// carries the paths only, and the frontend reloads its caches instead of patching them.
const maxTypedChanges = 5000

// reconciledChanges is the vault:file-changed payload of what a reconciliation found changed
// (indexer.Reconciled lists files only). A removed file whose folder is gone too also reports
// that folder (the topmost one missing) as deleted, so that the file tree drops it.
func reconciledChanges(v *openVault, r indexer.Reconciled) (paths []string, changes []FileChange) {
	known := make(map[string]bool, len(r.Modified))
	for _, p := range r.Modified {
		known[p] = true
	}
	seen := map[string]bool{}
	add := func(c FileChange) {
		if !seen[c.Path] {
			seen[c.Path] = true
			paths = append(paths, c.Path)
			changes = append(changes, c)
		}
	}
	for _, list := range [][]string{r.Added, r.Modified, r.Removed} {
		for _, p := range list {
			if c, ok := statChange(v, p, known); ok {
				add(c)
			}
		}
	}
	checked := map[string]bool{} // folders already looked at
	for _, p := range r.Removed {
		top := ""
		for dir := path.Dir(p); dir != "." && !checked[dir]; dir = path.Dir(dir) {
			checked[dir] = true
			abs, _, err := v.FS.Resolve(dir)
			if err != nil {
				break
			}
			if _, err := os.Lstat(abs); !errors.Is(err, fs.ErrNotExist) {
				break
			}
			top = dir
		}
		if top != "" {
			add(FileChange{Type: ChangeDelete, Path: top})
		}
	}
	if len(changes) > maxTypedChanges {
		changes = nil
	}
	return paths, changes
}

// indexedPaths returns which of paths the index has a row for (nil when it cannot tell).
func indexedPaths(ctx context.Context, v *openVault, paths []string) map[string]bool {
	if v.Indexer == nil || len(paths) == 0 {
		return nil
	}
	db := v.Indexer.DB()
	known := make(map[string]bool, len(paths))
	const chunk = 500 // well below SQLite's limit of bound parameters
	for start := 0; start < len(paths); start += chunk {
		part := paths[start:min(start+chunk, len(paths))]
		args := make([]any, len(part))
		for i, p := range part {
			args[i] = p
		}
		q := `SELECT path FROM files WHERE path IN (?` + strings.Repeat(`,?`, len(part)-1) + `)` //nolint:gosec // only placeholders are added
		rows, err := db.QueryContext(ctx, q, args...)
		if err != nil {
			return nil
		}
		for rows.Next() {
			var p string
			if rows.Scan(&p) == nil {
				known[p] = true
			}
		}
		err = rows.Err()
		_ = rows.Close()
		if err != nil {
			return nil
		}
	}
	return known
}
