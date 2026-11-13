package app

import (
	"context"
	"database/sql"
	"os"
	"path/filepath"
	"runtime"
	"strings"
)

// adoptLegacyDataDir points what the application database remembers at the data directory it was
// moved to. The recent vaults hold absolute paths, and some vaults live inside the data directory
// (the mounts of the shares, the folders kept after a share was left): after the move from the
// folder of 1.x their paths lead nowhere. The id of a vault is the hash of its path, so a moved
// vault has a new id; the sync state of a mount is in the mount (its own .clarae folder), not here.
// It runs at every start and does nothing when there is nothing to do, so a start that stopped
// after the move and before this finds the work still to do.
func (a *App) adoptLegacyDataDir(ctx context.Context) {
	if a.opts.LegacyDataDir == "" {
		return
	}
	n, err := rewriteRecentVaultPaths(ctx, a.appDB, a.opts.LegacyDataDir, a.opts.DataDir)
	if err != nil {
		a.logger.Warn().Err(err).Msg("recent vaults of the previous version not updated")
		return
	}
	if n > 0 {
		a.logger.Info().Int("vaults", n).Msg("recent vaults moved with the data directory")
	}
}

// rewriteRecentVaultPaths replaces the directory from by to at the start of the paths in
// recent_vaults, in one transaction, and returns how many it changed. A path that was already
// remembered under the new name keeps the later of the two dates and the older entry goes.
func rewriteRecentVaultPaths(ctx context.Context, db *sql.DB, from, to string) (int, error) {
	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		return 0, err
	}
	defer func() { _ = tx.Rollback() }()
	rows, err := tx.QueryContext(ctx, `SELECT path, name, last_opened_at FROM recent_vaults`)
	if err != nil {
		return 0, err
	}
	type row struct{ path, name, at string }
	var moved []row
	for rows.Next() {
		var r row
		if err := rows.Scan(&r.path, &r.name, &r.at); err != nil {
			_ = rows.Close()
			return 0, err
		}
		if rel, ok := relativeTo(r.path, from); ok && !stillInPlace(r.path, filepath.Join(to, rel)) {
			moved = append(moved, r)
		}
	}
	if err := rows.Err(); err != nil {
		_ = rows.Close()
		return 0, err
	}
	_ = rows.Close()
	for _, r := range moved {
		rel, _ := relativeTo(r.path, from)
		if _, err := tx.ExecContext(ctx, `
			INSERT INTO recent_vaults (path, name, last_opened_at) VALUES (?, ?, ?)
			ON CONFLICT(path) DO UPDATE SET last_opened_at = MAX(last_opened_at, excluded.last_opened_at)`,
			filepath.Join(to, rel), r.name, r.at); err != nil {
			return 0, err
		}
		if _, err := tx.ExecContext(ctx, `DELETE FROM recent_vaults WHERE path = ?`, r.path); err != nil {
			return 0, err
		}
	}
	return len(moved), tx.Commit()
}

// stillInPlace is a vault that is where the old path says and not where the new one would be: the
// old folder was left alone (it was not moved, the new data directory was started on its own) and
// the entry is true as it is.
func stillInPlace(oldPath, newPath string) bool {
	if _, err := os.Stat(oldPath); err != nil {
		return false
	}
	_, err := os.Stat(newPath)
	return err != nil
}

// relativeTo returns path relative to dir when path is inside dir (not dir itself). Windows paths
// compare without regard to case.
func relativeTo(path, dir string) (string, bool) {
	path, dir = filepath.Clean(path), filepath.Clean(dir)
	prefix := dir + string(filepath.Separator)
	if len(path) <= len(prefix) {
		return "", false
	}
	head := path[:len(prefix)]
	if head != prefix && (runtime.GOOS != "windows" || !strings.EqualFold(head, prefix)) {
		return "", false
	}
	return path[len(prefix):], true
}
