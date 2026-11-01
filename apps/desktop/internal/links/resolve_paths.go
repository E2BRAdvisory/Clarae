package links

import (
	"context"
	"database/sql"
	"strings"
)

// ResolvePaths fills links.target_resolved for the links written in the given
// notes only, using an existing resolver. It is the cheap counterpart of
// ResolveAll for edits that do not change which files or aliases exist (the
// resolver stays valid), so a save costs O(links of the note), not O(vault).
func ResolvePaths(ctx context.Context, db *sql.DB, r *Resolver, paths []string) error {
	return ResolveAffected(ctx, db, r, Change{Paths: paths})
}

// Change describes an update of the index for ResolveAffected.
type Change struct {
	// Tokens are the FileTokens of the files that appeared or disappeared and
	// the AliasTokens of the aliases added or removed.
	Tokens []string
	// Removed are the paths that disappeared.
	Removed []string
	// Paths are the notes (re)indexed: all their links are resolved.
	Paths []string
}

// ResolveAffected re-resolves, with r built on the new file set, every link
// whose resolution the change can have altered, and writes the ones that
// differ: the links of ch.Paths, the links whose target_key is one of
// ch.Tokens (see keys.go for why no other link can change), the links whose
// key is WildcardKey or not computed yet and, as a safety net, the links that
// pointed at a removed path. The result equals a ResolveAll.
func ResolveAffected(ctx context.Context, db *sql.DB, r *Resolver, ch Change) error {
	seen := map[int64]bool{}
	var todo []linkRow
	add := func(rows []linkRow) {
		for _, x := range rows {
			if !seen[x.rowid] {
				seen[x.rowid] = true
				todo = append(todo, x)
			}
		}
	}
	query := func(where string, args []string) error {
		for len(args) > 0 {
			n := min(len(args), 400)
			params := make([]any, n)
			for i, a := range args[:n] {
				params[i] = a
			}
			rows, err := queryLinkRows(ctx, db, `kind <> 'external' AND `+where+` IN (`+placeholders(n)+`)`, params...)
			if err != nil {
				return err
			}
			add(rows)
			args = args[n:]
		}
		return nil
	}
	if err := query("path", dedupe(ch.Paths)); err != nil {
		return err
	}
	if len(ch.Tokens) > 0 || len(ch.Removed) > 0 {
		if err := query("target_key", dedupe(ch.Tokens)); err != nil {
			return err
		}
		if err := query("target_resolved", dedupe(ch.Removed)); err != nil {
			return err
		}
		rows, err := queryLinkRows(ctx, db, `kind <> 'external' AND (target_key = '`+WildcardKey+`' OR target_key IS NULL)`)
		if err != nil {
			return err
		}
		add(rows)
	}
	return writeResolved(ctx, db, r, todo)
}

// linkRow is a link as needed to resolve it.
type linkRow struct {
	rowid          int64
	src, kind, raw string
	resolved       string // "" = NULL
	key            sql.NullString
}

func queryLinkRows(ctx context.Context, db *sql.DB, where string, params ...any) ([]linkRow, error) {
	rows, err := db.QueryContext(ctx, `SELECT rowid, path, kind, target_raw, COALESCE(target_resolved, ''), target_key FROM links WHERE `+where, params...) //nolint:gosec // where is built from constants
	if err != nil {
		return nil, err
	}
	defer func() { _ = rows.Close() }()
	var out []linkRow
	for rows.Next() {
		var x linkRow
		if err := rows.Scan(&x.rowid, &x.src, &x.kind, &x.raw, &x.resolved, &x.key); err != nil {
			return nil, err
		}
		out = append(out, x)
	}
	return out, rows.Err()
}

// writeResolved resolves the rows with r and writes those whose target
// changed, together with the target_key of the rows that have none.
func writeResolved(ctx context.Context, db *sql.DB, r *Resolver, todo []linkRow) error {
	type update struct {
		rowid    int64
		resolved any
		key      string
		setKey   bool
	}
	var updates []update
	for _, x := range todo {
		p := r.Resolve(x.src, x.raw)
		if p == x.resolved && x.key.Valid {
			continue
		}
		u := update{rowid: x.rowid, setKey: !x.key.Valid}
		if p != "" {
			u.resolved = p
		}
		if u.setKey {
			u.key = LinkKey(x.src, x.kind, x.raw)
		}
		updates = append(updates, u)
	}
	if len(updates) == 0 {
		return nil
	}
	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback() }()
	setTarget, err := tx.PrepareContext(ctx, `UPDATE links SET target_resolved = ? WHERE rowid = ?`)
	if err != nil {
		return err
	}
	defer func() { _ = setTarget.Close() }()
	setBoth, err := tx.PrepareContext(ctx, `UPDATE links SET target_resolved = ?, target_key = ? WHERE rowid = ?`)
	if err != nil {
		return err
	}
	defer func() { _ = setBoth.Close() }()
	for _, u := range updates {
		if u.setKey {
			_, err = setBoth.ExecContext(ctx, u.resolved, u.key, u.rowid)
		} else {
			_, err = setTarget.ExecContext(ctx, u.resolved, u.rowid)
		}
		if err != nil {
			return err
		}
	}
	return tx.Commit()
}

func placeholders(n int) string {
	return strings.TrimSuffix(strings.Repeat("?,", n), ",")
}

func dedupe(in []string) []string {
	seen := make(map[string]bool, len(in))
	out := make([]string, 0, len(in))
	for _, s := range in {
		if !seen[s] {
			seen[s] = true
			out = append(out, s)
		}
	}
	return out
}
