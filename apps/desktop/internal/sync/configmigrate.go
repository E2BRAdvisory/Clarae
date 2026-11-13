package sync

import (
	"context"
	"errors"
	"time"

	"clarae/apps/desktop/internal/vault"
	"clarae/shared/pathrules"
)

// Move of the synchronized settings to the current configuration folder (ADR-0052, M17 C3).
//
// A vault linked to the cloud keeps its settings (editor.json, hotkeys.json, ...) in the former
// folder as long as a 1.x client may share it: that client does not know the new name and would
// recreate every file it does not find. When features.config_dir_v2 is on, which an administrator
// does once every device of the vault runs 2.x, the engine moves them, one file at a time, as the
// move of a user: same file id, same history, a move op with base_rev at the next cycle.
//
// Like the migration of the path tokens (pathmigrate.go) it never gets in the way of the
// synchronization and needs no state of its own:
//   - it runs under e.run at the end of a cycle that found nothing else to do, never for a viewer
//     of a share, a locked vault or while a scan is due;
//   - it touches only a file that is synced here and on the server (no local change, no parked
//     remote change, no conflict, no error, not in quarantine), whose content on disk is still the
//     one sync.db knows, and whose name is free in the current folder: when the current folder has
//     the file already it is left alone, and the former one stays as it is;
//   - the progress is the disk: a crash, or a restart in the middle, leaves files in one folder or
//     in the other, each with its row; the next pass takes up what is left;
//   - a failure is logged and never fails the cycle.

const (
	// configMoveBatch is the largest number of files moved in one pass.
	configMoveBatch = 64
	// configMoveRecheck is the wait before looking again after a pass that moved nothing: a
	// 1.x client may still put files in the former folder.
	configMoveRecheck = time.Minute
)

// migrateConfigDir runs one pass of the move when it is due (under e.run, at the end of an idle
// cycle).
func (e *Engine) migrateConfigDir(ctx context.Context) {
	if e.cfg.ConfigDirV2 == nil || !e.cfg.ConfigDirV2() || e.cfg.ReadOnly || e.ScanDue() {
		return
	}
	if e.cfg.Cipher != nil && e.cfg.Cipher.Locked() {
		return // the moves could not be pushed until the next unlock
	}
	now := e.cfg.Now()
	if now.Before(e.configNext) {
		return
	}
	moved, err := e.moveConfigFiles(ctx)
	if err != nil && ctx.Err() == nil {
		e.log.Warn().Err(err).Msg("sync: move the settings to the current configuration folder")
	}
	if moved > 0 {
		e.configNext = time.Time{} // the next idle cycle takes up what is left, after the moves are pushed
		e.log.Info().Int("files", moved).Msg("sync: settings moved to the current configuration folder")
		return
	}
	e.configNext = now.Add(configMoveRecheck)
}

// moveConfigFiles moves the files of the former folders that may move now and returns how many it
// moved.
func (e *Engine) moveConfigFiles(ctx context.Context) (int, error) {
	moved := 0
	var errs []error
	for _, legacy := range pathrules.LegacyConfigDirs {
		rows, err := e.cfg.DB.FilesUnder(ctx, legacy)
		if err != nil {
			return moved, err
		}
		for _, row := range rows {
			if moved >= configMoveBatch || ctx.Err() != nil {
				return moved, errors.Join(errs...)
			}
			to, ok := e.configMoveTarget(ctx, row)
			if !ok {
				continue
			}
			dst, did, err := e.cfg.FS.MoveConfig(row.Path, row.LocalHash)
			switch {
			case errors.Is(err, vault.ErrHashMismatch):
				continue // changed since the last scan: the scan takes it, a later pass moves it
			case err != nil:
				errs = append(errs, err)
				continue
			case !did:
				continue
			}
			if dst != to {
				errs = append(errs, errors.New("the settings file moved to an unexpected path: "+dst))
			}
			// The rename is done on disk: the hint keeps the identity of the file (without it the
			// next scan would see a deletion and a new file). Never skipped, never retried.
			if err := e.applyRename(ctx, row.Path, dst); err != nil {
				errs = append(errs, err)
			}
			moved++
		}
	}
	return moved, errors.Join(errs...)
}

// configMoveTarget returns the path in the current folder a file of a former folder moves to, and
// whether it may move now.
func (e *Engine) configMoveTarget(ctx context.Context, row File) (string, bool) {
	name, ok := pathrules.ConfigRel(row.Path)
	if !ok || pathrules.IsExcluded(row.Path, false) {
		return "", false
	}
	if row.State != StateSynced || row.Attempts > 0 || row.LastError != "" || row.Tombstoned || row.ConflictOf != "" || row.LocalHash == "" {
		return "", false
	}
	if _, parked := e.candidates[row.FileID]; parked {
		return "", false
	}
	to := pathrules.ConfigDir + "/" + name
	if _, has, err := e.cfg.DB.GetFile(ctx, to); err != nil || has {
		return "", false // the current folder has a file of that name (or its state cannot be read)
	}
	return to, true
}
