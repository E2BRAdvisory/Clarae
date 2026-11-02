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
	"memobrain/shared/vaultcrypto"
)

type transportChange = transport.Change

// ErrPathDowngrade means the server sent an enc1 path token for a file this
// device has already seen with an enc2 token, or for a vault whose tokens are
// all enc2 (the strong pin, ADR-0042): enc1 is not bound to the file, so it
// may be the token of another file of the vault.
var ErrPathDowngrade = errors.New("the server path of this file is in an older format than this device has already seen")

// Path-token pins in sync.db (ADR-0042), trust on first use like the
// envelope pins of ADR-0034:
//   - metaPathV2 marks a cloud vault whose tokens this device has seen (or
//     written) in format enc2: new tokens stay enc2 even with
//     features.path_v2 off, so a vault never goes back to enc1;
//   - metaPathV2File marks one file: from then on an enc1 token for it is
//     refused (ErrPathDowngrade). Files never seen in enc2 keep accepting
//     enc1, which they legitimately use until they are moved;
//   - metaPathV2Strong marks a cloud vault whose complete tree had no enc1
//     token left (release N+1, after the migration of pathmigrate.go): from
//     then on every enc1 token of the vault is refused.
func metaPathV2(cloudID string) string { return "path_v2:" + cloudID }

func metaPathV2File(fileID string) string { return "path_v2_file:" + fileID }

func metaPathV2Strong(cloudID string) string { return "path_v2_strong:" + cloudID }

// clearPath turns the server path of a file into the local one (decrypting
// the token in private vaults, see the pins above).
func (e *Engine) clearPath(ctx context.Context, fileID, serverPath string) (string, error) {
	if e.cfg.Cipher == nil {
		return serverPath, nil
	}
	v := vaultcrypto.PathTokenVersion(serverPath)
	if v == 1 {
		if e.loadPathPins(ctx); e.pathStrong {
			return "", ErrPathDowngrade
		}
		if pinned, _ := e.cfg.DB.Meta(ctx, metaPathV2File(fileID)); pinned == "1" {
			return "", ErrPathDowngrade
		}
	}
	p, err := e.cfg.Cipher.DecryptFilePath(fileID, serverPath)
	if err == nil && v == 2 {
		e.pinPathV2(ctx, fileID)
	}
	return p, err
}

// pinPathV2 records that the file (and so the vault) has an enc2 token on
// the server. Best effort: a pin that cannot be saved only weakens the
// downgrade check, it never blocks the sync.
func (e *Engine) pinPathV2(ctx context.Context, fileID string) {
	if v, _ := e.cfg.DB.Meta(ctx, metaPathV2File(fileID)); v != "1" {
		if err := e.cfg.DB.SetMeta(ctx, metaPathV2File(fileID), "1"); err != nil {
			e.log.Warn().Err(err).Str("file_id", fileID).Msg("sync: pin path token format")
		}
	}
	if e.loadPathPins(ctx); e.pathV2Pinned {
		return
	}
	cloud, _ := e.cfg.DB.Meta(ctx, MetaCloudVault)
	if cloud == "" {
		return
	}
	if err := e.cfg.DB.SetMeta(ctx, metaPathV2(cloud), "1"); err != nil {
		e.log.Warn().Err(err).Msg("sync: pin path token format")
		return
	}
	e.pathV2Pinned = true
}

// loadPathPins reads the vault pins of the linked cloud vault from sync.db
// once (pathPinLoaded, under e.run).
func (e *Engine) loadPathPins(ctx context.Context) {
	if e.pathPinLoaded {
		return
	}
	if cloud, _ := e.cfg.DB.Meta(ctx, MetaCloudVault); cloud != "" {
		v, _ := e.cfg.DB.Meta(ctx, metaPathV2(cloud))
		strong, _ := e.cfg.DB.Meta(ctx, metaPathV2Strong(cloud))
		e.pathStrong = strong == "1"
		e.pathV2Pinned = v == "1" || e.pathStrong
	}
	e.pathPinLoaded = true
}

