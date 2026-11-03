package sync

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	stdsync "sync"

	"github.com/google/uuid"

	"memobrain/apps/desktop/internal/sync/transport"
	"memobrain/shared/syncproto"
	"memobrain/shared/vaultcrypto"
)

const (
	maxBatchOps   = 100
	maxBatchBytes = 64 << 20
)

// prepared is one operation ready to be sent, with what is needed to
// interpret its result.
type prepared struct {
	row       File
	op        syncproto.Op
	data      []byte // blob to upload (nil for move/delete, and once uploaded)
	blobHash  string
	localHash string
	mtime     int64
	size      int64
	// folder is set for a move_prefix (row is then empty).
	folder *folderMove
}

// planned is one entry of a push: a row whose operation is built, and its
// content read (and encrypted), only when its batch is about to be sent, or a
// move_prefix built up front (it carries no content).
type planned struct {
	row   File
	ready *prepared
}

// contentEstimate is the content a planned row will add to its batch, as the
// scan measured it: what is read may differ (the file changed since, or the
// ciphertext is slightly larger), which the batching tolerates.
func (pl planned) contentEstimate() int {
	if pl.ready == nil && (pl.row.State == StateLocalNew || pl.row.State == StateLocalModify || (pl.row.State == StateLocalMoved && pl.row.Tombstoned)) {
		return int(pl.row.LocalSize)
	}
	return 0
}

func opOrder(s State) int {
	switch s {
	case StateLocalMoved:
		return 0
	case StateLocalNew:
		return 1
	case StateLocalModify:
		return 2
	default:
		return 3
	}
}

// push sends local changes (§3.4.4 C) batch by batch: blobs first (only the
// missing ones), then the operations, then the results are folded back into
// sync_files. A batch holds at most maxBatchBytes of content (plus one file
// read beyond it). It reports whether anything happened that needs another
// round.
func (e *Engine) push(ctx context.Context) (bool, error) {
	rows, err := e.cfg.DB.Files(ctx, StateLocalNew, StateLocalModify, StateLocalMoved, StateLocalDeleted)
	if err != nil {
		return false, err
	}
	sort.SliceStable(rows, func(i, j int) bool {
		if oi, oj := opOrder(rows[i].State), opOrder(rows[j].State); oi != oj {
			return oi < oj
		}
		return rows[i].Path < rows[j].Path
	})
	// Folder renames go as one move_prefix each (shared vaults, folders.go),
	// after the deletes of files below them and before everything else.
	folders, held, err := e.folderMoves(ctx)
	if err != nil {
		return false, err
	}
	inFolder, early := map[string]bool{}, map[string]bool{}
	var prefixOps []planned
	for _, m := range folders {
		for _, r := range m.members {
			inFolder[r.FileID] = true
		}
		for _, id := range m.deletes {
			early[id] = true
		}
		p, err := e.preparePrefix(ctx, m)
		if err != nil {
			return false, err
		}
		prefixOps = append(prefixOps, planned{ready: &p})
	}
	// Only the order is decided here: reading every pending file up front
	// would hold the whole change set in memory (a first sync of a large
	// vault), so each batch reads its own files just before it is sent.
	var plan, earlyPlan []planned
	for _, r := range rows {
		if inFolder[r.FileID] || held[r.FileID] {
			continue
		}
		if r.Attempts >= MaxAttempts {
			continue
		}
		if _, pending := e.candidates[r.FileID]; pending {
			continue // a server change waits to be merged first: sending now could only conflict
		}
		if early[r.FileID] {
			earlyPlan = append(earlyPlan, planned{row: r})
		} else {
			plan = append(plan, planned{row: r})
		}
	}
	if len(prefixOps) > 0 {
		plan = append(append(earlyPlan, prefixOps...), plan...)
	} else {
		plan = append(earlyPlan, plan...)
	}
	if len(plan) == 0 {
		return false, nil
	}
	e.progress(0, len(plan))

	again := false
	done := 0
	// carry was read for a batch it did not fit in: it opens the next one, so
	// at most one file is held beyond the batch limit.
	var carry *prepared
	for next := 0; next < len(plan) || carry != nil; {
		var batch []prepared
		bytes := 0
		if carry != nil {
			batch, bytes, carry = append(batch, *carry), len(carry.data), nil
		}
		for next < len(plan) && len(batch) < maxBatchOps {
			pl := plan[next]
			if pl.ready != nil {
				batch = append(batch, *pl.ready)
				next++
				continue
			}
			if bytes > 0 && bytes+pl.contentEstimate() > e.batchBytes {
				break // not read yet: it opens the next batch
			}
			if err := ctx.Err(); err != nil {
				return again, err // cancelled: read (and encrypt) nothing more
			}
			next++
			p, ok, err := e.prepare(ctx, pl.row)
			if err != nil {
				return again, err
			}
			if !ok {
				done++
				continue
			}
			if bytes > 0 && bytes+len(p.data) > e.batchBytes {
				carry = &p // larger than the scan said
				break
			}
			batch = append(batch, p)
			bytes += len(p.data)
		}
		if len(batch) == 0 {
			e.progress(done, len(plan))
			continue
		}
		tooLarge, err := e.upload(ctx, batch)
		for i := range batch {
			batch[i].data = nil // uploaded (or refused): the digests are enough from here on
		}
		if err != nil {
			return again, err
		}
		if len(tooLarge) > 0 {
			// The server refused these blobs: their files are parked and
			// the rest of the batch goes on without them.
			kept := batch[:0:0]
			for _, p := range batch {
				if !tooLarge[p.blobHash] {
					kept = append(kept, p)
				}
			}
			done += len(batch) - len(kept)
			if batch = kept; len(batch) == 0 {
				e.progress(done, len(plan))
				continue
			}
		}
		reqOps := make([]syncproto.Op, len(batch))
		for i, p := range batch {
			reqOps[i] = p.op
		}
		resp, err := e.cfg.Remote.Commit(ctx, syncproto.CommitRequest{DeviceID: e.cfg.DeviceID, Ops: reqOps})
		if err != nil {
			return again, err
		}
		if len(resp.Results) != len(batch) {
			return again, fmt.Errorf("server answered %d results for %d operations", len(resp.Results), len(batch))
		}
		for i, p := range batch {
			progressed, err := e.applyResult(ctx, p, resp.Results[i])
			if err != nil {
				return again, err
			}
			again = again || progressed
		}
		done += len(batch)
		e.progress(done, len(plan))
		e.mu.Lock()
		stop := e.stop
		e.mu.Unlock()
		if stop != nil {
			return again, nil
		}
	}
	return again, nil
}

