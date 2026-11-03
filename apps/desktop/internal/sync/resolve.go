package sync

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"sort"

	"memobrain/apps/desktop/internal/vault"
	"memobrain/shared/merge"
)

// errRetryLater means the file changed on disk while it was being resolved:
// the candidate stays parked and the next round starts over from the new content.
var errRetryLater = errors.New("file changed during resolution")

// resolveFailure reports files whose resolution failed for a reason of their
// own (e.g. an unreadable blob): their candidates are kept, and the cycle goes
// on with the other files before reporting it.
type resolveFailure struct{ err error }

func (r *resolveFailure) Error() string { return r.err.Error() }
func (r *resolveFailure) Unwrap() error { return r.err }

// resolveCandidates settles every file that was changed both here and on the
// server (§3.4.5), using the strategy of the decision table. A candidate is
// forgotten only once its resolution is written: a failure keeps it (in
// sync.db too) for the next round, because the changelog will not bring the
// change again (D-04).
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
	var firstErr error
	for _, id := range ids {
		if err := ctx.Err(); err != nil {
			return did, err
		}
		c := e.candidates[id]
		row, ok, err := e.cfg.DB.GetFileByID(ctx, id)
		if err != nil {
			return did, err
		}
		if !ok || row.BaseRev >= c.Rev {
			if err := e.dropCandidate(ctx, id); err != nil {
				return did, err
			}
			continue
		}
		err = e.resolveOne(ctx, row, c)
		switch {
		case errors.Is(err, errRetryLater):
			did = true // another round rescans the file and tries again
			continue
		case err != nil:
			if ctx.Err() != nil || e.isLocked(err) || isNetwork(err) {
				return did, e.lockedErr(err)
			}
			// This file cannot be settled now (e.g. its blob is unreadable):
			// the others go on, the cycle reports the failure.
			e.log.Warn().Err(err).Str("path", row.Path).Msg("cannot resolve a concurrent change, kept for the next round")
			if firstErr == nil {
				firstErr = &resolveFailure{fmt.Errorf("%s: %w", row.Path, err)}
			}
			continue
		}
		if err := e.dropCandidate(ctx, id); err != nil {
			return did, err
		}
		did = true
	}
	return did, firstErr
}

func (e *Engine) resolveOne(ctx context.Context, row File, c transportChange) error {
	remote, err := e.fetch(ctx, c.FileID, c.BlobHash, c.Size)
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

	// No local edit (a move that did not touch the content, or a row that a
	// remote move settled while this change was parked): the file simply
	// receives the new content, no merge (nor base revision) needed.
	if local.Hash == row.LocalHash && ((row.State == StateLocalMoved && !row.Dirty) || row.State == StateSynced) {
		cont, err := e.cfg.FS.WriteFile(row.Path, remote, local.Hash, false)
		if errors.Is(err, vault.ErrHashMismatch) {
			if row.State == StateLocalMoved {
				row.Dirty = true
				if err := e.cfg.DB.PutFile(ctx, row); err != nil {
					return err
				}
			}
			return errRetryLater // now a modification: rescanned and merged next round
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
		if ctx.Err() != nil || e.isLocked(err) || isNetwork(err) {
			return e.lockedErr(err) // not a pruned history: try again later
		}
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

	// Not mergeable: the path takes the merged (server) version and the losing
	// side is saved as a new file that syncs like any other and shows in the
	// conflict view. The copy is written before the original is replaced, so
	// a failure in between never loses either version.
	var cp *File
	if !res.Clean {
		content := ours
		if res.CopyOf == merge.Theirs {
			content = remote
		}
		copyPath := conflictPath(row.Path, e.cfg.DeviceName, e.cfg.Now(), func(p string) bool { return e.pathTaken(ctx, p) })
		cont, err := e.cfg.FS.WriteFile(copyPath, content, "", true)
		if err != nil {
			return err
		}
		cp = &File{
			Path: copyPath, FileID: newFileID(), LocalHash: cont.Hash, LocalSize: cont.Size, LocalMtime: cont.Mtime.UnixNano(),
			State: StateLocalNew, ConflictOf: row.FileID,
		}
	}

	if !bytes.Equal(res.Merged, local.Data) {
		if e.cfg.BeforeOverwrite != nil {
			e.cfg.BeforeOverwrite(row.Path) // ours is not on the server: keep a local snapshot
		}
		cont, err := e.cfg.FS.WriteFile(row.Path, res.Merged, local.Hash, false)
		if errors.Is(err, vault.ErrHashMismatch) {
			// Edited again meanwhile: the next round starts over from the new
			// text. The copy of the old one is no longer needed (it is a state
			// the user moved past) but goes to the trash rather than away.
			if cp != nil {
				if _, terr := e.cfg.FS.Trash(cp.Path); terr != nil && !os.IsNotExist(terr) {
					e.log.Warn().Err(terr).Str("path", cp.Path).Msg("cannot remove an unused conflict copy")
				}
			}
			return errRetryLater
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

	var conf Conflict
	err := e.cfg.DB.WithTx(ctx, func(tx *DB) error {
		if cp != nil {
			if err := tx.PutFile(ctx, *cp); err != nil {
				return err
			}
			detail, _ := json.Marshal(res.Conflicts)
			var err error
			conf, err = tx.AddConflict(ctx, Conflict{
				FileID: row.FileID, Path: row.Path, CopyPath: cp.Path, Strategy: string(strategy),
				LocalHash: local.Hash, RemoteRev: c.Rev, Detail: string(detail), CreatedAt: e.cfg.Now(),
			})
			if err != nil {
				return err
			}
		}
		return tx.PutFile(ctx, row)
	})
	if err != nil {
		return err
	}
	if cp != nil && e.cfg.OnConflict != nil {
		e.cfg.OnConflict(conf)
	}
	return nil
}