// writePathV2 decides the format of a new path token: enc2 when
// features.path_v2 is on or the vault is pinned to enc2 (never downgrade),
// enc1 otherwise, which every client can read.
func (e *Engine) writePathV2(ctx context.Context) bool {
	if e.cfg.Cipher.PathV2() {
		return true
	}
	e.loadPathPins(ctx)
	return e.pathV2Pinned
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
	data, err := e.cfg.Cipher.DecryptBlob(fileID, buf.Bytes())
	return data, e.lockedErr(err)
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
	data, err := e.cfg.Cipher.DecryptBlob(fileID, buf.Bytes())
	return data, e.lockedErr(err)
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
		for i := 0; i < len(ch.Items); {
			if err := ctx.Err(); err != nil {
				return applied, err
			}
			// A folder renamed elsewhere: one directory rename (folders.go).
			n, err := e.applyFolderMove(ctx, ch.Items[i:])
			if err != nil {
				return applied, fmt.Errorf("folder move at change %d: %w", ch.Items[i].Seq, err)
			}
			if n > 0 {
				i += n
				applied = true
				e.progress(i, len(ch.Items))
				continue
			}
			c := ch.Items[i]
			did, err := e.applyChange(ctx, c)
			if err != nil {
				return applied, fmt.Errorf("change %d (%s %s): %w", c.Seq, c.Op, c.FileID, err)
			}
			applied = applied || did
			i++
			e.progress(i, len(ch.Items))
		}
		// The parked candidates of this page are saved with the cursor that
		// moves past them: the server never sends them again (§3.4.4 B).
		var saved func()
		err = e.cfg.DB.WithTx(ctx, func(tx *DB) error {
			var err error
			if saved, err = e.saveCandidates(ctx, tx); err != nil {
				return err
			}
			if ch.NextSeq > cur {
				return tx.SetCursor(ctx, ch.NextSeq, false)
			}
			return nil
		})
		if err != nil {
			return applied, err
		}
		saved()
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
	if c.Op == "delete" {
		return e.applyDelete(ctx, row, has, c) // needs no path
	}
	path, err := e.clearPath(ctx, c.FileID, c.Path)
	if err != nil {
		if e.isLocked(err) {
			// The key went away during the cycle: stop here, before the cursor
			// moves past a change that was not applied.
			return false, e.lockedErr(err)
		}
		return false, e.quarantine(ctx, c.FileID, c.Rev, row, has, err)
	}
	switch c.Op {
	case "move":
		return e.applyMove(ctx, row, has, c, path)
	default:
		if !has {
			return true, e.createFromRemote(ctx, c, path)
		}
		if row.State == StateSynced {
			if row.Path == path && c.BlobHash != "" && c.BlobHash == row.ServerHash {
				// The very blob this device holds: only the revision changes
				// (e.g. the files of a mount whose share root was renamed,
				// which "enter" the share again, §3.4.7).
				row.ServerRev, row.BaseRev = c.Rev, c.Rev
				return true, e.cfg.DB.PutFile(ctx, row)
			}
			if row.Path != path {
				// A modification that also carries a new path (a move we
				// missed): move first, then take the content.
				if row, err = e.relocate(ctx, row, path); err != nil {
					return false, err
				}
			}
			return e.overwriteFromRemote(ctx, row, c)
		}
		e.addCandidate(c)
		return false, nil
	}
}

// quarantine records a server entry whose path cannot be decrypted with the
// vault key (corrupt or foreign token). It is neither applied nor taken for a
// deletion; the local file, if any, is left alone and shows the reason.
func (e *Engine) quarantine(ctx context.Context, fileID string, rev int, row File, has bool, cause error) error {
	e.log.Error().Err(cause).Str("file_id", fileID).Int("rev", rev).Msg("cannot decrypt a server path: change quarantined")
	if err := e.cfg.DB.Quarantine(ctx, fileID, rev, "cannot decrypt the server path: "+cause.Error(), e.cfg.Now()); err != nil {
		return err
	}
	if has {
		row.LastError = "the server version of this file cannot be decrypted"
		return e.cfg.DB.PutFile(ctx, row)
	}
	return nil
}