// prepare builds the operation of one row. ok is false when the row needs
// nothing sent (it vanished, or only existed locally).
func (e *Engine) prepare(ctx context.Context, row File) (prepared, bool, error) {
	p := prepared{row: row}
	kind := ""
	switch row.State {
	case StateLocalDeleted:
		if row.ServerRev == 0 || row.Tombstoned {
			return p, false, e.cfg.DB.DeleteFile(ctx, row.FileID)
		}
		kind = "delete"
	case StateLocalMoved:
		kind = "move"
		if row.Tombstoned {
			// Deleted on the server, which refuses to move a deleted file: the
			// revival carries the new path (and the content) instead.
			kind = "modify"
		}
	case StateLocalNew:
		kind = "create"
	case StateLocalModify:
		kind = "modify"
	}
	op := syncproto.Op{Op: syncproto.OpKind(kind), FileID: row.FileID}
	if kind != "create" {
		rev := row.ServerRev
		op.BaseRev = &rev
	}

	needsPath := kind == "create" || kind == "move" || (kind == "modify" && row.Tombstoned)
	if needsPath {
		if e.cfg.Cipher != nil {
			tok, key, err := e.cfg.Cipher.EncryptPath(row.FileID, row.Path, e.writePathV2(ctx))
			if err != nil {
				if e.isLocked(err) {
					return p, false, e.lockedErr(err) // not the file's fault: never park it
				}
				return p, false, e.park(ctx, row, "cannot encrypt the path: "+err.Error())
			}
			op.Path, op.PathKey = tok, key
		} else {
			op.Path = row.Path
		}
	}
	if kind == "create" && row.ConflictOf != "" {
		op.ConflictOf = row.ConflictOf
	}

	if kind == "create" || kind == "modify" {
		limit := e.maxFileBytes()
		// Checked on disk first so an oversized file is never read into memory
		// nor encrypted, then again on what was read (it may have grown).
		if st, err := os.Stat(e.absPath(row.Path)); err == nil && st.Size() > limit {
			return p, false, e.parkTooLarge(ctx, row, st.Size(), limit)
		}
		cont, err := e.readFile(row.Path)
		if err != nil {
			if os.IsNotExist(err) {
				return p, false, nil // vanished since the scan: next round
			}
			return p, false, err
		}
		if cont.Size > limit {
			return p, false, e.parkTooLarge(ctx, row, cont.Size, limit)
		}
		p.localHash, p.mtime, p.size = cont.Hash, cont.Mtime.UnixNano(), cont.Size
		data, blobHash, err := e.blobFor(ctx, row, kind, cont.Hash, cont.Data)
		if err != nil {
			if e.isLocked(err) {
				return p, false, e.lockedErr(err)
			}
			return p, false, e.park(ctx, row, "cannot encrypt the content: "+err.Error())
		}
		if int64(len(data)) > limit { // the ciphertext is slightly larger than the plaintext
			return p, false, e.parkTooLarge(ctx, row, int64(len(data)), limit)
		}
		p.data, p.blobHash = data, blobHash
		op.BlobHash, op.Size = blobHash, int64(len(data))
	}
	id, err := e.opID(ctx, row, kind, p.localHash, p.blobHash)
	if err != nil {
		return p, false, err
	}
	op.OpID = id
	t := e.cfg.Now()
	op.ClientMtime = &t
	p.op = op
	return p, true, nil
}

