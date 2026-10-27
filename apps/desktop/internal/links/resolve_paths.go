package links

import (
	"context"
	"database/sql"
)

// ResolvePaths fills links.target_resolved for the links written in the given
// notes only, using an existing resolver. It is the cheap counterpart of
// ResolveAll for edits that do not change which files or aliases exist (the
// resolver stays valid), so a save costs O(links of the note), not O(vault).
func ResolvePaths(ctx context.Context, db *sql.DB, r *Resolver, paths []string) error {
	if len(paths) == 0 {
		return nil
	}
	type row struct {
		rowid    int64
		src, raw string
	}
	var todo []row
	for _, p := range paths {
		rows, err := db.QueryContext(ctx, `SELECT rowid, path, target_raw FROM links WHERE path = ? AND kind <> 'external'`, p)
		if err != nil {
			return err
		}
		for rows.Next() {
			var x row
			if err := rows.Scan(&x.rowid, &x.src, &x.raw); err != nil {
				_ = rows.Close()
				return err
			}
			todo = append(todo, x)
		}
		if err := rows.Close(); err != nil {
			return err
		}
	}
	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback() }()
	stmt, err := tx.PrepareContext(ctx, `UPDATE links SET target_resolved = ? WHERE rowid = ?`)
	if err != nil {
		return err
	}
	defer func() { _ = stmt.Close() }()
	for _, x := range todo {
		var resolved any
		if p := r.Resolve(x.src, x.raw); p != "" {
			resolved = p
		}
		if _, err := stmt.ExecContext(ctx, resolved, x.rowid); err != nil {
			return err
		}
	}
	return tx.Commit()
}