// relocate moves a local file to the path the server has for it, keeping its
// revisions (the content is applied separately, and a failure there must find
// the change still to apply).
func (e *Engine) relocate(ctx context.Context, row File, newPath string) (File, error) {
	if row.Path == newPath {
		return row, nil
	}
	if err := e.makeRoom(ctx, newPath); err != nil {
		return row, err
	}
	if e.diskExists(row.Path) {
		if err := e.cfg.FS.Rename(row.Path, newPath); err != nil {
			return row, err
		}
	}
	row.Path = newPath
	if st, err := os.Stat(e.absPath(newPath)); err == nil {
		row.LocalMtime = st.ModTime().UnixNano()
	}
	return row, e.cfg.DB.PutFile(ctx, row)
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
		if _, err = e.refreshRow(ctx, row); err != nil {
			return false, err
		}
		e.addCandidate(c)
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
		if row.State == StateLocalMoved {
			// The server has the file where it is here: our own move (a
			// move_prefix, or a move whose answer was lost) or the same move
			// made elsewhere. Nothing is left to send for the path.
			settleMoved(&row)
			row.Attempts, row.LastError = 0, ""
		}
		if row.State == StateSynced {
			row.BaseRev = c.Rev
		}
		return true, e.cfg.DB.PutFile(ctx, row)
	}
	switch row.State {
	case StateSynced, StateLocalModify, StateLocalMoved, StateConflict:
		// Rename versus modify: both apply. Rename versus rename: the first
		// commit (the server's) wins and the local move is dropped.
		if err := e.makeRoom(ctx, newPath); err != nil {
			return false, err
		}
		if e.diskExists(row.Path) {
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
		// We deleted it; the deletion wins over a pure rename. The delete we
		// send needs no path: the row only follows the server's when that path
		// is free (a local file may have taken it meanwhile).
		row.ServerRev = c.Rev
		if !e.pathTaken(ctx, newPath) {
			row.Path = newPath
		}
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
		// Listed by the server: never a deletion, even when unreadable.
		known[it.FileID] = true
		p, err := e.clearPath(ctx, it.FileID, it.Path)
		if err != nil {
			if e.isLocked(err) {
				return e.lockedErr(err)
			}
			row, has := byID[it.FileID]
			if err := e.quarantine(ctx, it.FileID, it.Rev, row, has, err); err != nil {
				return err
			}
			continue
		}
		remote = append(remote, remoteFile{it, p})
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
			// The revision alone is not enough: a move applied by an earlier,
			// interrupted bootstrap already raised it without the content.
			if row.ServerRev >= rf.Rev && row.ServerHash == rf.Hash && row.Path == rf.path {
				continue
			}
			if row.Path != rf.path {
				if row.State == StateSynced && row.ServerHash != rf.Hash {
					// Moved and modified: move without claiming the new revision,
					// which only the content applied below may do.
					if _, err := e.relocate(ctx, row, rf.path); err != nil {
						return err
					}
				} else {
					mv := synthetic
					mv.Op = "move"
					if _, err := e.applyMoveClear(ctx, row, mv, rf.path); err != nil {
						return err
					}
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
				oldID := local.FileID
				local.FileID, local.ServerRev, local.BaseRev, local.ServerHash, local.State = rf.FileID, rf.Rev, rf.Rev, rf.Hash, StateSynced
				if err := e.cfg.DB.WithTx(ctx, func(tx *DB) error {
					if err := tx.DeleteFile(ctx, oldID); err != nil {
						return err
					}
					return tx.PutFile(ctx, local)
				}); err != nil {
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
	var saved func()
	if err := e.cfg.DB.WithTx(ctx, func(tx *DB) error {
		var err error
		if saved, err = e.saveCandidates(ctx, tx); err != nil {
			return err
		}
		if err := tx.SetCursor(ctx, tree.AsOfSeq, true); err != nil {
			return err
		}
		return tx.SetMeta(ctx, MetaBootstrapped, "1")
	}); err != nil {
		return err
	}
	saved()
	return nil
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
	e.addCandidate(c)
	return nil
}

var _ = strings.TrimSpace