// opID reuses the operation id (and so the server's idempotency) when the very
// same change is sent again after a crash or a lost response.
func (e *Engine) opID(ctx context.Context, row File, kind, localHash, blobHash string) (string, error) {
	ob, ok, err := e.cfg.DB.GetOutbox(ctx, row.Path)
	if err != nil {
		return "", err
	}
	if ok && ob.Kind == kind && ob.LocalHash == localHash && (blobHash == "" || ob.BlobHash == blobHash) {
		return ob.OpID, nil
	}
	id := uuid.Must(uuid.NewV7()).String()
	return id, e.cfg.DB.PutOutbox(ctx, OutboxEntry{Path: row.Path, OpID: id, Kind: kind, LocalHash: localHash, BlobHash: blobHash}, e.cfg.Now())
}

// blobFor returns the bytes to upload and their digest. In private vaults the
// ciphertext is cached so a retry sends the same blob (every encryption uses a
// fresh salt and would otherwise produce a new digest).
func (e *Engine) blobFor(ctx context.Context, row File, kind, localHash string, plain []byte) ([]byte, string, error) {
	if e.cfg.Cipher == nil {
		return plain, localHash, nil
	}
	if ob, ok, _ := e.cfg.DB.GetOutbox(ctx, row.Path); ok && ob.Kind == kind && ob.LocalHash == localHash && ob.BlobHash != "" {
		if data, err := os.ReadFile(e.cachePath(ob.BlobHash)); err == nil {
			sum := sha256.Sum256(data)
			if hex.EncodeToString(sum[:]) == ob.BlobHash {
				return data, ob.BlobHash, nil
			}
		}
	}
	ct, err := e.cfg.Cipher.EncryptBlob(row.FileID, plain)
	if err != nil {
		return nil, "", err
	}
	sum := sha256.Sum256(ct)
	h := hex.EncodeToString(sum[:])
	if err := os.MkdirAll(e.cfg.CacheDir, 0o700); err == nil {
		_ = os.WriteFile(e.cachePath(h), ct, 0o600)
	}
	return ct, h, nil
}

func (e *Engine) cachePath(hash string) string { return filepath.Join(e.cfg.CacheDir, hash) }

func (e *Engine) maxFileBytes() int64 {
	if e.cfg.MaxFileBytes != nil {
		if n := e.cfg.MaxFileBytes(); n > 0 {
			return n
		}
	}
	return syncproto.DefaultMaxFileBytes
}

// parkTooLarge parks a file over the size limit with the server's error code,
// so the UI explains it like a rejection.
func (e *Engine) parkTooLarge(ctx context.Context, row File, size, limit int64) error {
	return e.park(ctx, row, fmt.Sprintf("%s: file of %d bytes exceeds the limit of %d", syncproto.CodeFileTooLarge, size, limit))
}

