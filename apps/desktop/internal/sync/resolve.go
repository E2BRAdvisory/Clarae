package sync

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"os"
	"sort"

	"memobrain/apps/desktop/internal/vault"
	"memobrain/shared/merge"
)

// resolveCandidates settles every file that was changed both here and on the
// server (§3.4.5), using the strategy of the decision table.
func (e *Engine) resolveCandidates(ctx context.Context) (bool, error) {
	if len(e.candidates) == 0 {
		return false, nil
	}
	ids := make([]string, 0, len(e.candidates))
	for id := range e.candidates {
		ids = append(ids, id)
	}
	sort.Strings(ids)
	did := false
	for _, id := range ids {
		c := e.candidates[id]
		delete(e.candidates, id)
		row, ok, err := e.cfg.DB.GetFileByID(ctx, id)
		if err != nil {
			return did, err
		}
		if !ok || row.BaseRev >= c.Rev {
			continue
		}
		if err := e.resolveOne(ctx, row, c); err != nil {
			return did, err
		}
		did = true
	}
	return did, nil
}

func (e *Engine) resolveOne(ctx context.Context, row File, c transportChange) error {
	remote, err := e.fetch(ctx, c.FileID, c.BlobHash)
	if err != nil {
		return err
	}
	remoteHash := hashHex(remote)

	// Deleted here, modified there: the modification wins, the file returns.
	if row.State == StateLocalDeleted {
		if err := e.makeRoom(ctx, row.Path); err != nil {
			return err
		}
		cont, err := e.cfg.FS.WriteFile(row.Path, remote, "", true)
		if err != nil {
			return err
		}
		row.ServerRev, row.BaseRev, row.ServerHash, row.LocalHash = max(row.ServerRev, c.Rev), c.Rev, c.BlobHash, cont.Hash
		row.LocalSize, row.LocalMtime = cont.Size, cont.Mtime.UnixNano()
		row.State, row.Tombstoned, row.Attempts = StateSynced, false, 0
		return e.cfg.DB.PutFile(ctx, row)
	}

	local, err := e.cfg.FS.ReadFile(row.Path)
	if os.IsNotExist(err) {
		row.State = StateLocalDeleted
		if err := e.cfg.DB.PutFile(ctx, row); err != nil {
			return err
		}
		return e.resolveOne(ctx, row, c)
	}
	if err != nil {
		return err
	}

	// A move that did not touch the content simply receives the new content.
	if row.State == StateLocalMoved && !row.Dirty {
		cont, err := e.cfg.FS.WriteFile(row.Path, remote, local.Hash, false)
		if errors.Is(err, vault.ErrHashMismatch) {
			row.Dirty = true
			return e.cfg.DB.PutFile(ctx, row)
		}
		if err != nil {
			return err
		}
		row.ServerRev, row.BaseRev, row.ServerHash, row.LocalHash = max(row.ServerRev, c.Rev), c.Rev, c.BlobHash, cont.Hash
		row.LocalSize, row.LocalMtime = cont.Size, cont.Mtime.UnixNano()
		return e.cfg.DB.PutFile(ctx, row)
	}

	// Identical content on both sides (e.g. our own change replayed): adopt.
	if local.Hash == remoteHash {
		row.ServerRev, row.BaseRev, row.ServerHash, row.LocalHash = max(row.ServerRev, c.Rev), c.Rev, c.BlobHash, local.Hash
		row.LocalSize, row.LocalMtime = local.Size, local.Mtime.UnixNano()
		switch {
		case row.State == StateLocalMoved:
		case row.Tombstoned:
			// The server has already moved on to a deletion: this file must be
			// uploaded again (the modification wins over the delete).
			row.State = StateLocalModify
		default:
			row.State, row.Attempts = StateSynced, 0
		}
		return e.cfg.DB.PutFile(ctx, row)
	}

	base, err := e.fetchRevision(ctx, c.FileID, row.BaseRev)
	if err != nil {
		base = nil // history pruned: merge without ancestor (conflicts surface as such)
	}
	sameAuthor := c.AuthorID != "" && c.AuthorID == e.cfg.UserID
	strategy := merge.Decide(kindOf(row.Path), sameAuthor, merge.ChangeModify, merge.ChangeModify)
	opt := merge.Options{TheirsTime: c.ServerTime}

	var res merge.Result
	switch strategy {
	case merge.StrategyMarkdown3Way:
		res = merge.Markdown(base, local.Data, remote)
	case merge.StrategyExcalidrawID:
		res, err = merge.Excalidraw(base, local.Data, remote)
	case merge.StrategyCanvasID:
		res, err = merge.Canvas(base, local.Data, remote, opt)
	case merge.StrategyConfigLWW:
		res, err = merge.ConfigLWW(base, local.Data, remote, opt)
	case merge.StrategyLastWriteWins:
		// The remote version was committed first, ours goes last and wins; the
		// loser stays in the server history, nothing is lost.
		res = merge.Result{Merged: local.Data, Clean: true}
	default: // conflict copy
		res = merge.Result{Merged: remote, Clean: false, CopyOf: merge.Ours}
	}
	if err != nil {
		// Unparsable content cannot be merged: keep the server's and save ours aside.
		e.log.Warn().Err(err).Str("path", row.Path).Msg("merge failed, falling back to a conflict copy")
		strategy = merge.StrategyConflictCopy
		res = merge.Result{Merged: remote, Clean: false, CopyOf: merge.Ours}
	}
	return e.finishMerge(ctx, row, c, strategy, res, local, remote)
}

