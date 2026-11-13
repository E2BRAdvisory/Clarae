package links_test

import (
	"context"
	"errors"
	"path/filepath"
	"strings"
	"testing"

	"github.com/rs/zerolog"

	"clarae/apps/desktop/internal/indexer"
	"clarae/apps/desktop/internal/links"
	"clarae/apps/desktop/internal/store"
	"clarae/apps/desktop/internal/vault"
)

type renameEnv struct {
	t    *testing.T
	ctx  context.Context
	fsys *vault.FS
	ix   *indexer.Indexer
}

func newRenameEnv(t *testing.T, files map[string]string) *renameEnv {
	t.Helper()
	ctx := context.Background()
	root := t.TempDir()
	fsys, err := vault.NewFS(root)
	if err != nil {
		t.Fatal(err)
	}
	db, err := store.Open(ctx, filepath.Join(root, ".clarae", "index.db"), store.KindIndex)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = db.Close() })
	for p, c := range files {
		if _, err := fsys.WriteFile(p, []byte(c), "", false); err != nil {
			t.Fatal(err)
		}
	}
	ix := indexer.New(fsys, db, zerolog.Nop(), nil)
	if err := ix.Full(ctx); err != nil {
		t.Fatal(err)
	}
	return &renameEnv{t: t, ctx: ctx, fsys: fsys, ix: ix}
}

func (e *renameEnv) read(p string) string {
	e.t.Helper()
	c, err := e.fsys.ReadFile(p)
	if err != nil {
		e.t.Fatal(err)
	}
	return string(c.Data)
}

func (e *renameEnv) rename(from, to string) links.Plan {
	e.t.Helper()
	plan, err := links.PlanRename(e.ctx, e.ix.DB(), e.fsys, from, to)
	if err != nil {
		e.t.Fatal(err)
	}
	full, err := links.PlanRenameFull(e.ctx, e.ix.DB(), e.fsys, from, to)
	if err != nil {
		e.t.Fatal(err)
	}
	if len(plan.Files) != len(full.Files) {
		e.t.Fatalf("candidates %+v, full scan %+v", plan.Files, full.Files)
	}
	if err := links.ApplyRename(e.fsys, plan); err != nil {
		e.t.Fatal(err)
	}
	return plan
}

const canvasJSON = `{"nodes":[` +
	`{"id":"f","type":"file","file":"Projects/Plan.md","subpath":"#Goals","x":0,"y":0,"width":400,"height":400},` +
	`{"id":"t","type":"text","text":"see [[Plan]] and [[Other]]","x":500,"y":0,"width":200,"height":100},` +
	`{"id":"u","type":"text","text":"literal \"file\": \"Projects/Plan.md\"","x":900,"y":0,"width":200,"height":100}` +
	`],"edges":[]}`

// Moving a note rewrites the file nodes of the canvases that show it (an
// exact vault path) and the wikilinks of their text nodes, and nothing else.
func TestRenameRewritesCanvasFileNodes(t *testing.T) {
	e := newRenameEnv(t, map[string]string{
		"Projects/Plan.md": "# Plan\n## Goals\n",
		"Other.md":         "x",
		"Board.canvas":     canvasJSON,
	})
	plan := e.rename("Projects/Plan.md", "Archive/Plan 2026.md")
	if len(plan.Files) != 1 || plan.Files[0].Path != "Board.canvas" {
		t.Fatalf("plan %+v", plan)
	}
	got := e.read("Board.canvas")
	want := strings.Replace(canvasJSON, `"file":"Projects/Plan.md"`, `"file":"Archive/Plan 2026.md"`, 1)
	want = strings.Replace(want, "[[Plan]]", "[[Plan 2026]]", 1)
	if got != want {
		t.Fatalf("canvas after rename:\n%s\nwant\n%s", got, want)
	}
}

// Property links ("related: "[[Note]]"") are rewritten like the links of the
// body; tags, aliases and comments are not touched.
func TestRenameRewritesPropertyLinks(t *testing.T) {
	note := "---\nrelated: \"[[Plan]]\"\nsee:\n  - \"[[Plan|the plan]]\"\naliases: [\"[[Plan]]\"]\nnote: plain # [[Plan]]\n---\nBody [[Plan]].\n"
	e := newRenameEnv(t, map[string]string{"Projects/Plan.md": "# Plan\n", "Ref.md": note})
	e.rename("Projects/Plan.md", "Projects/Roadmap.md")
	want := "---\nrelated: \"[[Roadmap]]\"\nsee:\n  - \"[[Roadmap|the plan]]\"\naliases: [\"[[Plan]]\"]\nnote: plain # [[Plan]]\n---\nBody [[Roadmap]].\n"
	if got := e.read("Ref.md"); got != want {
		t.Fatalf("note after rename:\n%s\nwant\n%s", got, want)
	}
}