// park stops retrying a file until it changes, remembering why.
func (e *Engine) park(ctx context.Context, row File, reason string) error {
	row.Attempts, row.LastError = MaxAttempts, reason
	return e.cfg.DB.PutFile(ctx, row)
}

// upload sends the blobs of a batch the server does not have yet, up to
// Config.Transfers at once (the batch is in memory already). A blob the
// server refuses as too large (its limit may be lower than the one this
// device knows) parks its file and is reported in tooLarge instead of failing
// the whole batch; any other failure stops the uploads still running and
// fails the batch.
func (e *Engine) upload(ctx context.Context, batch []prepared) (tooLarge map[string]bool, err error) {
	byHash := map[string]*prepared{}
	var hashes []string
	for i := range batch {
		if batch[i].data == nil {
			continue
		}
		if _, dup := byHash[batch[i].blobHash]; !dup {
			byHash[batch[i].blobHash] = &batch[i]
			hashes = append(hashes, batch[i].blobHash)
		}
	}
	if len(hashes) == 0 {
		return nil, nil
	}
	missing, err := e.cfg.Remote.CheckBlobs(ctx, hashes)
	if err != nil {
		return nil, err
	}
	// sync.db is read and written here, in order; only the transfers run at
	// once (outcome i belongs to sends[i]).
	type send struct {
		p   *prepared
		ob  OutboxEntry
		url string
		err error
	}
	var sends []send
	for _, h := range missing {
		if p := byHash[h]; p != nil {
			ob, _, _ := e.cfg.DB.GetOutbox(ctx, p.row.Path)
			sends = append(sends, send{p: p, ob: ob})
		}
	}
	var failed *send
	var mu stdsync.Mutex
	_ = runLimited(ctx, len(sends), e.transfers(), func(ctx context.Context, i int) error {
		s := &sends[i]
		s.url, s.err = e.cfg.Remote.Upload(ctx, s.p.blobHash, s.p.data, s.ob.UploadURL)
		if s.err == nil || transport.IsCode(s.err, syncproto.CodeFileTooLarge) {
			return nil
		}
		mu.Lock()
		if failed == nil {
			failed = s // the first failure: the others stop because of it
		}
		mu.Unlock()
		return s.err
	})
	for i := range sends {
		s := &sends[i]
		if s.url != "" && s.url != s.ob.UploadURL && s.ob.OpID != "" {
			s.ob.UploadURL = s.url
			_ = e.cfg.DB.PutOutbox(ctx, s.ob, e.cfg.Now())
		}
		if transport.IsCode(s.err, syncproto.CodeFileTooLarge) {
			if err := e.park(ctx, s.p.row, s.err.Error()); err != nil {
				return tooLarge, err
			}
			if tooLarge == nil {
				tooLarge = map[string]bool{}
			}
			tooLarge[s.p.blobHash] = true
		}
	}
	if failed != nil {
		return tooLarge, fmt.Errorf("upload %s: %w", failed.p.row.Path, failed.err)
	}
	if err := ctx.Err(); err != nil {
		return tooLarge, err
	}
	return tooLarge, nil
}

