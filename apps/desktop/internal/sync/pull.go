package sync

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"os"
	"sort"
	"strings"

	"memobrain/apps/desktop/internal/sync/transport"
	"memobrain/apps/desktop/internal/vault"
	"memobrain/shared/syncproto"
)

type transportChange = transport.Change

// clearPath turns a server path into the local one (decrypting tokens in
// private vaults).
func (e *Engine) clearPath(serverPath string) (string, error) {
	if e.cfg.Cipher == nil {
		return serverPath, nil
	}
	return e.cfg.Cipher.DecryptPath(serverPath)
}

// fetch downloads a blob, verifies its digest and decrypts it when needed.
func (e *Engine) fetch(ctx context.Context, fileID, hash string) ([]byte, error) {
	var buf bytes.Buffer
	if err := e.cfg.Remote.Download(ctx, hash, &buf); err != nil {
		return nil, err
	}
	sum := sha256.Sum256(buf.Bytes())
	if hex.EncodeToString(sum[:]) != hash {
		return nil, fmt.Errorf("blob %s: content does not match its digest", hash)
	}
	if e.cfg.Cipher == nil {
		return buf.Bytes(), nil
	}
	return e.cfg.Cipher.DecryptBlob(fileID, buf.Bytes())
}

// fetchRevision returns the content of an old revision (the base of a merge).
func (e *Engine) fetchRevision(ctx context.Context, fileID string, rev int) ([]byte, error) {
	var buf bytes.Buffer
	if err := e.cfg.Remote.RevisionContent(ctx, fileID, rev, &buf); err != nil {
		return nil, err
	}
	if e.cfg.Cipher == nil {
		return buf.Bytes(), nil
	}
	return e.cfg.Cipher.DecryptBlob(fileID, buf.Bytes())
}

func (e *Engine) diskExists(path string) bool {
	abs, _, err := e.cfg.FS.Resolve(path)
	if err != nil {
		return false
	}
	_, err = os.Lstat(abs)
	return err == nil
}

// pathTaken reports whether a local path is in use, on disk or in sync_files.
func (e *Engine) pathTaken(ctx context.Context, path string) bool {
	if e.diskExists(path) {
		return true
	}
	_, ok, _ := e.cfg.DB.GetFile(ctx, path)
	return ok
}

// makeRoom frees path for an incoming remote file: whatever local file sits
// there is renamed to "name (1).ext" and stays a local file to be uploaded
// (create versus create, §3.4.5).
func (e *Engine) makeRoom(ctx context.Context, path string) error {
	row, hasRow, err := e.cfg.DB.GetFile(ctx, path)
	if err != nil {
		return err
	}
	if !hasRow && !e.diskExists(path) {
		return nil
	}
	np := uniquePath(path, func(p string) bool { return e.pathTaken(ctx, p) })
	if e.diskExists(path) {
		if err := e.cfg.FS.Rename(path, np); err != nil {
			return err
		}
	}
	if hasRow {
		switch row.State {
		case StateSynced:
			row.State, row.MovedFrom = StateLocalMoved, path
		case StateLocalNew:
			row.MovedFrom = ""
		}
		row.Path = np
		return e.cfg.DB.PutFile(ctx, row)
	}
	return nil
}

// refreshRow re-reads one file's state after the disk turned out to differ
// from what sync_files says.
func (e *Engine) refreshRow(ctx context.Context, row File) (File, error) {
	h, size, err := e.cfg.FS.HashFile(row.Path)
	switch {
	case os.IsNotExist(err):
		if row.State == StateLocalNew {
			return row, nil
		}
		row.State = StateLocalDeleted
	case err != nil:
		return row, err
	default:
		if h != row.LocalHash {
			row.LocalHash, row.LocalSize = h, size
			switch row.State {
			case StateSynced:
				row.State = StateLocalModify
			case StateLocalMoved:
				row.Dirty = true
			}
		}
	}
	return row, e.cfg.DB.PutFile(ctx, row)
}

