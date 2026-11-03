package sync

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"math"
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
// size is the blob size the changelog or the tree announced (0 = unknown): a
// download that goes past it fails before it is all in memory. A blob the
// loop of ctx downloaded ahead (startPrefetch) is taken from there.
func (e *Engine) fetch(ctx context.Context, fileID, hash string, size int64) ([]byte, error) {
	blob, ok, err := prefetched(ctx, fileID, hash)
	if !ok {
		blob, err = e.download(ctx, hash, size)
	}
	if err != nil {
		return nil, err
	}
	if e.cfg.Cipher == nil {
		return blob, nil
	}
	data, err := e.cfg.Cipher.DecryptBlob(fileID, blob)
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
		mode := bootstrapAuthoritative
		if boot == bootstrapReconcilePending {
			mode = bootstrapReconcileUpload // an interrupted one, resumed as such
		}
		if err := e.bootstrap(ctx, mode); err != nil {
			return false, err
		}
		applied = true
	}
	for {
		cur, err := e.cfg.DB.Cursor(ctx)
		if err != nil {
			return applied, err
		}
		curID, err := e.cfg.DB.CursorID(ctx)
		if err != nil {
			return applied, err
		}
		// The id of the change at the cursor goes with it: a seq the server handed
		// out again after a restore of its database is answered like a cursor
		// beyond its end (ADR-0046).
		ch, err := e.cfg.Remote.Changes(ctx, cur, curID, 500)
		if transport.IsCode(err, syncproto.CodeCursorExpired) {
			mode := bootstrapAuthoritative
			if transport.ServerBehind(err) {
				// The server went back in time (a restored backup): what it lost
				// is republished from here, never destroyed (ADR-0046).
				e.log.Warn().Int64("cursor", cur).Msg("sync: the server is behind this device, republishing what it lost")
				mode = bootstrapReconcileUpload
			}
			if err := e.bootstrap(ctx, mode); err != nil {
				return applied, err
			}
			applied = true
			continue
		}
		if err != nil {
			return applied, err
		}
		did, err := e.applyPage(ctx, ch.Items)
		applied = applied || did
		if err != nil {
			return applied, err
		}
		// The parked candidates of this page are saved with the cursor that
		// moves past them: the server never sends them again (§3.4.4 B).
		var saved func()
		err = e.cfg.DB.WithTx(ctx, func(tx *DB) error {
			var err error
			if saved, err = e.saveCandidates(ctx, tx); err != nil {
				return err
			}
			// The same position fills in an id this cursor did not have yet (one
			// saved before ADR-0046): from then on the server verifies it.
			if ch.NextSeq > cur || (ch.NextSeq == cur && curID == "" && ch.NextID != "") {
				return tx.SetCursor(ctx, ch.NextSeq, ch.NextID, false)
			}
			return nil
		})
		if err != nil {
			return applied, err
		}
		saved()
		if !ch.HasMore {
			retried, err := e.retryQuarantine(ctx)
			return applied || retried, err
		}
	}
}

// applyPage applies a page of the changelog in its order, the blobs it needs
// downloaded ahead (startPrefetch). It reports whether it changed anything.
func (e *Engine) applyPage(ctx context.Context, items []transport.Change) (applied bool, err error) {
	wants, err := e.pageWants(ctx, items)
	if err != nil {
		return false, err
	}
	ctx, stop := e.startPrefetch(ctx, wants)
	defer stop()
	for i := 0; i < len(items); {
		if err := ctx.Err(); err != nil {
			return applied, err
		}
		advancePrefetch(ctx, i)
		// A folder renamed elsewhere: one directory rename (folders.go).
		n, err := e.applyFolderMove(ctx, items[i:])
		if err != nil {
			return applied, fmt.Errorf("folder move at change %d: %w", items[i].Seq, err)
		}
		if n > 0 {
			i += n
			applied = true
			e.progress(i, len(items))
			continue
		}
		c := items[i]
		did, err := e.applyChange(ctx, c)
		if err != nil {
			return applied, fmt.Errorf("change %d (%s %s): %w", c.Seq, c.Op, c.FileID, err)
		}
		applied = applied || did
		i++
		e.progress(i, len(items))
	}
	return applied, nil
}

