package links

import (
	"context"
	"database/sql"
	"fmt"
	"path"
	"strings"

	"nodus/apps/desktop/internal/parser"
	"nodus/apps/desktop/internal/vault"
	"nodus/shared/pathrules"
)

// PlanRedirect computes the edits that make every link to the note `from` point at
// the note `to` instead (used when `from` is merged into `to` and goes away). It
// reuses the rename machinery: a link is rewritten to the shortest unambiguous form
// that resolves to `to` once `from` no longer exists. The note `from` itself is
// never edited (it is about to disappear). Plan.Moves is empty; nothing is written.
func PlanRedirect(ctx context.Context, db *sql.DB, fsys *vault.FS, from, to string) (Plan, error) {
	from, err := pathrules.Normalize(from)
	if err != nil {
		return Plan{}, err
	}
	to, err = pathrules.Normalize(to)
	if err != nil {
		return Plan{}, err
	}
	if from == to {
		return Plan{}, fmt.Errorf("source and destination are equal")
	}
	files, err := LoadFiles(ctx, db)
	if err != nil {
		return Plan{}, err
	}
	var after []File
	for _, f := range files {
		if f.Path != from {
			after = append(after, f)
		}
	}
	oldR, newR := NewResolver(files), NewResolver(after)
	plan := Plan{From: from, To: to, Moves: []Move{}, Files: []FileEdit{}}
	for _, f := range after {
		if f.Kind != "md" {
			continue
		}
		content, err := fsys.ReadFile(f.Path)
		if err != nil {
			continue // disappeared since indexing
		}
		doc := parser.Parse(strings.TrimSuffix(path.Base(f.Path), path.Ext(f.Path)), content.Data)
		var edits []Edit
		for _, l := range doc.Links {
			if l.Kind == parser.LinkExternal || l.Target == "" || l.TargetEnd <= l.TargetStart {
				continue
			}
			target := l.Target
			if l.Kind == parser.LinkMarkdown {
				target = unescapeURL(target)
			}
			if oldR.Resolve(f.Path, target) != from {
				continue
			}
			text := bestTarget(newR, f.Path, to, l.Kind == parser.LinkMarkdown, target)
			if l.Kind == parser.LinkMarkdown {
				text = escapeURL(text)
			}
			old := string(content.Data[l.TargetStart:l.TargetEnd])
			if text != old {
				edits = append(edits, Edit{Line: l.Line, Start: l.TargetStart, End: l.TargetEnd, Old: old, New: text})
			}
		}
		if len(edits) > 0 {
			plan.Files = append(plan.Files, FileEdit{Path: f.Path, Hash: content.Hash, Edits: edits})
		}
	}
	return plan, nil
}

// ApplyEdits writes the edits of a plan (without moving anything). If a note changed
// since planning or a write fails, the notes already rewritten are restored, so the
// call is all or nothing. The caller refreshes the index.
func ApplyEdits(fsys *vault.FS, plan Plan) error {
	type saved struct {
		path string
		data []byte
	}
	var done []saved
	rollback := func() {
		for i := len(done) - 1; i >= 0; i-- {
			_, _ = fsys.WriteFile(done[i].path, done[i].data, "", false)
		}
	}
	for _, fe := range plan.Files {
		cur, err := fsys.ReadFile(fe.Path)
		if err != nil {
			rollback()
			return err
		}
		if cur.Hash != fe.Hash {
			rollback()
			return fmt.Errorf("%w: %s", ErrStalePlan, fe.Path)
		}
		data, err := applyEdits(cur.Data, fe.Edits)
		if err != nil {
			rollback()
			return err
		}
		if _, err := fsys.WriteFile(fe.Path, data, fe.Hash, false); err != nil {
			rollback()
			return err
		}
		done = append(done, saved{fe.Path, cur.Data})
	}
	return nil
}
