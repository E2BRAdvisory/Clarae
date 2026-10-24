package sync

import (
	"context"
	"os"
	"sort"
	"strings"
	"time"

	"github.com/google/uuid"

	"nodus/apps/desktop/internal/vault"
	"nodus/shared/pathrules"
)

type localFile struct {
	Size  int64
	Mtime int64
}

// walkLocal lists the vault files that take part in synchronization
// (§3.4.2: .DS_Store, *.tmp, the trash and device-local .nodus files are out).
func (e *Engine) walkLocal() (map[string]localFile, error) {
	out := map[string]localFile{}
	err := e.cfg.FS.Walk(func(en vault.Entry) error {
		if en.IsDir || pathrules.IsExcluded(en.Path, true) {
			return nil
		}
		out[en.Path] = localFile{Size: en.Size, Mtime: en.Mtime.UnixNano()}
		return nil
	})
	return out, err
}

func newFileID() string { return uuid.Must(uuid.NewV7()).String() }

// scan brings sync_files in line with the disk (§3.4.4 A): modified files
// are rehashed, vanished ones become deletions unless a new file with the same
// content shows up (a rename), and unknown files become new ones.
func (e *Engine) scan(ctx context.Context) error {
	started := e.cfg.Now()
	files, err := e.walkLocal()
	if err != nil {
		return err
	}
	rows, err := e.cfg.DB.Files(ctx)
	if err != nil {
		return err
	}
	byPath := make(map[string]File, len(rows))
	for _, r := range rows {
		byPath[r.Path] = r
	}
	// A file whose mtime is within two seconds of the previous scan may have
	// been modified again inside the same timestamp tick: rehash it.
	racy := e.lastScan.Add(-2 * time.Second)

	paths := make([]string, 0, len(files))
	for p := range files {
		paths = append(paths, p)
	}
	sort.Strings(paths)
	e.progress(0, len(paths))

	var newFiles []string
	for i, p := range paths {
		if i%200 == 0 {
			if err := ctx.Err(); err != nil {
				return err
			}
			e.progress(i, len(paths))
		}
		lf := files[p]
		row, ok := byPath[p]
		if !ok {
			newFiles = append(newFiles, p)
			continue
		}
		changed := lf.Size != row.LocalSize || lf.Mtime != row.LocalMtime || time.Unix(0, lf.Mtime).After(racy) || row.State == StateLocalDeleted
		if !changed {
			continue
		}
		h, _, err := e.cfg.FS.HashFile(p)
		if err != nil {
			if os.IsNotExist(err) {
				continue // vanished while scanning: the next scan sees it
			}
			return err
		}
		prevHash := row.LocalHash
		row.LocalSize, row.LocalMtime = lf.Size, lf.Mtime
		switch {
		case row.State == StateLocalDeleted:
			// The file is back.
			row.LocalHash = h
			if h == prevHash && row.ServerRev > 0 {
				row.State = StateSynced
			} else {
				row.State = StateLocalModify
			}
			row.Attempts, row.LastError = 0, ""
		case h != prevHash:
			row.LocalHash = h
			switch row.State {
			case StateSynced:
				row.State = StateLocalModify
			case StateLocalMoved:
				row.Dirty = true
			}
			row.Attempts, row.LastError = 0, ""
			if row.State == StateConflict {
				row.State = StateLocalModify
			}
		}
		if err := e.cfg.DB.PutFile(ctx, row); err != nil {
			return err
		}
	}

	// Rows whose file is gone.
	var missing []File
	for _, r := range rows {
		if _, ok := files[r.Path]; ok || r.State == StateLocalDeleted {
			continue
		}
		if r.State == StateLocalNew && r.ServerRev == 0 {
			// Never uploaded and already gone: nothing to tell the server.
			if err := e.cfg.DB.DeleteFile(ctx, r.FileID); err != nil {
				return err
			}
			_ = e.cfg.DB.DeleteOutbox(ctx, r.Path)
			continue
		}
		missing = append(missing, r)
	}

	// Renames: a new file with the content of a vanished one.
	byHash := map[string][]int{}
	for i, m := range missing {
		byHash[m.LocalHash] = append(byHash[m.LocalHash], i)
	}
	used := make([]bool, len(missing))
	for _, p := range newFiles {
		lf := files[p]
		h, _, err := e.cfg.FS.HashFile(p)
		if err != nil {
			if os.IsNotExist(err) {
				continue
			}
			return err
		}
		if idx := pickRename(byHash[h], missing, used, p); idx >= 0 {
			used[idx] = true
			r := missing[idx]
			if r.MovedFrom == "" {
				r.MovedFrom = r.Path
			}
			r.Path = p
			r.LocalSize, r.LocalMtime = lf.Size, lf.Mtime
			switch r.State {
			case StateSynced:
				r.State = StateLocalMoved
			case StateLocalModify:
				r.State, r.Dirty = StateLocalMoved, true
			}
			if err := e.cfg.DB.PutFile(ctx, r); err != nil {
				return err
			}
			continue
		}
		if err := e.cfg.DB.PutFile(ctx, File{Path: p, FileID: newFileID(), LocalHash: h, LocalSize: lf.Size, LocalMtime: lf.Mtime, State: StateLocalNew}); err != nil {
			return err
		}
	}
	for i, m := range missing {
		if used[i] {
			continue
		}
		m.State = StateLocalDeleted
		if err := e.cfg.DB.PutFile(ctx, m); err != nil {
			return err
		}
	}
	e.mu.Lock()
	e.lastScan = started
	e.mu.Unlock()
	return nil
}

// pickRename chooses which vanished file a new file replaces: same base name
// first (a move to another folder), otherwise the first unused candidate.
func pickRename(cands []int, missing []File, used []bool, newPath string) int {
	_, newBase := pathrules.Split(newPath)
	first := -1
	for _, i := range cands {
		if used[i] {
			continue
		}
		if first < 0 {
			first = i
		}
		if _, base := pathrules.Split(missing[i].Path); strings.EqualFold(base, newBase) {
			return i
		}
	}
	return first
}
