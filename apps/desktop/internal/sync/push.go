package sync

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sort"

	"github.com/google/uuid"

	"memobrain/apps/desktop/internal/sync/transport"
	"memobrain/shared/syncproto"
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
	data      []byte // blob to upload (nil for move/delete)
	blobHash  string
	localHash string
	mtime     int64
	size      int64
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

// push sends local changes (§3.4.4 C): blobs first (only the missing ones),
// then the operations in batches, then the results are folded back into
// sync_files. It reports whether anything happened that needs another round.
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
	var ops []prepared
	for _, r := range rows {
		if r.Attempts >= MaxAttempts {
			continue
		}
		p, ok, err := e.prepare(ctx, r)
		if err != nil {
			return false, err
		}
		if ok {
			ops = append(ops, p)
		}
	}
	if len(ops) == 0 {
		return false, nil
	}
	e.progress(0, len(ops))

	again := false
	done := 0
	for start := 0; start < len(ops); {
		end, bytes := start, 0
		for end < len(ops) && end-start < maxBatchOps && (bytes == 0 || bytes+len(ops[end].data) <= maxBatchBytes) {
			bytes += len(ops[end].data)
			end++
		}
		batch := ops[start:end]
		start = end
		if err := e.upload(ctx, batch); err != nil {
			return again, err
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
		e.progress(done, len(ops))
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
			tok, key, err := e.cfg.Cipher.EncryptPath(row.Path)
			if err != nil {
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
		cont, err := e.cfg.FS.ReadFile(row.Path)
		if err != nil {
			if os.IsNotExist(err) {
				return p, false, nil // vanished since the scan: next round
			}
			return p, false, err
		}
		p.localHash, p.mtime, p.size = cont.Hash, cont.Mtime.UnixNano(), cont.Size
		data, blobHash, err := e.blobFor(ctx, row, kind, cont.Hash, cont.Data)
		if err != nil {
			return p, false, e.park(ctx, row, "cannot encrypt the content: "+err.Error())
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

// park stops retrying a file until it changes, remembering why.
func (e *Engine) park(ctx context.Context, row File, reason string) error {
	row.Attempts, row.LastError = MaxAttempts, reason
	return e.cfg.DB.PutFile(ctx, row)
}

// upload sends the blobs of a batch the server does not have yet.
func (e *Engine) upload(ctx context.Context, batch []prepared) error {
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
		return nil
	}
	missing, err := e.cfg.Remote.CheckBlobs(ctx, hashes)
	if err != nil {
		return err
	}
	for _, h := range missing {
		p := byHash[h]
		if p == nil {
			continue
		}
		ob, _, _ := e.cfg.DB.GetOutbox(ctx, p.row.Path)
		url, err := e.cfg.Remote.Upload(ctx, h, p.data, ob.UploadURL)
		if url != "" && url != ob.UploadURL && ob.OpID != "" {
			ob.UploadURL = url
			_ = e.cfg.DB.PutOutbox(ctx, ob, e.cfg.Now())
		}
		if err != nil {
			return fmt.Errorf("upload %s: %w", p.row.Path, err)
		}
	}
	return nil
}

// applyResult folds one operation's outcome into sync_files. It reports
// whether another round is needed.
func (e *Engine) applyResult(ctx context.Context, p prepared, res syncproto.OpResult) (bool, error) {
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
		}
		row.Attempts, row.LastError = 0, ""
		return true, e.cfg.DB.PutFile(ctx, row)

	case syncproto.StatusConflict:
		// Somebody committed first. The pull of the next round brings their
		// change; remember a tombstone so the retry revives the file.
		row.Attempts++
		if res.CurrentHash == "" && p.op.Op == syncproto.OpModify {
			row.Tombstoned, row.ServerRev = true, res.CurrentRev
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

var (
	_ = errors.New
	_ = transport.BasePath
)