// pull applies the server changelog since the cursor (§3.4.4 B). Changes that
// hit locally modified files are parked as candidates and resolved afterwards.
func (e *Engine) pull(ctx context.Context) (applied bool, err error) {
	if boot, err := e.cfg.DB.Meta(ctx, MetaBootstrapped); err != nil {
		return false, err
	} else if boot != "1" {
		if err := e.bootstrap(ctx); err != nil {
			return false, err
		}
		applied = true
	}
	for {
		cur, err := e.cfg.DB.Cursor(ctx)
		if err != nil {
			return applied, err
		}
		ch, err := e.cfg.Remote.Changes(ctx, cur, 500)
		if transport.IsCode(err, syncproto.CodeCursorExpired) {
			if err := e.bootstrap(ctx); err != nil {
				return applied, err
			}
			applied = true
			continue
		}
		if err != nil {
			return applied, err
		}
		for i, c := range ch.Items {
			if err := ctx.Err(); err != nil {
				return applied, err
			}
			did, err := e.applyChange(ctx, c)
			if err != nil {
				return applied, fmt.Errorf("change %d (%s %s): %w", c.Seq, c.Op, c.FileID, err)
			}
			applied = applied || did
			e.progress(i+1, len(ch.Items))
		}
		if ch.NextSeq > cur {
			if err := e.cfg.DB.SetCursor(ctx, ch.NextSeq, false); err != nil {
				return applied, err
			}
		}
		if !ch.HasMore {
			return applied, nil
		}
	}
}

// applyChange applies one remote change; it reports whether it changed anything.
func (e *Engine) applyChange(ctx context.Context, c transport.Change) (bool, error) {
	row, has, err := e.cfg.DB.GetFileByID(ctx, c.FileID)
	if err != nil {
		return false, err
	}
	if has && row.ServerRev >= c.Rev {
		return false, nil // already applied (our own echo, or a replay)
	}
	path, err := e.clearPath(c.Path)
	if err != nil {
		e.log.Error().Err(err).Str("file_id", c.FileID).Msg("cannot decrypt a path: change skipped")
		return false, nil
	}
	switch c.Op {
	case "delete":
		return e.applyDelete(ctx, row, has, c)
	case "move":
		return e.applyMove(ctx, row, has, c, path)
	default:
		if !has {
			return true, e.createFromRemote(ctx, c, path)
		}
		if row.State == StateSynced {
			return e.overwriteFromRemote(ctx, row, c)
		}
		e.candidates[c.FileID] = c
		return false, nil
	}
}

func (e *Engine) createFromRemote(ctx context.Context, c transport.Change, path string) error {
	data, err := e.fetch(ctx, c.FileID, c.BlobHash)
	if err != nil {
		return err
	}
	if err := e.makeRoom(ctx, path); err != nil {
		return err
	}
	cont, err := e.cfg.FS.WriteFile(path, data, "", true)
	if err != nil {
		return err
	}
	return e.cfg.DB.PutFile(ctx, File{
		Path: path, FileID: c.FileID, ServerRev: c.Rev, BaseRev: c.Rev, ServerHash: c.BlobHash, LocalHash: cont.Hash,
		LocalSize: cont.Size, LocalMtime: cont.Mtime.UnixNano(), State: StateSynced,
	})
}

func (e *Engine) overwriteFromRemote(ctx context.Context, row File, c transport.Change) (bool, error) {
	data, err := e.fetch(ctx, c.FileID, c.BlobHash)
	if err != nil {
		return false, err
	}
	cont, err := e.cfg.FS.WriteFile(row.Path, data, row.LocalHash, false)
	if errors.Is(err, vault.ErrHashMismatch) {
		// Edited on disk since the last scan: it is a conflict candidate after all.
		if row, err = e.refreshRow(ctx, row); err != nil {
			return false, err
		}
		e.candidates[c.FileID] = c
		return false, nil
	}
	if err != nil {
		return false, err
	}
	row.ServerRev, row.BaseRev, row.ServerHash, row.LocalHash = c.Rev, c.Rev, c.BlobHash, cont.Hash
	row.LocalSize, row.LocalMtime = cont.Size, cont.Mtime.UnixNano()
	row.State, row.Attempts, row.LastError = StateSynced, 0, ""
	return true, e.cfg.DB.PutFile(ctx, row)
}