// Merging a note into another redirects the links of notes, drawings,
// canvases (file nodes included) and properties.
func TestPlanRedirectCoversDrawingsCanvasesAndProperties(t *testing.T) {
	drawing := `{"type":"excalidraw","elements":[{"id":"a","type":"rectangle","link":"[[Plan]]"}]}`
	e := newRenameEnv(t, map[string]string{
		"Projects/Plan.md":  "# Plan\n",
		"Target.md":         "# Target\n",
		"Other.md":          "x",
		"Board.canvas":      canvasJSON,
		"Sketch.excalidraw": drawing,
		"Ref.md":            "---\nrelated: \"[[Plan]]\"\n---\n[[Plan]]\n",
	})
	plan, err := links.PlanRedirect(e.ctx, e.ix.DB(), e.fsys, "Projects/Plan.md", "Target.md")
	if err != nil {
		t.Fatal(err)
	}
	if err := links.ApplyEdits(e.fsys, plan); err != nil {
		t.Fatal(err)
	}
	if got := e.read("Sketch.excalidraw"); !strings.Contains(got, `"link":"[[Target]]"`) {
		t.Fatalf("drawing: %s", got)
	}
	if got := e.read("Board.canvas"); !strings.Contains(got, `"file":"Target.md"`) || !strings.Contains(got, "see [[Target]]") {
		t.Fatalf("canvas: %s", got)
	}
	if got := e.read("Ref.md"); got != "---\nrelated: \"[[Target]]\"\n---\n[[Target]]\n" {
		t.Fatalf("note: %q", got)
	}
}

// A rename whose move fails restores the rewritten notes, but never over
// content that changed again meanwhile: that note is reported instead.
func TestApplyRenameRollback(t *testing.T) {
	e := newRenameEnv(t, map[string]string{
		"Plan.md": "# Plan\n",
		"A.md":    "[[Plan]]\n",
		"B.md":    "[[Plan]] too\n",
	})
	plan, err := links.PlanRename(e.ctx, e.ix.DB(), e.fsys, "Plan.md", "Roadmap.md")
	if err != nil || len(plan.Files) != 2 {
		t.Fatalf("plan %+v %v", plan, err)
	}
	// The destination appears before the move: the rename fails.
	links.SetBeforeMoveHook(func() {
		if _, err := e.fsys.WriteFile("Roadmap.md", []byte("someone else"), "", true); err != nil {
			t.Error(err)
		}
	})
	defer links.SetBeforeMoveHook(nil)
	if err := links.ApplyRename(e.fsys, plan); !errors.Is(err, vault.ErrExists) || errors.Is(err, links.ErrPartialRollback) {
		t.Fatalf("ApplyRename = %v", err)
	}
	if e.read("A.md") != "[[Plan]]\n" || e.read("B.md") != "[[Plan]] too\n" || e.read("Plan.md") != "# Plan\n" {
		t.Fatal("rewritten notes not restored")
	}

	// Same failure, but B.md is edited (a sync pull) before the rollback.
	if err := e.fsys.Delete("Roadmap.md"); err != nil {
		t.Fatal(err)
	}
	links.SetBeforeMoveHook(func() {
		if _, err := e.fsys.WriteFile("B.md", []byte("pulled from the cloud\n"), "", false); err != nil {
			t.Error(err)
		}
		if _, err := e.fsys.WriteFile("Roadmap.md", []byte("someone else"), "", true); err != nil {
			t.Error(err)
		}
	})
	err = links.ApplyRename(e.fsys, plan)
	if !errors.Is(err, links.ErrPartialRollback) || !strings.Contains(err.Error(), "B.md") {
		t.Fatalf("ApplyRename = %v", err)
	}
	if e.read("B.md") != "pulled from the cloud\n" {
		t.Fatal("the rollback overwrote newer content")
	}
	if e.read("A.md") != "[[Plan]]\n" {
		t.Fatal("A.md not restored")
	}
}

// A note with a leading BOM is a rename candidate like any other and its property links are rewritten in place,
// the BOM untouched (the offsets point into the file as it is on disk).
func TestRenameRewritesPropertyLinksBehindBOM(t *testing.T) {
	const bom = "\xef\xbb\xbf"
	note := bom + "---\nrelated: \"[[Plan]]\"\n---\nBody [[Plan]].\n"
	e := newRenameEnv(t, map[string]string{"Projects/Plan.md": "# Plan\n", "Ref.md": note})
	e.rename("Projects/Plan.md", "Projects/Roadmap.md")
	want := bom + "---\nrelated: \"[[Roadmap]]\"\n---\nBody [[Roadmap]].\n"
	if got := e.read("Ref.md"); got != want {
		t.Fatalf("note after rename:\n%q\nwant\n%q", got, want)
	}
}