// pageWants guesses, from sync_files as it is before the page is applied,
// which changes of a page applyChange will download the blob of: a file
// this device does not have, or a new content of a synced one. A wrong guess
// costs a download for nothing or one made in turn, never a wrong result.
func (e *Engine) pageWants(ctx context.Context, items []transport.Change) ([]blobWant, error) {
	if e.transfers() <= 1 {
		return nil, nil
	}
	var wants []blobWant
	for i, c := range items {
		if c.Op == "delete" || c.BlobHash == "" {
			continue
		}
		row, has, err := e.cfg.DB.GetFileByID(ctx, c.FileID)
		if err != nil {
			return nil, err
		}
		if has && (row.ServerRev >= c.Rev || c.Op == "move" || row.State != StateSynced || row.ServerHash == c.BlobHash) {
			continue // applied already, a rename, a conflict candidate or the content this device has
		}
		wants = append(wants, blobWant{pos: i, fileID: c.FileID, hash: c.BlobHash, size: c.Size})
	}
	return wants, nil
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
		if row, err = e.liftQuarantine(ctx, row, has, c.FileID, c.Rev); err != nil {
			return false, err
		}
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
	// A readable revision supersedes a quarantined older one. Lifted before it
	// is applied: should that fail, the cursor stays and the change comes again.
	if row, err = e.liftQuarantine(ctx, row, has, c.FileID, c.Rev); err != nil {
		return false, err
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
			return e.overwriteFromRemote(ctx, row, c, false)
		}
		e.addCandidate(c)
		return false, nil
	}
}

// quarantinedError is File.LastError of a file whose latest server entry is
// in quarantine.
const quarantinedError = "the server version of this file cannot be decrypted"

// quarantine records a server entry whose path cannot be decrypted with the
// vault key (corrupt or foreign token). It is neither applied nor taken for a
// deletion; the local file, if any, is left alone and shows the reason. The
// entry is lifted when a newer revision of the file is applied, retried once
// per run of the engine (retryQuarantine) and by every bootstrap.
func (e *Engine) quarantine(ctx context.Context, fileID string, rev int, row File, has bool, cause error) error {
	e.log.Error().Err(cause).Str("file_id", fileID).Int("rev", rev).Msg("cannot decrypt a server path: change quarantined")
	if err := e.cfg.DB.Quarantine(ctx, fileID, rev, "cannot decrypt the server path: "+cause.Error(), e.cfg.Now()); err != nil {
		return err
	}
	if has {
		row.LastError = quarantinedError
		return e.cfg.DB.PutFile(ctx, row)
	}
	return nil
}

// liftQuarantine forgets the quarantine of a file once its revision rev (at
// least as new as the quarantined one) is being applied, and the error it
// left on the file's row. It returns the row as saved.
func (e *Engine) liftQuarantine(ctx context.Context, row File, has bool, fileID string, rev int) (File, error) {
	if e.cfg.Cipher == nil {
		return row, nil // only an encrypted path can be unreadable
	}
	lifted, err := e.cfg.DB.DeleteQuarantine(ctx, fileID, rev)
	if err != nil || !lifted || !has || row.LastError != quarantinedError {
		return row, err
	}
	row.LastError = ""
	return row, e.cfg.DB.PutFile(ctx, row)
}

// liftApplied is liftQuarantine for a file whose row the caller does not
// hold (it was just written by the code that applied the revision).
func (e *Engine) liftApplied(ctx context.Context, fileID string, rev int) error {
	row, has, err := e.cfg.DB.GetFileByID(ctx, fileID)
	if err != nil {
		return err
	}
	_, err = e.liftQuarantine(ctx, row, has, fileID, rev)
	return err
}