func (e *Engine) applyMove(ctx context.Context, row File, has bool, c transport.Change, newPath string) (bool, error) {
	if !has {
		return true, e.createFromRemote(ctx, c, newPath)
	}
	if row.Path == newPath {
		row.ServerRev = c.Rev
		if row.State == StateSynced {
			row.BaseRev = c.Rev
		}
		return true, e.cfg.DB.PutFile(ctx, row)
	}
	switch row.State {
	case StateSynced, StateLocalModify, StateLocalMoved, StateConflict:
		// Rename versus modify: both apply. Rename versus rename: the first
		// commit (the server's) wins and the local move is dropped.
		if e.diskExists(row.Path) {
			if err := e.makeRoom(ctx, newPath); err != nil {
				return false, err
			}
			if err := e.cfg.FS.Rename(row.Path, newPath); err != nil {
				return false, err
			}
		}
		row.Path, row.ServerRev, row.MovedFrom = newPath, c.Rev, ""
		if row.State == StateLocalMoved {
			if row.Dirty {
				row.State = StateLocalModify
			} else {
				row.State = StateSynced
			}
			row.Dirty = false
		}
		if st, err := os.Stat(e.absPath(row.Path)); err == nil {
			row.LocalMtime = st.ModTime().UnixNano()
		}
		if row.State == StateSynced {
			row.BaseRev = c.Rev // a move leaves the content as the server has it
		}
		return true, e.cfg.DB.PutFile(ctx, row)
	case StateLocalDeleted:
		// We deleted it; the deletion wins over a pure rename.
		row.Path, row.ServerRev = newPath, c.Rev
		return true, e.cfg.DB.PutFile(ctx, row)
	default:
		return false, nil
	}
}

func (e *Engine) absPath(rel string) string {
	abs, _, err := e.cfg.FS.Resolve(rel)
	if err != nil {
		return ""
	}
	return abs
}

func (e *Engine) applyDelete(ctx context.Context, row File, has bool, c transport.Change) (bool, error) {
	if !has {
		return false, nil
	}
	switch row.State {
	case StateSynced:
		if e.diskExists(row.Path) {
			if _, err := e.cfg.FS.Trash(row.Path); err != nil {
				return false, err
			}
		}
		return true, e.cfg.DB.DeleteFile(ctx, row.FileID)
	case StateLocalDeleted:
		return true, e.cfg.DB.DeleteFile(ctx, row.FileID)
	default:
		// Deleted remotely, modified here: the modification wins and the file
		// is brought back by our next push (§3.4.5).
		row.ServerRev, row.Tombstoned = c.Rev, true
		if row.State == StateLocalMoved && !row.Dirty {
			row.State = StateLocalModify
		}
		return true, e.cfg.DB.PutFile(ctx, row)
	}
}