// applyResult folds one operation's outcome into sync_files. It reports
// whether another round is needed.
func (e *Engine) applyResult(ctx context.Context, p prepared, res syncproto.OpResult) (bool, error) {
	if p.folder != nil {
		return e.applyPrefixResult(ctx, p, res)
	}
	row := p.row
	// The row may have been changed by an earlier result of this batch.
	if cur, ok, err := e.cfg.DB.GetFileByID(ctx, row.FileID); err != nil {
		return false, err
	} else if ok {
		row = cur
	}
	finish := func() {
		_ = e.cfg.DB.DeleteOutbox(ctx, p.row.Path)
		if p.blobHash != "" && e.cfg.Cipher != nil {
			_ = os.Remove(e.cachePath(p.blobHash))
		}
	}
	switch res.Status {
	case syncproto.StatusAccepted:
		finish()
		if e.cfg.Cipher != nil && vaultcrypto.PathTokenVersion(p.op.Path) == 2 {
			e.pinPathV2(ctx, row.FileID) // the server now holds an enc2 token for it
		}
		switch p.op.Op {
		case syncproto.OpDelete:
			return true, e.cfg.DB.DeleteFile(ctx, row.FileID)
		case syncproto.OpMove:
			row.ServerRev, row.MovedFrom = res.Rev, ""
			if row.Dirty {
				row.State, row.Dirty = StateLocalModify, false
			} else {
				row.State, row.BaseRev = StateSynced, res.Rev
			}
		default:
			row.ServerRev, row.BaseRev, row.ServerHash, row.Tombstoned = res.Rev, res.Rev, p.blobHash, false
			row.LocalHash, row.LocalSize, row.LocalMtime = p.localHash, p.size, p.mtime
			row.State, row.ConflictOf = StateSynced, ""
			if p.op.Path != "" {
				row.MovedFrom, row.Dirty = "", false // a revival puts the file where it is here
			}
		}
		row.Attempts, row.LastError = 0, ""
		return true, e.cfg.DB.PutFile(ctx, row)

	case syncproto.StatusConflict:
		// Somebody committed first. The pull of the next round brings their
		// change; remember a tombstone so the retry revives the file.
		row.Attempts++
		if res.CurrentHash == "" && p.op.Op == syncproto.OpModify {
			row.Tombstoned, row.ServerRev = true, res.CurrentRev
		} else if res.CurrentHash != "" && res.CurrentRev > row.ServerRev {
			// Safety net: the server is ahead of what we know. Normally the next
			// pull brings that change, but if it was already passed (a candidate
			// lost by an older version) nothing would: park the current revision
			// as a candidate so the next round merges it instead of retrying the
			// same stale base until the file is parked (D-04). A real change
			// pulled meanwhile replaces it (same or newer revision).
			if cur, ok := e.candidates[row.FileID]; !ok || cur.Rev < res.CurrentRev {
				e.addCandidate(transportChange{Seq: res.CurrentSeq, FileID: row.FileID, Op: "modify", Rev: res.CurrentRev, BlobHash: res.CurrentHash})
				saved, err := e.saveCandidates(ctx, e.cfg.DB)
				if err != nil {
					return false, err
				}
				saved()
			}
		}
		if row.Attempts >= MaxAttempts {
			row.State, row.LastError = StateConflict, "too many concurrent edits: resolve manually"
			return false, e.cfg.DB.PutFile(ctx, row)
		}
		return true, e.cfg.DB.PutFile(ctx, row)

	default: // rejected
		return e.rejected(ctx, p, row, res)
	}
}

func (e *Engine) rejected(ctx context.Context, p prepared, row File, res syncproto.OpResult) (bool, error) {
	switch res.Code {
	case syncproto.CodePathCollision:
		// Another file took the path (create versus create): keep both.
		np := uniquePath(row.Path, func(s string) bool { return e.pathTaken(ctx, s) })
		if err := e.cfg.FS.Rename(row.Path, np); err != nil {
			return false, err
		}
		_ = e.cfg.DB.DeleteOutbox(ctx, row.Path)
		row.Path = np
		row.Attempts++
		return true, e.cfg.DB.PutFile(ctx, row)
	case syncproto.CodeQuotaExceeded:
		e.mu.Lock()
		e.stop = fmt.Errorf("storage quota exceeded: %s", res.Detail)
		e.mu.Unlock()
		return false, nil
	case syncproto.CodeBlobMissing:
		_ = e.cfg.DB.DeleteOutbox(ctx, row.Path)
		row.Attempts++
		return row.Attempts < MaxAttempts, e.cfg.DB.PutFile(ctx, row)
	case syncproto.CodeShareRootMove:
		return e.shareRootMove(ctx, p, row, res)
	case syncproto.CodeNotFound:
		// The server does not know the file (e.g. a restored backup): upload it as new.
		if p.op.Op == syncproto.OpDelete {
			return true, e.cfg.DB.DeleteFile(ctx, row.FileID)
		}
		row.ServerRev, row.BaseRev, row.ServerHash, row.State, row.Tombstoned = 0, 0, "", StateLocalNew, false
		_ = e.cfg.DB.DeleteOutbox(ctx, row.Path)
		return true, e.cfg.DB.PutFile(ctx, row)
	default:
		return false, e.park(ctx, row, fmt.Sprintf("%s: %s", res.Code, res.Detail))
	}
}