// retryQuarantine reads the quarantined entries again from the manifest, once
// per run of the engine (a newer version of the application may read what an
// older one could not): the readable ones are applied like in a bootstrap,
// the ones the server no longer lists are forgotten. It reports whether it
// changed anything.
func (e *Engine) retryQuarantine(ctx context.Context) (bool, error) {
	if e.quarantineChecked || e.cfg.Cipher == nil {
		return false, nil
	}
	qs, err := e.cfg.DB.Quarantined(ctx)
	if err != nil || len(qs) == 0 {
		e.quarantineChecked = err == nil
		return false, err
	}
	tree, err := e.cfg.Remote.Tree(ctx)
	if err != nil {
		if ctx.Err() != nil || isNetwork(err) {
			return false, err // offline: the next cycle tries again
		}
		// Never a reason to stop synchronizing: the next run tries again.
		e.log.Warn().Err(err).Msg("sync: cannot read the manifest to retry the quarantined entries")
		e.quarantineChecked = true
		return false, nil
	}
	rows, err := e.cfg.DB.Files(ctx)
	if err != nil {
		return false, err
	}
	byID := make(map[string]File, len(rows))
	byPath := make(map[string]File, len(rows))
	for _, r := range rows {
		byID[r.FileID] = r
		byPath[r.Path] = r
	}
	listed := make(map[string]transport.TreeEntry, len(tree.Items))
	for _, it := range tree.Items {
		listed[it.FileID] = it
	}
	did := false
	for _, q := range qs {
		// Read again: applying an earlier entry may have moved this file aside.
		row, has, err := e.cfg.DB.GetFileByID(ctx, q.FileID)
		if err != nil {
			return did, err
		}
		if has {
			byID[q.FileID] = row
		}
		it, ok := listed[q.FileID]
		if !ok {
			// Gone from the server (its deletion is in the changelog): there
			// is nothing left to read.
			if _, err := e.liftQuarantine(ctx, row, has, q.FileID, q.Rev); err != nil {
				return did, err
			}
			continue
		}
		p, err := e.clearPath(ctx, it.FileID, it.Path)
		if err != nil {
			if e.isLocked(err) {
				return did, e.lockedErr(err)
			}
			if err := e.quarantine(ctx, it.FileID, it.Rev, row, has, err); err != nil {
				return did, err
			}
			continue
		}
		// Lifted only once applied: a failure leaves it for the next try.
		if err := e.reconcileEntry(ctx, bootstrapAuthoritative, remoteFile{it, p}, byID, byPath); err != nil {
			if ctx.Err() != nil || e.isLocked(err) || isNetwork(err) {
				return did, e.lockedErr(err)
			}
			// E.g. a content that cannot be decrypted either: it stays in
			// quarantine and the others go on.
			e.log.Warn().Err(err).Str("file_id", q.FileID).Msg("sync: a quarantined entry still cannot be applied")
			continue
		}
		if err := e.liftApplied(ctx, q.FileID, max(q.Rev, it.Rev)); err != nil {
			return did, err
		}
		did = true
	}
	saved, err := e.saveCandidates(ctx, e.cfg.DB)
	if err != nil {
		return did, err
	}
	saved()
	e.quarantineChecked = true
	return did, nil
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
	data, err := e.fetch(ctx, c.FileID, c.BlobHash, c.Size)
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

// overwriteFromRemote replaces a synced file with a remote revision. snapshot
// asks to keep the local content in the history first (BeforeOverwrite): a
// bootstrap cannot be sure the server still has it (ADR-0046).
func (e *Engine) overwriteFromRemote(ctx context.Context, row File, c transport.Change, snapshot bool) (bool, error) {
	data, err := e.fetch(ctx, c.FileID, c.BlobHash, c.Size)
	if err != nil {
		return false, err
	}
	if snapshot && e.cfg.BeforeOverwrite != nil && hashHex(data) != row.LocalHash {
		e.cfg.BeforeOverwrite(row.Path)
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

// contentParked reports whether a remote change of fileID older than rev is
// parked as a candidate. A move that settles the row (a local move made
// elsewhere too, or one the server's overrides) must then leave BaseRev where
// it is: moving it to the move's revision would make resolveCandidates take
// the parked content change for applied, and this device would keep its old
// content.
func (e *Engine) contentParked(fileID string, rev int) bool {
	c, ok := e.candidates[fileID]
	return ok && c.Rev < rev
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
		if row.State == StateSynced && !e.contentParked(row.FileID, c.Rev) {
			row.BaseRev = c.Rev
		}
		return true, e.cfg.DB.PutFile(ctx, row)
	}
	if row.State == StateLocalMoved && newPath == row.MovedFrom {
		// The server still has the file where our move takes it from: a move
		// that only rewrote its path token (the enc1 -> enc2 migration of
		// another device, ADR-0042), or a move there and back. It is no rename
		// to apply: ours is still to send, on the new revision. BaseRev stays:
		// a content change parked before this move must still be resolved.
		row.ServerRev = c.Rev
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
		if row.State == StateSynced && !e.contentParked(row.FileID, c.Rev) {
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
			// The file may have been edited since the scan (the pull of a round
			// can take long): only the content the server deleted goes to the
			// trash, an edit wins over the deletion like any other (§3.4.5).
			h, size, err := e.hashFile(row.Path)
			switch {
			case err == nil && h != row.LocalHash:
				row.LocalHash, row.LocalSize, row.State = h, size, StateLocalModify
				if st, err := os.Stat(e.absPath(row.Path)); err == nil {
					row.LocalMtime = st.ModTime().UnixNano()
				}
				return true, e.tombstone(ctx, row, c.Rev)
			case err == nil:
				if _, err := e.cfg.FS.Trash(row.Path); err != nil && !os.IsNotExist(err) {
					return false, err
				}
			case !os.IsNotExist(err):
				return false, err
			}
		}
		return true, e.cfg.DB.DeleteFile(ctx, row.FileID)
	case StateLocalDeleted:
		return true, e.cfg.DB.DeleteFile(ctx, row.FileID)
	default:
		// Deleted remotely, modified here: the modification wins and the file
		// is brought back by our next push (§3.4.5).
		return true, e.tombstone(ctx, row, c.Rev)
	}
}

// tombstone records that the server deleted a file this device still has
// changes for: the next push brings it back with a modify that carries its
// path (revival). A move still to send becomes part of that revival, since the
// server refuses to move a deleted file (a new operation: a new attempt).
func (e *Engine) tombstone(ctx context.Context, row File, rev int) error {
	row.ServerRev, row.Tombstoned = rev, true
	if row.State == StateLocalMoved {
		row.State, row.MovedFrom, row.Dirty = StateLocalModify, "", false
		row.Attempts, row.LastError = 0, ""
	}
	return e.cfg.DB.PutFile(ctx, row)
}

// bootstrapMode says how far the manifest of a bootstrap is to be trusted.
type bootstrapMode int

const (
	// bootstrapAuthoritative: first link of an existing vault, or a cursor
	// older than the changelog window (compaction_seq). The tree is the truth:
	// what it does not list was deleted on the server (§3.4.4 B).
	bootstrapAuthoritative bootstrapMode = iota
	// bootstrapReconcileUpload: a cursor ahead of the server (last_seq), whose
	// database was restored to an earlier point in time. What this device has
	// at a newer revision, or the server no longer lists, is what the server
	// lost: it is republished by the next push instead of being overwritten
	// or trashed (ADR-0046).
	bootstrapReconcileUpload
)

// remoteFile is an entry of the server manifest with its local path.
type remoteFile struct {
	transport.TreeEntry
	path string
}

// bootstrapReconcilePending is the MetaBootstrapped value of a reconcile
// bootstrap that has not completed yet. It is resumed in the same mode: once
// other devices republished past this device's cursor, the server answers
// GET /changes normally, and the rows not reconciled yet (revisions the
// server no longer has, files it no longer lists) would never be.
const bootstrapReconcilePending = "reconcile"

// bootstrap reconciles with the full manifest: first link of an existing
// vault, a cursor older than the changelog window (§3.4.4 B), or a server
// that went back in time (mode, ADR-0046).
func (e *Engine) bootstrap(ctx context.Context, mode bootstrapMode) error {
	if mode == bootstrapReconcileUpload {
		if err := e.cfg.DB.SetMeta(ctx, MetaBootstrapped, bootstrapReconcilePending); err != nil {
			return err
		}
	}
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
	// Every entry quarantined so far is read again here: the ones still
	// unreadable are recorded anew, the others are lifted at the end.
	stale, err := e.cfg.DB.Quarantined(ctx)
	if err != nil {
		return err
	}
	unreadable := map[string]bool{}
	remote := make([]remoteFile, 0, len(tree.Items))
	known := make(map[string]int, len(tree.Items)) // listed file id -> server revision
	for _, it := range tree.Items {
		// Listed by the server: never a deletion, even when unreadable.
		known[it.FileID] = it.Rev
		p, err := e.clearPath(ctx, it.FileID, it.Path)
		if err != nil {
			if e.isLocked(err) {
				return e.lockedErr(err)
			}
			row, has := byID[it.FileID]
			if err := e.quarantine(ctx, it.FileID, it.Rev, row, has, err); err != nil {
				return err
			}
			unreadable[it.FileID] = true
			continue
		}
		remote = append(remote, remoteFile{it, p})
	}
	sort.Slice(remote, func(i, j int) bool { return remote[i].path < remote[j].path })
	if mode == bootstrapReconcileUpload {
		// Parked changes of the lost timeline name revisions the restored
		// server does not have: their authors republish them, and a merge
		// against them would base our next push on a revision that is gone.
		for id, c := range e.candidates {
			if rev, listed := known[id]; !listed || c.Rev > rev {
				if err := e.dropCandidate(ctx, id); err != nil {
					return err
				}
			}
		}
	}

	e.progress(0, len(remote))
	if err := e.reconcileAll(ctx, mode, remote, byID, byPath); err != nil {
		return err
	}
	// Files we know that the server no longer has were deleted there, or, on
	// a server that went back in time, created after its restore point.
	for _, r := range rows {
		if _, listed := known[r.FileID]; r.ServerRev > 0 && !listed {
			cur, ok, _ := e.cfg.DB.GetFileByID(ctx, r.FileID)
			if !ok {
				continue
			}
			if mode == bootstrapReconcileUpload {
				if err := e.reupload(ctx, cur); err != nil {
					return err
				}
				continue
			}
			if _, err := e.applyDelete(ctx, cur, true, transport.Change{FileID: r.FileID, Op: "delete", Rev: r.ServerRev + 1}); err != nil {
				return err
			}
		}
	}
	for _, q := range stale {
		if !unreadable[q.FileID] {
			if err := e.liftApplied(ctx, q.FileID, math.MaxInt); err != nil {
				return err
			}
		}
	}
	e.quarantineChecked = true
	var saved func()
	if err := e.cfg.DB.WithTx(ctx, func(tx *DB) error {
		var err error
		if saved, err = e.saveCandidates(ctx, tx); err != nil {
			return err
		}
		if err := tx.SetCursor(ctx, tree.AsOfSeq, tree.AsOfID, true); err != nil {
			return err
		}
		return tx.SetMeta(ctx, MetaBootstrapped, "1")
	}); err != nil {
		return err
	}
	saved()
	return nil
}

// reconcileAll reconciles the readable entries of the manifest in their
// order, the blobs they need downloaded ahead (startPrefetch).
func (e *Engine) reconcileAll(ctx context.Context, mode bootstrapMode, remote []remoteFile, byID, byPath map[string]File) error {
	var wants []blobWant
	if e.transfers() > 1 {
		for i, rf := range remote {
			if e.reconcileWants(mode, rf, byID, byPath) {
				wants = append(wants, blobWant{pos: i, fileID: rf.FileID, hash: rf.Hash, size: rf.Size})
			}
		}
	}
	ctx, stop := e.startPrefetch(ctx, wants)
	defer stop()
	for i, rf := range remote {
		if err := ctx.Err(); err != nil {
			return err
		}
		advancePrefetch(ctx, i)
		e.progress(i+1, len(remote))
		if err := e.reconcileEntry(ctx, mode, rf, byID, byPath); err != nil {
			return err
		}
	}
	return nil
}

// reconcileWants guesses whether reconcileEntry downloads the blob of an
// entry (see pageWants): a file this device does not have, unless it adopts
// a local copy it can compare without downloading, or a new content of a
// synced file.
func (e *Engine) reconcileWants(mode bootstrapMode, rf remoteFile, byID, byPath map[string]File) bool {
	if rf.Hash == "" {
		return false
	}
	row, ok := byID[rf.FileID]
	if !ok {
		local, adopt := byPath[rf.path]
		adopt = adopt && local.State == StateLocalNew && local.ServerRev == 0
		return !adopt || e.cfg.Cipher != nil || local.LocalHash != rf.Hash
	}
	if mode == bootstrapReconcileUpload && row.ServerRev >= rf.Rev {
		return false // republished, or already there
	}
	return row.State == StateSynced && (row.ServerHash != rf.Hash || row.ServerRev < rf.Rev)
}

// reconcileEntry brings one readable entry of the server manifest into
// sync_files and onto the disk (a bootstrap, or the retry of a quarantined
// entry). byID and byPath are the rows as they were before the reconcile.
func (e *Engine) reconcileEntry(ctx context.Context, mode bootstrapMode, rf remoteFile, byID, byPath map[string]File) error {
	synthetic := transport.Change{FileID: rf.FileID, Op: "modify", Path: rf.Path, Rev: rf.Rev, BlobHash: rf.Hash, Size: rf.Size}
	if row, ok := byID[rf.FileID]; ok {
		if mode == bootstrapReconcileUpload && (row.ServerRev > rf.Rev || (row.ServerRev == rf.Rev && row.ServerHash != rf.Hash)) {
			return e.republish(ctx, row, rf.Rev, rf.Hash, rf.path)
		}
		if mode == bootstrapReconcileUpload && row.State == StateLocalMoved && row.MovedFrom == rf.path && row.ServerRev == rf.Rev && row.ServerHash == rf.Hash {
			// A move still to send from where the server has the file (made
			// here, or set by an earlier reconcile that was interrupted): the
			// server has nothing newer, so the push moves it.
			return nil
		}
		// The revision alone is not enough: a move applied by an earlier,
		// interrupted bootstrap already raised it without the content.
		if row.ServerRev >= rf.Rev && row.ServerHash == rf.Hash && row.Path == rf.path {
			return nil
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
			return e.applyContentClear(ctx, row, true, synthetic, rf.path)
		}
		return nil
	}
	// Unknown to us. A local file at the same path with the same content is
	// the same file (the vault was copied here): adopt it instead of copying.
	if local, ok := byPath[rf.path]; ok && local.State == StateLocalNew && local.ServerRev == 0 {
		same := false
		if e.cfg.Cipher == nil {
			same = local.LocalHash == rf.Hash
		} else if data, err := e.fetch(ctx, rf.FileID, rf.Hash, rf.Size); err == nil {
			same = hashHex(data) == local.LocalHash
		}
		if same {
			oldID := local.FileID
			local.FileID, local.ServerRev, local.BaseRev, local.ServerHash, local.State = rf.FileID, rf.Rev, rf.Rev, rf.Hash, StateSynced
			return e.cfg.DB.WithTx(ctx, func(tx *DB) error {
				if err := tx.DeleteFile(ctx, oldID); err != nil {
					return err
				}
				return tx.PutFile(ctx, local)
			})
		}
	}
	return e.applyContentClear(ctx, File{}, false, synthetic, rf.path)
}

// republish settles a file that this device has at a newer revision than the
// server restored from a backup, or at the same revision with other content
// (ADR-0046). The server's revision becomes the base and nothing remote is
// applied: whatever differs from it (content, path) is sent by the next push,
// which merges as usual if another device republished first. A local deletion
// is sent against the restored revision.
func (e *Engine) republish(ctx context.Context, row File, rev int, hash, serverPath string) error {
	content := row.ServerHash != hash || row.Tombstoned
	row.ServerRev, row.BaseRev, row.ServerHash, row.Tombstoned = rev, rev, hash, false
	row.Attempts, row.LastError = 0, ""
	if row.State != StateLocalDeleted {
		dirty := content || row.State == StateLocalModify || row.State == StateConflict || (row.State == StateLocalMoved && row.Dirty)
		row.MovedFrom, row.Dirty = "", false
		switch {
		case row.Path != serverPath:
			// The newer path is ours: keep it and let the push move the file.
			row.State, row.MovedFrom, row.Dirty = StateLocalMoved, serverPath, dirty
		case dirty:
			row.State = StateLocalModify
		default:
			row.State = StateSynced // the server has this very content and path
		}
	}
	// A new operation id: one the restored server may still know would be
	// answered with its old result.
	if err := e.cfg.DB.DeleteOutbox(ctx, row.Path); err != nil {
		return err
	}
	return e.cfg.DB.PutFile(ctx, row)
}

// reupload handles a file this device had from the server that the server,
// restored from a backup, no longer lists (ADR-0046): it was created after the
// restore point, so it is uploaded again as a new file (same id, new
// operation id) instead of being trashed. A file gone here too is forgotten.
func (e *Engine) reupload(ctx context.Context, row File) error {
	if err := e.cfg.DB.DeleteOutbox(ctx, row.Path); err != nil {
		return err
	}
	if row.State == StateLocalDeleted || !e.diskExists(row.Path) {
		return e.cfg.DB.DeleteFile(ctx, row.FileID)
	}
	row.ServerRev, row.BaseRev, row.ServerHash, row.State = 0, 0, "", StateLocalNew
	row.MovedFrom, row.Dirty, row.Tombstoned, row.Attempts, row.LastError = "", false, false, 0, ""
	return e.cfg.DB.PutFile(ctx, row)
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
		_, err := e.overwriteFromRemote(ctx, row, c, true)
		return err
	}
	e.addCandidate(c)
	return nil
}

var _ = strings.TrimSpace