// bootstrap reconciles with the full manifest: first link of an existing
// vault, or a cursor older than the changelog window (§3.4.4 B).
func (e *Engine) bootstrap(ctx context.Context) error {
	tree, err := e.cfg.Remote.Tree(ctx)
	if err != nil {
		return err
	}
	rows, err := e.cfg.DB.Files(ctx)
	if err != nil {
		return err
	}
	byID := make(map[string]File, len(rows))
	byPath := make(map[string]File, len(rows))
	for _, r := range rows {
		byID[r.FileID] = r
		byPath[r.Path] = r
	}
	type remoteFile struct {
		transport.TreeEntry
		path string
	}
	remote := make([]remoteFile, 0, len(tree.Items))
	known := make(map[string]bool, len(tree.Items))
	for _, it := range tree.Items {
		p, err := e.clearPath(it.Path)
		if err != nil {
			e.log.Error().Err(err).Str("file_id", it.FileID).Msg("cannot decrypt a path: file skipped")
			continue
		}
		remote = append(remote, remoteFile{it, p})
		known[it.FileID] = true
	}
	sort.Slice(remote, func(i, j int) bool { return remote[i].path < remote[j].path })

	e.progress(0, len(remote))
	for i, rf := range remote {
		if err := ctx.Err(); err != nil {
			return err
		}
		e.progress(i+1, len(remote))
		synthetic := transport.Change{FileID: rf.FileID, Op: "modify", Path: rf.Path, Rev: rf.Rev, BlobHash: rf.Hash, Size: rf.Size}
		if row, ok := byID[rf.FileID]; ok {
			if row.ServerRev >= rf.Rev {
				continue
			}
			if row.Path != rf.path {
				mv := synthetic
				mv.Op = "move"
				if _, err := e.applyMoveClear(ctx, row, mv, rf.path); err != nil {
					return err
				}
				row, _, _ = e.cfg.DB.GetFileByID(ctx, rf.FileID)
			}
			if row.ServerHash != rf.Hash || row.ServerRev < rf.Rev {
				if err := e.applyContentClear(ctx, row, true, synthetic, rf.path); err != nil {
					return err
				}
			}
			continue
		}
		// Unknown to us. A local file at the same path with the same content is
		// the same file (the vault was copied here): adopt it instead of copying.
		if local, ok := byPath[rf.path]; ok && local.State == StateLocalNew && local.ServerRev == 0 {
			same := false
			if e.cfg.Cipher == nil {
				same = local.LocalHash == rf.Hash
			} else if data, err := e.fetch(ctx, rf.FileID, rf.Hash); err == nil {
				same = hashHex(data) == local.LocalHash
			}
			if same {
				if err := e.cfg.DB.DeleteFile(ctx, local.FileID); err != nil {
					return err
				}
				local.FileID, local.ServerRev, local.BaseRev, local.ServerHash, local.State = rf.FileID, rf.Rev, rf.Rev, rf.Hash, StateSynced
				if err := e.cfg.DB.PutFile(ctx, local); err != nil {
					return err
				}
				continue
			}
		}
		if err := e.applyContentClear(ctx, File{}, false, synthetic, rf.path); err != nil {
			return err
		}
	}
	// Files we know that the server no longer has were deleted there.
	for _, r := range rows {
		if r.ServerRev > 0 && !known[r.FileID] {
			cur, ok, _ := e.cfg.DB.GetFileByID(ctx, r.FileID)
			if !ok {
				continue
			}
			if _, err := e.applyDelete(ctx, cur, true, transport.Change{FileID: r.FileID, Op: "delete", Rev: r.ServerRev + 1}); err != nil {
				return err
			}
		}
	}
	if err := e.cfg.DB.SetCursor(ctx, tree.AsOfSeq, true); err != nil {
		return err
	}
	return e.cfg.DB.SetMeta(ctx, MetaBootstrapped, "1")
}

// applyMoveClear and applyContentClear are the entry points used by bootstrap
// with paths that are already in clear text.
func (e *Engine) applyMoveClear(ctx context.Context, row File, c transport.Change, path string) (bool, error) {
	return e.applyMove(ctx, row, true, c, path)
}

func (e *Engine) applyContentClear(ctx context.Context, row File, has bool, c transport.Change, path string) error {
	if !has {
		return e.createFromRemote(ctx, c, path)
	}
	if row.State == StateSynced {
		_, err := e.overwriteFromRemote(ctx, row, c)
		return err
	}
	e.candidates[c.FileID] = c
	return nil
}

var _ = strings.TrimSpace
