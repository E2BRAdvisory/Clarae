// Package composer implements the note composer: merging one note into another and
// extracting a selection into a new note (§2.2.1 "composer").
package composer

import (
	"bytes"
	"context"
	"database/sql"
	"errors"
	"fmt"
	"path"
	"strings"

	"nodus/apps/desktop/internal/links"
	"nodus/apps/desktop/internal/parser"
	"nodus/apps/desktop/internal/vault"
	"nodus/shared/pathrules"
)

// Env is what the composer needs from the application.
type Env struct {
	FS *vault.FS
	DB *sql.DB
	// Trash removes a note recoverably (OS trash or .trash/), like the Trash binding.
	Trash func(path string) error
	// Reindex refreshes the index for the given paths (may be nil).
	Reindex func(paths []string)
}

// Separators between the target's text and the appended source.
const (
	SepHeading = "heading" // "## <source title>"
	SepRule    = "rule"    // "---"
	SepNone    = "none"    // a blank line only
)

// MergeOptions tune how the source is appended.
type MergeOptions struct {
	// Separator is SepHeading (default), SepRule or SepNone.
	Separator string `json:"separator"`
}

// MergePlan is the preview of a merge: how many links are redirected.
type MergePlan struct {
	Source string `json:"source"`
	Target string `json:"target"`
	// Notes is the number of notes whose links change, Links the number of links.
	Notes int `json:"notes"`
	Links int `json:"links"`
}

// MergeResult reports a completed merge.
type MergeResult struct {
	MergePlan
	// Trashed is false when the source could not be moved to the trash after the
	// links were redirected (see ApplyMerge for the consequences).
	Trashed bool `json:"trashed"`
}

func checkPair(source, target string) (string, string, error) {
	s, err := pathrules.Normalize(source)
	if err != nil {
		return "", "", err
	}
	t, err := pathrules.Normalize(target)
	if err != nil {
		return "", "", err
	}
	if s == t {
		return "", "", errors.New("invalid: a note cannot be merged into itself")
	}
	for _, p := range []string{s, t} {
		if !strings.EqualFold(path.Ext(p), ".md") {
			return "", "", fmt.Errorf("invalid: %s is not a Markdown note", p)
		}
	}
	return s, t, nil
}

// PlanMerge previews merging source into target; nothing is changed.
func PlanMerge(ctx context.Context, env Env, source, target string) (MergePlan, error) {
	s, t, err := checkPair(source, target)
	if err != nil {
		return MergePlan{}, err
	}
	for _, p := range []string{s, t} {
		if _, err := env.FS.ReadFile(p); err != nil {
			return MergePlan{}, err
		}
	}
	plan, err := links.PlanRedirect(ctx, env.DB, env.FS, s, t)
	if err != nil {
		return MergePlan{}, err
	}
	return summarize(s, t, plan), nil
}

func summarize(s, t string, plan links.Plan) MergePlan {
	mp := MergePlan{Source: s, Target: t, Notes: len(plan.Files)}
	for _, f := range plan.Files {
		mp.Links += len(f.Edits)
	}
	return mp
}

// Appended returns the target's new content: the target, a separator and the body of
// the source (its frontmatter is dropped: the target keeps its own properties).
func Appended(target, source []byte, sourceTitle string, o MergeOptions) []byte {
	body, _, _ := parser.SplitFrontmatter(source)
	body = bytes.TrimSpace(body)
	var out bytes.Buffer
	out.Write(bytes.TrimRight(target, "\r\n \t"))
	if out.Len() > 0 {
		out.WriteString("\n\n")
	}
	switch o.Separator {
	case SepRule:
		out.WriteString("---\n\n")
	case SepNone:
	default:
		out.WriteString("## " + sourceTitle + "\n\n")
	}
	out.Write(body)
	out.WriteString("\n")
	return out.Bytes()
}

// ApplyMerge appends source to target, redirects every link to source onto target and
// moves source to the trash, in that order:
//
//  1. The target is written first (hash-guarded). If this fails nothing changed.
//  2. Links are redirected (all or nothing, see links.ApplyEdits). If this fails the
//     rewritten notes are restored and the target gets its original content back,
//     so the vault is as before.
//  3. The source is trashed. If this fails the merge is already complete in content
//     (nothing is lost): the source remains next to the target, the result reports
//     Trashed=false and the error is returned alongside, so the UI can tell the user.
//
// The index is refreshed through env.Reindex.
func ApplyMerge(ctx context.Context, env Env, source, target string, o MergeOptions) (MergeResult, error) {
	s, t, err := checkPair(source, target)
	if err != nil {
		return MergeResult{}, err
	}
	src, err := env.FS.ReadFile(s)
	if err != nil {
		return MergeResult{}, err
	}
	tgt, err := env.FS.ReadFile(t)
	if err != nil {
		return MergeResult{}, err
	}
	// Links are planned after the target is written: the target may itself contain links
	// to the source (its new content included), and the plan must carry its new hash.
	merged := Appended(tgt.Data, src.Data, strings.TrimSuffix(path.Base(s), path.Ext(s)), o)
	written, err := env.FS.WriteFile(t, merged, tgt.Hash, false)
	if err != nil {
		return MergeResult{}, err
	}
	reindex := func(paths ...string) {
		if env.Reindex != nil {
			env.Reindex(paths)
		}
	}
	redirect, err := links.PlanRedirect(ctx, env.DB, env.FS, s, t)
	if err == nil {
		err = links.ApplyEdits(env.FS, redirect)
	}
	if err != nil {
		// Restore the target; ignore a failure here, the original is also in the history.
		_, _ = env.FS.WriteFile(t, tgt.Data, written.Hash, false)
		reindex(t)
		return MergeResult{}, err
	}
	res := MergeResult{MergePlan: summarize(s, t, redirect)}
	touched := []string{s, t}
	for _, f := range redirect.Files {
		touched = append(touched, f.Path)
	}
	if err := env.Trash(s); err != nil {
		reindex(touched...)
		return res, fmt.Errorf("merged, but the source note could not be moved to the trash: %w", err)
	}
	res.Trashed = true
	reindex(touched...)
	return res, nil
}