func (e *Engine) finishMerge(ctx context.Context, row File, c transportChange, strategy merge.Strategy, res merge.Result, local vault.Content, remote []byte) error {
	ours := local.Data // what the user had, before the merged text replaces it
	if !bytes.Equal(res.Merged, local.Data) {
		cont, err := e.cfg.FS.WriteFile(row.Path, res.Merged, local.Hash, false)
		if errors.Is(err, vault.ErrHashMismatch) {
			return nil // edited again meanwhile: the next round starts over
		}
		if err != nil {
			return err
		}
		local = cont
	}
	row.ServerRev, row.BaseRev, row.ServerHash, row.LocalHash = max(row.ServerRev, c.Rev), c.Rev, c.BlobHash, local.Hash
	row.LocalSize, row.LocalMtime = local.Size, local.Mtime.UnixNano()
	identical := bytes.Equal(res.Merged, remote)
	switch {
	case row.State == StateLocalMoved:
		row.Dirty = !identical || row.Tombstoned
	case identical && !row.Tombstoned:
		row.State, row.Attempts, row.LastError = StateSynced, 0, ""
	default:
		// Our version differs from the server's, or the server's latest revision
		// is a deletion that our modification overrides: push it.
		row.State = StateLocalModify
	}
	if err := e.cfg.DB.PutFile(ctx, row); err != nil {
		return err
	}
	if res.Clean {
		return nil
	}
	// Not mergeable: the path keeps the server version; the losing side is
	// saved as a new file that syncs like any other and shows in the conflict view.
	content := ours
	if res.CopyOf == merge.Theirs {
		content = remote
	}
	copyPath := conflictPath(row.Path, e.cfg.DeviceName, e.cfg.Now(), func(p string) bool { return e.pathTaken(ctx, p) })
	cont, err := e.cfg.FS.WriteFile(copyPath, content, "", true)
	if err != nil {
		return err
	}
	if err := e.cfg.DB.PutFile(ctx, File{
		Path: copyPath, FileID: newFileID(), LocalHash: cont.Hash, LocalSize: cont.Size, LocalMtime: cont.Mtime.UnixNano(),
		State: StateLocalNew, ConflictOf: row.FileID,
	}); err != nil {
		return err
	}
	detail, _ := json.Marshal(res.Conflicts)
	conf, err := e.cfg.DB.AddConflict(ctx, Conflict{
		FileID: row.FileID, Path: row.Path, CopyPath: copyPath, Strategy: string(strategy),
		LocalHash: local.Hash, RemoteRev: c.Rev, Detail: string(detail), CreatedAt: e.cfg.Now(),
	})
	if err != nil {
		return err
	}
	if e.cfg.OnConflict != nil {
		e.cfg.OnConflict(conf)
	}
	return nil
}
