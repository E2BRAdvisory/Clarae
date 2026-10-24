package links

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"path"
	"path/filepath"
	"sort"
	"strings"

	"nodus/apps/desktop/internal/parser"
	"nodus/apps/desktop/internal/vault"
	"nodus/shared/pathrules"
)

// Move is one file that changes path.
type Move struct {
	From string `json:"from"`
	To   string `json:"to"`
}

// Edit replaces bytes [Start, End) of a note with New.
type Edit struct {
	Line  int    `json:"line"`
	Start int    `json:"start"`
	End   int    `json:"end"`
	Old   string `json:"old"`
	New   string `json:"new"`
}

// FileEdit groups the edits of one note, applied at its path *before* the
// rename. Hash is the content hash the plan was computed on.
type FileEdit struct {
	Path  string `json:"path"`
	Hash  string `json:"hash"`
	Edits []Edit `json:"edits"`
}

// Plan is the preview of a rename: which files move and which notes get
// their links rewritten (§2.5 "links": preview of impacted files).
type Plan struct {
	From  string     `json:"from"`
	To    string     `json:"to"`
	Moves []Move     `json:"moves"`
	Files []FileEdit `json:"files"`
}

// ErrStalePlan means a note changed after the plan was computed.
var ErrStalePlan = errors.New("a note changed since the rename was planned")

// PlanRename computes the effect of renaming or moving a file or folder
// (from → to): every link that would stop pointing at the right file is
// rewritten to the shortest unambiguous form. Nothing is written.
func PlanRename(ctx context.Context, db *sql.DB, fsys *vault.FS, from, to string) (Plan, error) {
	from, err := pathrules.Normalize(from)
	if err != nil {
		return Plan{}, err
	}
	to, err = pathrules.Normalize(to)
	if err != nil {
		return Plan{}, err
	}
	if from == to {
		return Plan{}, errors.New("source and destination are equal")
	}
	if pathrules.HasPrefix(to, from) {
		return Plan{}, errors.New("cannot move a folder into itself")
	}
	files, err := LoadFiles(ctx, db)
	if err != nil {
		return Plan{}, err
	}
	moves := map[string]string{}
	var newFiles []File
	for _, f := range files {
		if np, ok := pathrules.Rebase(f.Path, from, to); ok {
			moves[f.Path] = np
			f.Path = np
		}
		newFiles = append(newFiles, f)
	}
	plan := Plan{From: from, To: to, Moves: []Move{}, Files: []FileEdit{}}
	for old, nw := range moves {
		plan.Moves = append(plan.Moves, Move{From: old, To: nw})
	}
	sort.Slice(plan.Moves, func(i, j int) bool { return plan.Moves[i].From < plan.Moves[j].From })
	if len(moves) == 0 {
		return plan, nil // not indexed (e.g. an empty folder): nothing refers to it
	}

	oldR, newR := NewResolver(files), NewResolver(newFiles)
	for _, f := range files {
		if f.Kind != "md" {
			continue
		}
		content, err := fsys.ReadFile(f.Path)
		if err != nil {
			continue // disappeared since indexing
		}
		newSelf := f.Path
		if np, ok := moves[f.Path]; ok {
			newSelf = np
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
			oldTarget := oldR.Resolve(f.Path, target)
			if oldTarget == "" {
				continue // ghost link: leave it alone
			}
			newTarget := oldTarget
			if np, ok := moves[oldTarget]; ok {
				newTarget = np
			}
			if newR.Resolve(newSelf, target) == newTarget {
				continue // still resolves to the right file
			}
			text := bestTarget(newR, newSelf, newTarget, l.Kind == parser.LinkMarkdown, target)
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

// bestTarget picks the text to write inside a link so that it resolves to
// newTarget from newSelf: the plain name when unambiguous, else the path.
func bestTarget(r *Resolver, from, target string, markdown bool, original string) string {
	isNote := strings.EqualFold(path.Ext(target), ".md")
	strip := func(p string) string {
		if isNote && (!markdown || !strings.HasSuffix(strings.ToLower(original), ".md")) {
			return strings.TrimSuffix(p, path.Ext(p))
		}
		return p
	}
	// A Markdown link written as a relative path stays relative.
	if markdown && (strings.HasPrefix(original, "./") || strings.HasPrefix(original, "../")) {
		if rel, err := filepath.Rel(filepath.FromSlash(path.Dir(from)), filepath.FromSlash(target)); err == nil {
			rel = filepath.ToSlash(rel)
			if !strings.HasPrefix(rel, "../") {
				rel = "./" + rel
			}
			if r.Resolve(from, rel) == target {
				return rel
			}
		}
	}
	// Markdown links are conventionally path based; wikilinks prefer the name.
	cands := []string{strip(path.Base(target)), strip(target)}
	if markdown {
		cands = []string{strip(target)}
	}
	for _, c := range cands {
		if r.Resolve(from, c) == target {
			return c
		}
	}
	return strip(target)
}

func unescapeURL(s string) string { return strings.ReplaceAll(s, "%20", " ") }
func escapeURL(s string) string   { return strings.ReplaceAll(s, " ", "%20") }

// ApplyRename executes the plan: rewrites the affected notes (at their old
// paths), then moves the file or folder. If anything fails, rewritten notes
// are restored, so a rename is all or nothing. The caller refreshes the index.
func ApplyRename(fsys *vault.FS, plan Plan) error {
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
	if err := fsys.Rename(plan.From, plan.To); err != nil {
		rollback()
		return err
	}
	return nil
}

func applyEdits(data []byte, edits []Edit) ([]byte, error) {
	sorted := append([]Edit(nil), edits...)
	sort.Slice(sorted, func(i, j int) bool { return sorted[i].Start > sorted[j].Start })
	out := append([]byte(nil), data...)
	prevStart := len(out) + 1
	for _, e := range sorted {
		if e.Start < 0 || e.End > len(out) || e.Start > e.End || e.End > prevStart {
			return nil, fmt.Errorf("invalid edit range %d-%d", e.Start, e.End)
		}
		if string(out[e.Start:e.End]) != e.Old {
			return nil, ErrStalePlan
		}
		out = append(out[:e.Start], append([]byte(e.New), out[e.End:]...)...)
		prevStart = e.Start
	}
	return out, nil
}
