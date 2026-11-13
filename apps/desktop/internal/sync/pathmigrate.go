package sync

import (
	"context"
	"encoding/json"
	"errors"
	"time"

	"github.com/google/uuid"

	"clarae/apps/desktop/internal/sync/transport"
	"clarae/shared/syncproto"
	"clarae/shared/vaultcrypto"
)

// Background migration of enc1 path tokens (ADR-0042, release N+1).
//
// A file keeps the token it was created or last moved with, so the files of a
// private vault written before enc2 keep an enc1 token, which is not bound to
// the file. While the vault is unlocked and features.path_v2 is on, the engine
// rewrites those tokens as enc2 with a move to the same path: same hmac1
// path key, so the server accepts it as a move of the file onto its own key,
// and the content does not change. Once a complete tree of the vault shows no
// enc1 token, the vault gets the strong pin (metaPathV2Strong) and every enc1
// token of it is refused from then on.
//
// The migration never gets in the way of the synchronization:
//   - it runs only at the end of a cycle that found nothing else to do, one
//     batch per cycle, at most every PathMigrationSpacing, within a bounded time;
//   - it touches only files that are synced here and on the server at the
//     revision of the tree (no local change, no parked remote change, no
//     error), with base_rev, so a concurrent change simply wins (conflict) and
//     the file is taken again by a later pass;
//   - a failure is logged and never fails the cycle.
//
// It is resumable: the server's tree is the progress (a migrated file has an
// enc2 token there), and sync.db keeps the counters and the time of the next
// batch (metaPathMigration), so a restart continues where it stopped.

const (
	// pathMigrationBatch is the number of files rewritten per batch.
	pathMigrationBatch = maxBatchOps
	// pathMigrationSpacing is the least time between two batches while files
	// are left; the scheduler comes back after it (MigrationPending).
	pathMigrationSpacing = 15 * time.Second
	// pathMigrationRecheck is the wait after a pass that could not go on: an
	// empty vault, or files left that cannot be rewritten now (a local change,
	// a conflict, an unreadable entry).
	pathMigrationRecheck = 15 * time.Minute
	// pathMigrationBudget bounds the time a batch may hold the engine.
	pathMigrationBudget = 30 * time.Second
)

// metaPathMigration keeps the progress of the migration of a cloud vault (JSON
// pathMigrationMeta).
func metaPathMigration(cloudID string) string { return "path_v2_migration:" + cloudID }

// pathMigrationMeta is the persisted progress.
type pathMigrationMeta struct {
	// Migrated counts the tokens this device rewrote.
	Migrated int `json:"migrated"`
	// Remaining is the number of enc1 tokens in the last tree read.
	Remaining int `json:"remaining"`
	// Next is when the next batch may run (Unix ns).
	Next int64 `json:"next"`
	// Done is set with the strong pin.
	Done bool `json:"done,omitempty"`
}

// pathMigration is the in-memory state of the engine.
type pathMigration struct {
	// queue holds the enc1 entries of the last tree read not examined yet.
	queue []transport.TreeEntry
	// progressed tells whether the pass that read the tree rewrote anything.
	progressed bool
	// refused remembers, per file id, the revision the server refused to
	// rewrite in this run (not retried until the file changes).
	refused map[string]int
}

// MigrationPending reports whether the path token migration has batches left:
// the scheduler then comes back after pathMigrationSpacing instead of its
// idle interval.
func (e *Engine) MigrationPending() bool {
	e.mu.Lock()
	defer e.mu.Unlock()
	return e.migrating
}

func (e *Engine) setMigrating(on bool) {
	e.mu.Lock()
	e.migrating = on
	e.mu.Unlock()
}

func (e *Engine) migrationBatch() int {
	if e.cfg.PathMigrationBatch > 0 {
		return e.cfg.PathMigrationBatch
	}
	return pathMigrationBatch
}

func (e *Engine) migrationSpacing() time.Duration {
	if e.cfg.PathMigrationSpacing > 0 {
		return e.cfg.PathMigrationSpacing
	}
	return pathMigrationSpacing
}

func (e *Engine) loadMigration(ctx context.Context, cloud string) pathMigrationMeta {
	var m pathMigrationMeta
	if v, _ := e.cfg.DB.Meta(ctx, metaPathMigration(cloud)); v != "" {
		_ = json.Unmarshal([]byte(v), &m) // a damaged value only restarts the counters
	}
	return m
}

