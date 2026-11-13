package sync

import (
	"context"
	"os"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/google/uuid"

	"clarae/apps/desktop/internal/vault"
	"clarae/shared/pathrules"
)

type localFile struct {
	Size  int64
	Mtime int64
}

// walkLocal lists the vault files that take part in synchronization
// (§3.4.2: .DS_Store, *.tmp, the trash and device-local .clarae files are out).
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
	e.mu.Lock()
	e.scans++
	e.mu.Unlock()
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
	trustBefore, err := e.trustBefore(ctx, started)
	if err != nil {
		return err
	}

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
		changed := lf.Size != row.LocalSize || lf.Mtime != row.LocalMtime || !time.Unix(0, lf.Mtime).Before(trustBefore) || row.State == StateLocalDeleted
		if !changed {
			continue
		}
		h, _, err := e.hashFile(p)
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
			backFromDeleted(&row, e.cfg.Cipher != nil)
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
		h, _, err := e.hashFile(p)
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
			if r.State == StateLocalMoved {
				// A new destination is a new attempt (a move parked by the
				// server, e.g. SHARE_ROOT_MOVE, is tried again), and a file
				// moved back where the server has it is no move any more
				// (an edit made meanwhile is still sent).
				r.Attempts, r.LastError = 0, ""
				if r.MovedFrom == r.Path {
					settleMoved(&r)
				}
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
	// Every row now matches the disk as seen after started: only then may the
	// next scan (possibly of another engine, after a restart) rely on it.
	if err := e.cfg.DB.SetMeta(ctx, MetaLastScan, strconv.FormatInt(started.UnixNano(), 10)); err != nil {
		return err
	}
	e.mu.Lock()
	e.lastScan = started
	e.mu.Unlock()
	return nil
}

// backFromDeleted gives a row the scan had marked deleted, whose file is back
// with content r.LocalHash, the state that tells what is left to send. The
// content is compared with the server's revision, never with the hash the
// file had before it vanished: that one may be an edit never sent. A move
// still to send stays one. In a private vault the server hash is the digest
// of a ciphertext and proves nothing, so the content is sent again (as
// Engine.Renamed does).
func backFromDeleted(r *File, private bool) {
	same := !private && r.LocalHash == r.ServerHash
	switch {
	case r.ServerRev == 0:
		r.State, r.MovedFrom, r.Dirty = StateLocalNew, "", false
	case r.Tombstoned:
		// Deleted on the server meanwhile: the file goes back as a revival
		// (a modify that carries its path, §3.4.5).
		r.State, r.MovedFrom, r.Dirty = StateLocalModify, "", false
	case r.MovedFrom != "":
		r.State, r.Dirty = StateLocalMoved, !same
	case same:
		r.State, r.Dirty = StateSynced, false
	default:
		r.State, r.Dirty = StateLocalModify, false
	}
}

// racyWindow covers the coarsest file system timestamp we expect (FAT: 2 s).
const racyWindow = 2 * time.Second

// trustBefore returns the time before which an unchanged (size, mtime) proves
// an unchanged file, for a scan that starts at now.
//
// Each row's (size, mtime) was observed at some time T >= S, S being the start
// of the last complete scan: that scan verified every row (hashing the ones it
// could not trust), and every row written since (pull, merge, push) was
// observed later still. A write after T sets the mtime to the time of the
// write, truncated to the file system's tick, so at least T - racyWindow > S -
// racyWindow. Hence a file whose size and mtime equal its row's and whose mtime
// lies before S - racyWindow has not been written since it was observed (git's
// "racily clean" rule). Files modified while the application was closed
// carry a newer mtime and are rehashed like any other change.
//
// S is kept in sync.db (MetaLastScan), so the first scan after a restart
// applies the same rule as the following ones. It is only written once a scan
// completed: an interrupted scan leaves the previous, older S, which trusts
// fewer files. Without a usable S nothing is trusted and every known file is
// rehashed: the value is missing (first scan since this version or since the
// database was created) or lies in the future, because the clock went back
// (mtimes written after the jump could then fall before S yet postdate the
// observation). There is no sound per-file shortcut in that case: the time a
// row was observed is not recorded, and a row observed in the same tick as
// its file's last write looks exactly like an old one.
func (e *Engine) trustBefore(ctx context.Context, now time.Time) (time.Time, error) {
	if !e.scanLoaded {
		v, err := e.cfg.DB.Meta(ctx, MetaLastScan)
		if err != nil {
			return time.Time{}, err
		}
		if ns, err := strconv.ParseInt(v, 10, 64); err == nil && ns > 0 {
			e.mu.Lock()
			if e.lastScan.IsZero() {
				e.lastScan = time.Unix(0, ns)
			}
			e.mu.Unlock()
		}
		e.scanLoaded = true
	}
	e.mu.Lock()
	last := e.lastScan
	e.mu.Unlock()
	if last.IsZero() || last.After(now) {
		return time.Time{}, nil // trust nothing (Before(zero) is false for every mtime)
	}
	return last.Add(-racyWindow), nil
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
