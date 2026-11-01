package app

import (
	"context"
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"strings"

	"memobrain/apps/desktop/internal/vault"
	"memobrain/shared/syncproto"
)

// Change types of FileChange.
const (
	ChangeCreate = "create"
	ChangeModify = "modify"
	ChangeDelete = "delete"
)

// FileChange tells the frontend what happened to one path of a vault:file-changed batch, so it
// can patch its caches (the file tree, link resolutions) instead of reloading them. The watcher
// does not classify events; the type comes from a stat of the path and from the index as it was
// before the batch was applied: a file the index did not know is a creation.
type FileChange struct {
	Type string `json:"type"`
	Path string `json:"path"`
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
		abs, normalized, err := v.FS.Resolve(p)
		if err != nil {
			continue
		}
		st, err := os.Lstat(abs)
		switch {
		case errors.Is(err, fs.ErrNotExist):
			out = append(out, FileChange{Type: ChangeDelete, Path: normalized})
			continue
		case err != nil || st.Mode()&fs.ModeSymlink != 0:
			// Unreadable, or a symlink (never part of the tree): content may have changed.
			out = append(out, FileChange{Type: ChangeModify, Path: normalized})
			continue
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
		out = append(out, FileChange{Type: typ, Path: normalized, Entry: e})
	}
	return out
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