func (e *Engine) saveMigration(ctx context.Context, cloud string, m pathMigrationMeta) {
	b, _ := json.Marshal(m)
	if err := e.cfg.DB.SetMeta(ctx, metaPathMigration(cloud), string(b)); err != nil {
		e.log.Warn().Err(err).Msg("sync: save path token migration progress")
	}
}

// migratePaths runs one batch of the migration when it is due (under e.run,
// at the end of an idle cycle).
func (e *Engine) migratePaths(ctx context.Context) {
	if e.cfg.Cipher == nil || e.cfg.ReadOnly || !e.cfg.Cipher.PathV2() || e.ScanDue() || e.cfg.Cipher.Locked() {
		e.setMigrating(false)
		return
	}
	cloud, _ := e.cfg.DB.Meta(ctx, MetaCloudVault)
	if cloud == "" {
		return
	}
	if e.loadPathPins(ctx); e.pathStrong {
		e.setMigrating(false)
		return
	}
	prog := e.loadMigration(ctx, cloud)
	now := e.cfg.Now()
	if now.UnixNano() < prog.Next {
		return // throttled: the scheduler keeps its plan (MigrationPending)
	}
	bctx, cancel := context.WithTimeout(ctx, pathMigrationBudget)
	pending, next := e.migrateBatch(bctx, cloud, &prog)
	cancel()
	prog.Next = now.Add(next).UnixNano()
	e.saveMigration(ctx, cloud, prog)
	e.setMigrating(pending)
}

// migrateBatch reads the tree when the queue is empty (and sets the strong
// pin when it has no enc1 token left), then rewrites one batch. It reports
// whether batches are left and the wait before the next one.
func (e *Engine) migrateBatch(ctx context.Context, cloud string, prog *pathMigrationMeta) (pending bool, next time.Duration) {
	m := &e.migration
	if len(m.queue) == 0 {
		// A new pass: progressed tells, at its end, whether to read the tree
		// again soon (files may have become free) or only after a while.
		m.progressed = false
		tree, err := e.cfg.Remote.Tree(ctx)
		if err != nil {
			// Tried again after the spacing, at the scheduler's own pace.
			e.log.Warn().Err(err).Msg("sync: path token migration: cannot read the tree")
			return false, e.migrationSpacing()
		}
		var enc1 []transport.TreeEntry
		for _, it := range tree.Items {
			if vaultcrypto.PathTokenVersion(it.Path) == 1 {
				enc1 = append(enc1, it)
			}
		}
		prog.Remaining = len(enc1)
		if len(enc1) == 0 {
			return e.strongPin(ctx, cloud, tree, prog)
		}
		m.queue = enc1
	}

	limit := e.migrationBatch()
	var ops []syncproto.Op
	var rows []File
	for len(m.queue) > 0 && len(ops) < limit {
		it := m.queue[0]
		m.queue = m.queue[1:]
		row, op, ok := e.migrationOp(ctx, it)
		if e.cfg.Cipher.Locked() {
			return false, e.migrationSpacing() // the next unlock starts again
		}
		if ok {
			ops, rows = append(ops, op), append(rows, row)
		}
	}
	if len(ops) == 0 {
		// Every enc1 file left must wait (local changes, conflicts, entries
		// this device cannot read): look again later, without hurrying the
		// scheduler.
		if m.progressed {
			return true, e.migrationSpacing()
		}
		return false, pathMigrationRecheck
	}
	resp, err := e.cfg.Remote.Commit(ctx, syncproto.CommitRequest{DeviceID: e.cfg.DeviceID, Ops: ops})
	if err == nil && len(resp.Results) != len(ops) {
		err = errMigrationAnswer
	}
	if err != nil {
		// Nothing changed locally: the files are found again in the next tree.
		e.log.Warn().Err(err).Int("files", len(ops)).Msg("sync: path token migration batch failed")
		m.queue = nil
		return false, e.migrationSpacing()
	}
	accepted := 0
	for i, res := range resp.Results {
		row := rows[i]
		switch res.Status {
		case syncproto.StatusAccepted:
			accepted++
			e.pinPathV2(ctx, row.FileID)
			// The move is ours: record its revision now (the pull skips its
			// echo). The content is unchanged, so a synced file's base moves too.
			if cur, ok, err := e.cfg.DB.GetFileByID(ctx, row.FileID); err == nil && ok && cur.ServerRev == row.ServerRev {
				cur.ServerRev = res.Rev
				if cur.State == StateSynced {
					cur.BaseRev = res.Rev
				}
				if err := e.cfg.DB.PutFile(ctx, cur); err != nil {
					e.log.Warn().Err(err).Str("file_id", row.FileID).Msg("sync: path token migration")
				}
			}
		case syncproto.StatusConflict:
			// Changed on the server meanwhile: the pull brings the change and
			// a later pass takes the file at its new revision.
		default:
			if m.refused == nil {
				m.refused = map[string]int{}
			}
			m.refused[row.FileID] = row.ServerRev
			e.log.Warn().Str("file_id", row.FileID).Str("code", string(res.Code)).Str("detail", res.Detail).Msg("sync: path token migration refused")
		}
	}
	prog.Migrated += accepted
	prog.Remaining = max(prog.Remaining-accepted, 0)
	if accepted > 0 {
		m.progressed = true
		e.log.Info().Int("files", accepted).Int("remaining", prog.Remaining).Msg("sync: path tokens rewritten in format enc2")
	}
	return true, e.migrationSpacing()
}

