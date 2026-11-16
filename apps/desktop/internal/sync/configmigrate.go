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
// recreate every file it does not find. When features.config_dir_v2 is on, which is the default
// since 1.7.0 (an administrator whose vault still has devices of 1.4 or earlier turns it off until
// they are updated), the engine moves them, one file at a time, as the move of a user: same file
// id, same history, a move op with base_rev at the next cycle.
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
//
// A file whose name the current folder already has is not moved (the current one wins). When both
// are synced files of the vault, the former one is a leftover that 1.5 or 1.6 devices keep alive
// on the server: its row is deleted there (ADR-0059), by an ordinary delete op with base_rev, so
// the revision stays in the history of the server. On disk the file is deleted when its content is
// the current one's, and goes to the vault's .trash/ when it differs, so no version is lost
// silently (D-04).

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
	moved, dropped, err := e.moveConfigFiles(ctx)
	if err != nil && ctx.Err() == nil {
		e.log.Warn().Err(err).Msg("sync: move the settings to the current configuration folder")
	}
	if moved+dropped > 0 {
		e.configNext = time.Time{} // the next idle cycle takes up what is left, after the moves are pushed
		e.log.Info().Int("moved", moved).Int("dropped", dropped).Msg("sync: settings moved to the current configuration folder")
		return
	}
	e.configNext = now.Add(configMoveRecheck)
}

// moveConfigFiles moves the files of the former folders that may move now and returns how many it
// moved, and how many shadowed ones it dropped (dropShadowedConfig).
func (e *Engine) moveConfigFiles(ctx context.Context) (moved, dropped int, err error) {
	var errs []error
	for _, legacy := range pathrules.LegacyConfigDirs {
		rows, err := e.cfg.DB.FilesUnder(ctx, legacy)
		if err != nil {
			return moved, dropped, err
		}
		for _, row := range rows {
			if moved+dropped >= configMoveBatch || ctx.Err() != nil {
				return moved, dropped, errors.Join(errs...)
			}
			to, ok, shadowed := e.configMoveTarget(ctx, row)
			if shadowed {
				did, err := e.dropShadowedConfig(ctx, row, to)
				if err != nil {
					errs = append(errs, err)
				}
				if did {
					dropped++
				}
				continue
			}
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
	return moved, dropped, errors.Join(errs...)
}

// configMoveTarget returns the path in the current folder a file of a former folder moves to, and
// whether it may move now. shadowed is set when the file may not move because the current folder
// has a row of that name: to is that path (see dropShadowedConfig).
func (e *Engine) configMoveTarget(ctx context.Context, row File) (to string, ok, shadowed bool) {
	name, ok := pathrules.ConfigRel(row.Path)
	if !ok || pathrules.IsExcluded(row.Path, false) {
		return "", false, false
	}
	if !cleanSyncedRow(row) {
		return "", false, false
	}
	if _, parked := e.candidates[row.FileID]; parked {
		return "", false, false
	}
	to = pathrules.ConfigDir + "/" + name
	if _, has, err := e.cfg.DB.GetFile(ctx, to); err != nil || has {
		// The current folder has a file of that name (or its state cannot be read).
		return to, false, err == nil
	}
	return to, true, false
}

// cleanSyncedRow tells whether a row is a plain synced file: nothing to send, nothing parked.
func cleanSyncedRow(row File) bool {
	return row.State == StateSynced && row.Attempts == 0 && row.LastError == "" && !row.Tombstoned && row.ConflictOf == "" && row.LocalHash != ""
}

// dropShadowedConfig deletes the row of a settings file of a former folder whose name the current
// folder has as well (to). Both must be clean synced files whose content on disk is the one
// sync.db knows: the current one is the settings of the vault, the former one is its leftover. The
// file leaves the disk (with a copy in .trash/ when its content differs from the current one's)
// and the row becomes a local deletion, which the push sends as a delete op on base_rev. Nothing
// is done, and nothing is lost, when any of this does not hold: a later pass looks again.
func (e *Engine) dropShadowedConfig(ctx context.Context, row File, to string) (bool, error) {
	cur, has, err := e.cfg.DB.GetFile(ctx, to)
	if err != nil || !has || !cleanSyncedRow(cur) {
		return false, err
	}
	if _, parked := e.candidates[cur.FileID]; parked {
		return false, nil
	}
	// The current file must still be the one sync.db knows: an edit not yet scanned is no reason
	// to take the other copy away, and a current file that is gone is no replacement for it.
	h, _, err := e.cfg.FS.HashFile(to)
	if err != nil || h != cur.LocalHash {
		return false, nil //nolint:nilerr // a missing or changed current file only postpones the cleanup
	}
	keep := row.LocalHash != cur.LocalHash
	removed, err := e.cfg.FS.RemoveShadowedConfig(row.Path, row.LocalHash, keep)
	switch {
	case errors.Is(err, vault.ErrHashMismatch):
		return false, nil // changed since the last scan: the scan takes it
	case err != nil:
		return false, err
	case !removed:
		return false, nil
	}
	row.State, row.Dirty = StateLocalDeleted, false
	if err := e.cfg.DB.PutFile(ctx, row); err != nil {
		return false, err
	}
	e.log.Info().Str("path", row.Path).Bool("copy_kept", keep).Msg("sync: deleted the settings file of the former configuration folder, the current folder has it")
	return true, nil
}
