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

	"memobrain/apps/desktop/internal/parser"
	"memobrain/apps/desktop/internal/vault"
	"memobrain/shared/pathrules"
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
// rewritten to the shortest unambiguous form. Nothing is written. Only the
// notes the index designates as candidates are read (renameCandidates); the
// result is the same as reading every note.
func PlanRename(ctx context.Context, db *sql.DB, fsys *vault.FS, from, to string) (Plan, error) {
	return planRename(ctx, db, fsys, from, to, renameCandidates)
}

// planRenameFull is PlanRename reading every note and drawing of the index
// (the reference the candidate selection is tested against).
func planRenameFull(ctx context.Context, db *sql.DB, fsys *vault.FS, from, to string) (Plan, error) {
	return planRename(ctx, db, fsys, from, to, nil)
}

// candidateFunc returns the paths of the files a rename may have to edit
// (nil candidates: every file).
type candidateFunc func(ctx context.Context, db *sql.DB, fsys *vault.FS, files []File, moves map[string]string) (map[string]bool, error)

func planRename(ctx context.Context, db *sql.DB, fsys *vault.FS, from, to string, candidates candidateFunc) (Plan, error) {
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
	var include map[string]bool
	if candidates != nil {
		if include, err = candidates(ctx, db, fsys, files, moves); err != nil {
			return Plan{}, err
		}
	}

	oldR, newR := NewResolver(files), NewResolver(newFiles)
	for _, f := range files {
		if !rewritableKind(f.Kind) {
			continue
		}
		if include != nil && !include[f.Path] {
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
		var edits []Edit
		for _, l := range rewritableLinks(f, content.Data, strings.TrimSuffix(path.Base(f.Path), path.Ext(f.Path))) {
			if l.Kind == parser.LinkExternal || l.Target == "" || l.TargetEnd <= l.TargetStart {
				continue
			}
			var text string
			if l.exact {
				np, ok := moves[l.Target]
				if !ok {
					continue // a canvas file node names its file by path: only a move changes it
				}
				text = np
			} else {
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
				text = bestTarget(newR, newSelf, newTarget, l.Kind == parser.LinkMarkdown, target)
				if l.Kind == parser.LinkMarkdown {
					text = escapeURL(text)
				}
			}
			if l.safe != nil && !l.safe(text) {
				continue // would need escaping where it is written: leave the link as it is
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

// rewritableKind reports the kinds of files whose links a rename rewrites.
func rewritableKind(kind string) bool {
	return kind == "md" || kind == "excalidraw" || kind == "canvas"
}

// dedupeEdits drops an edit of a range another edit already covers (a link
// found by two scanners) and keeps them in file order.
func dedupeEdits(edits []Edit) []Edit {
	sort.SliceStable(edits, func(i, j int) bool { return edits[i].Start < edits[j].Start })
	out := edits[:0]
	end := -1
	for _, e := range edits {
		if e.Start < end {
			continue
		}
		out = append(out, e)
		end = e.End
	}
	return out
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
// paths), then moves the file or folder. If anything fails, the rewritten
// notes are restored, so a rename is all or nothing; a note that changed
// again meanwhile (a sync pull, an editor) is not overwritten by the restore,
// and every note that could not be restored is named in the error. The caller
// refreshes the index.
func ApplyRename(fsys *vault.FS, plan Plan) error {
	restore, err := writeEdits(fsys, plan.Files)
	if err != nil {
		return err
	}
	if testHookBeforeMove != nil {
		testHookBeforeMove()
	}
	if err := fsys.Rename(plan.From, plan.To); err != nil {
		return restore(err)
	}
	return nil
}

// testHookBeforeMove runs between the rewrites and the move of ApplyRename (tests).
var testHookBeforeMove func()

// writeEdits rewrites the files of a plan, all or nothing: on failure the
// files already written are restored and the error says so. On success it
// returns restore, which undoes the writes if a later step (cause) fails.
func writeEdits(fsys *vault.FS, files []FileEdit) (restore func(cause error) error, err error) {
	type saved struct {
		path    string
		data    []byte
		written string // hash of what this rename wrote
	}
	var done []saved
	restore = func(cause error) error {
		var failed []error
		for i := len(done) - 1; i >= 0; i-- {
			// Conditional on what was written: content changed since then
			// is newer than the rename and must not be lost (D-04).
			if _, err := fsys.WriteFile(done[i].path, done[i].data, done[i].written, false); err != nil {
				failed = append(failed, fmt.Errorf("%s not restored: %w", done[i].path, err))
			}
		}
		if len(failed) == 0 {
			return cause
		}
		return errors.Join(append([]error{cause, ErrPartialRollback}, failed...)...)
	}
	for _, fe := range files {
		cur, err := fsys.ReadFile(fe.Path)
		if err != nil {
			return nil, restore(err)
		}
		if cur.Hash != fe.Hash {
			return nil, restore(fmt.Errorf("%w: %s", ErrStalePlan, fe.Path))
		}
		data, err := applyEdits(cur.Data, fe.Edits)
		if err != nil {
			return nil, restore(err)
		}
		c, err := fsys.WriteFile(fe.Path, data, fe.Hash, false)
		if err != nil {
			return nil, restore(err)
		}
		done = append(done, saved{fe.Path, cur.Data, c.Hash})
	}
	return restore, nil
}

// ErrPartialRollback means a failed rename or merge could not restore every
// note it had already rewritten (the error lists them).
var ErrPartialRollback = errors.New("some rewritten notes could not be restored")

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