var errMigrationAnswer = errors.New("the server answered a different number of results")

// migrationOp builds the move that rewrites the enc1 token of a tree entry,
// or reports that the file must wait.
func (e *Engine) migrationOp(ctx context.Context, it transport.TreeEntry) (File, syncproto.Op, bool) {
	if rev, refused := e.migration.refused[it.FileID]; refused && rev == it.Rev {
		return File{}, syncproto.Op{}, false
	}
	if _, parked := e.candidates[it.FileID]; parked {
		return File{}, syncproto.Op{}, false
	}
	row, has, err := e.cfg.DB.GetFileByID(ctx, it.FileID)
	if err != nil || !has || row.State != StateSynced || row.ServerRev != it.Rev || row.Attempts > 0 || row.LastError != "" || row.Tombstoned {
		return File{}, syncproto.Op{}, false
	}
	plain, err := e.clearPath(ctx, it.FileID, it.Path)
	if err != nil || plain != row.Path {
		return File{}, syncproto.Op{}, false
	}
	tok, key, err := e.cfg.Cipher.EncryptPath(it.FileID, plain, true)
	if err != nil {
		return File{}, syncproto.Op{}, false
	}
	base := row.ServerRev
	t := e.cfg.Now()
	return row, syncproto.Op{
		OpID: uuid.Must(uuid.NewV7()).String(), Op: syncproto.OpMove, FileID: it.FileID, BaseRev: &base,
		Path: tok, PathKey: key, ClientMtime: &t,
	}, true
}

// strongPin is the end of the migration: the tree has no enc1 token. The pin
// is set only for a tree with files (an empty vault has no token to protect,
// and a client that never saw enc2 might still create its first file in enc1)
// and only once this device has applied every change up to the tree, so an
// older enc1 change still to pull is never refused.
func (e *Engine) strongPin(ctx context.Context, cloud string, tree transport.Tree, prog *pathMigrationMeta) (bool, time.Duration) {
	if len(tree.Items) == 0 {
		return false, pathMigrationRecheck
	}
	cur, err := e.cfg.DB.Cursor(ctx)
	if err != nil || cur < tree.AsOfSeq {
		return true, e.migrationSpacing() // the next cycle pulls up to the tree first
	}
	if err := e.cfg.DB.WithTx(ctx, func(tx *DB) error {
		if err := tx.SetMeta(ctx, metaPathV2(cloud), "1"); err != nil {
			return err
		}
		return tx.SetMeta(ctx, metaPathV2Strong(cloud), "1")
	}); err != nil {
		e.log.Warn().Err(err).Msg("sync: path token strong pin")
		return true, e.migrationSpacing()
	}
	e.pathV2Pinned, e.pathStrong = true, true
	prog.Done, prog.Remaining = true, 0
	e.migration = pathMigration{}
	e.log.Info().Int("files", len(tree.Items)).Msg("sync: every path token of the vault is enc2: enc1 tokens are refused from now on")
	return false, 0
}
