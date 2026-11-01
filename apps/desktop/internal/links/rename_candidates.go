package links

import (
	"context"
	"database/sql"

	"memobrain/apps/desktop/internal/vault"
)

// renameCandidates selects, from the index, the notes and drawings a rename
// may have to edit, so PlanRename does not read and parse the whole vault.
//
// A note that stays where it is gets an edit only for a link that resolved
// to some file before the move and must be rewritten after it: either its
// target moved, or the link would now resolve to another file. In both cases
// one of the lookups of the link returned a moved file, at its old path
// before or at its new path after the move, so the link's target_key is a
// token of that file (see keys.go): of its old path, of its new path or of one
// of its aliases. The candidates are therefore
//
//   - every moved note: it resolves its own links from a new folder;
//   - the notes with a link whose key is one of those tokens, WildcardKey or
//     not computed yet;
//   - as a safety net, the notes with a link that resolved into the moved set;
//   - every note changed on disk since it was indexed (another size or mtime,
//     e.g. an external edit the watcher has not delivered yet): its indexed
//     links may be out of date;
//   - every drawing: a rename rewrites the [[links]] found anywhere in its JSON
//     (scanDrawingLinks), more than the index extracts from its elements.
//
// Markdown link keys also cover the URL-unescaped target PlanRename resolves.
func renameCandidates(ctx context.Context, db *sql.DB, fsys *vault.FS, files []File, moves map[string]string) (map[string]bool, error) {
	out := map[string]bool{}
	var tokens, moved []string
	for _, f := range files {
		np, ok := moves[f.Path]
		if !ok {
			if f.Kind == "excalidraw" {
				out[f.Path] = true
			}
			continue
		}
		out[f.Path] = true
		moved = append(moved, f.Path)
		tokens = append(tokens, FileTokens(f.Path, f.Aliases)...)
		tokens = append(tokens, nameToken(np))
	}
	collect := func(where string, params ...any) error {
		rows, err := db.QueryContext(ctx, `SELECT DISTINCT path FROM links WHERE kind <> 'external' AND `+where, params...) //nolint:gosec // where is built from constants
		if err != nil {
			return err
		}
		defer func() { _ = rows.Close() }()
		for rows.Next() {
			var p string
			if err := rows.Scan(&p); err != nil {
				return err
			}
			out[p] = true
		}
		return rows.Err()
	}
	collectIn := func(column string, args []string) error {
		for len(args) > 0 {
			n := min(len(args), 400)
			params := make([]any, n)
			for i, a := range args[:n] {
				params[i] = a
			}
			if err := collect(column+` IN (`+placeholders(n)+`)`, params...); err != nil {
				return err
			}
			args = args[n:]
		}
		return nil
	}
	if err := collectIn("target_key", dedupe(tokens)); err != nil {
		return nil, err
	}
	if err := collect("(target_key = '" + WildcardKey + "' OR target_key IS NULL)"); err != nil {
		return nil, err
	}
	if err := collectIn("target_resolved", moved); err != nil {
		return nil, err
	}
	if err := addStale(ctx, db, fsys, out); err != nil {
		return nil, err
	}
	return out, nil
}

// addStale adds the notes whose size or mtime on disk differ from the index.
func addStale(ctx context.Context, db *sql.DB, fsys *vault.FS, out map[string]bool) error {
	type stat struct{ mtime, size int64 }
	indexed := map[string]stat{}
	rows, err := db.QueryContext(ctx, `SELECT path, mtime_ns, size FROM files WHERE kind = 'md'`)
	if err != nil {
		return err
	}
	for rows.Next() {
		var p string
		var s stat
		if err := rows.Scan(&p, &s.mtime, &s.size); err != nil {
			_ = rows.Close()
			return err
		}
		indexed[p] = s
	}
	if err := rows.Close(); err != nil {
		return err
	}
	return fsys.Walk(func(e vault.Entry) error {
		if s, ok := indexed[e.Path]; ok && !e.IsDir && (s.mtime != e.Mtime.UnixNano() || s.size != e.Size) {
			out[e.Path] = true
		}
		return nil
	})
}
