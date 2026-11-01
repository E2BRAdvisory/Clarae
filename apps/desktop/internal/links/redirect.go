package links

import (
	"context"
	"database/sql"
	"fmt"
	"path"
	"strings"

	"memobrain/apps/desktop/internal/parser"
	"memobrain/apps/desktop/internal/vault"
	"memobrain/shared/pathrules"
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
		if !rewritableKind(f.Kind) {
			continue
		}
		content, err := fsys.ReadFile(f.Path)
		if err != nil {
			continue // disappeared since indexing
		}
		var edits []Edit
		for _, l := range rewritableLinks(f, content.Data, strings.TrimSuffix(path.Base(f.Path), path.Ext(f.Path))) {
			if l.Kind == parser.LinkExternal || l.Target == "" || l.TargetEnd <= l.TargetStart {
				continue
			}
			var text string
			if l.exact {
				if l.Target != from {
					continue
				}
				text = to
			} else {
				target := l.Target
				if l.Kind == parser.LinkMarkdown {
					target = unescapeURL(target)
				}
				if oldR.Resolve(f.Path, target) != from {
					continue
				}
				text = bestTarget(newR, f.Path, to, l.Kind == parser.LinkMarkdown, target)
				if l.Kind == parser.LinkMarkdown {
					text = escapeURL(text)
				}
			}
			if l.safe != nil && !l.safe(text) {
				continue
			}
			if old := string(content.Data[l.TargetStart:l.TargetEnd]); text != old {
				edits = append(edits, Edit{Line: l.Line, Start: l.TargetStart, End: l.TargetEnd, Old: old, New: text})
			}
		}
		if len(edits) > 0 {
			plan.Files = append(plan.Files, FileEdit{Path: f.Path, Hash: content.Hash, Edits: dedupeEdits(edits)})
		}
	}
	return plan, nil
}

// ApplyEdits writes the edits of a plan (without moving anything). If a note changed
// since planning or a write fails, the notes already rewritten are restored (unless
// they changed again meanwhile), so the call is all or nothing; notes that could not
// be restored are named in the error. The caller refreshes the index.
func ApplyEdits(fsys *vault.FS, plan Plan) error {
	_, err := writeEdits(fsys, plan.Files)
	return err
}
