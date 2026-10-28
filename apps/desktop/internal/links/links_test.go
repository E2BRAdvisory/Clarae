package links_test

import (
	"context"
	"encoding/json"
	"path/filepath"
	"strings"
	"testing"

	"github.com/rs/zerolog"

	"memobrain/apps/desktop/internal/indexer"
	"memobrain/apps/desktop/internal/links"
	"memobrain/apps/desktop/internal/store"
	"memobrain/apps/desktop/internal/vault"
)

func setup(t *testing.T, files map[string]string) (*indexer.Indexer, context.Context) {
	t.Helper()
	ctx := context.Background()
	root := t.TempDir()
	fsys, err := vault.NewFS(root)
	if err != nil {
		t.Fatal(err)
	}
	db, err := store.Open(ctx, filepath.Join(root, ".memobrain", "index.db"), store.KindIndex)
	if err != nil {
		t.Fatal(err)
	}
	for p, c := range files {
		if _, err := fsys.WriteFile(p, []byte(c), "", false); err != nil {
			t.Fatal(err)
		}
	}
	ix := indexer.New(fsys, db, zerolog.Nop(), nil)
	if err := ix.Full(ctx); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = db.Close() })
	return ix, ctx
}

func TestResolveBacklinksMentions(t *testing.T) {
	ix, ctx := setup(t, map[string]string{
		"Projects/Alpha.md": "---\naliases: [Alfa]\n---\n# Alpha\n",
		"Archive/Alpha.md":  "old\n",
		"Projects/Plan.md":  "See [[Alpha]] and [[Alfa]] and [[Ghost]] and [[Archive/Alpha]]. ![[logo.png]]\n",
		"Notes/Daily.md":    "Talked about Alpha today, link: [[Plan]] and [[Projects/Alpha#Alpha]].\n",
		"Notes/Idea.md":     "The Alpha project is great.\n",
		"logo.png":          "PNG",
	})
	db := ix.DB()

	out, err := links.Outgoing(ctx, db, "Projects/Plan.md")
	if err != nil {
		t.Fatal(err)
	}
	want := []struct {
		raw, res string
	}{
		{"Alpha", "Projects/Alpha.md"}, // same folder wins over Archive/Alpha.md
		{"Alfa", "Projects/Alpha.md"},  // alias
		{"Ghost", ""},                  // ghost note
		{"Archive/Alpha", "Archive/Alpha.md"},
		{"logo.png", "logo.png"}, // attachment keeps its extension
	}
	if len(out) != len(want) {
		t.Fatalf("outgoing: %+v", out)
	}
	for i, w := range want {
		if out[i].Raw != w.raw || out[i].Path != w.res || out[i].Resolved != (w.res != "") {
			t.Errorf("outgoing[%d] = %+v, want %+v", i, out[i], w)
		}
	}

	bl, err := links.Backlinks(ctx, db, "Projects/Alpha.md")
	if err != nil {
		t.Fatal(err)
	}
	var got []string
	for _, l := range bl {
		got = append(got, l.Path)
	}
	if len(got) != 3 || got[0] != "Notes/Daily.md" || got[1] != "Projects/Plan.md" || got[2] != "Projects/Plan.md" {
		t.Fatalf("backlinks: %v", got)
	}

	men, err := links.UnlinkedMentions(ctx, db, "Projects/Alpha.md")
	if err != nil {
		t.Fatal(err)
	}
	if len(men) != 1 || men[0].Path != "Notes/Idea.md" {
		t.Fatalf("mentions: %+v", men)
	}
}

func TestResolveSelfHeadingLink(t *testing.T) {
	r := &links.Resolver{}
	if got := r.Resolve("a/b.md", ""); got != "a/b.md" {
		t.Fatalf("[[#heading]] should resolve to the note itself, got %q", got)
	}
}

func TestRenameRewritesLinks(t *testing.T) {
	ctx := context.Background()
	root := t.TempDir()
	fsys, _ := vault.NewFS(root)
	db, err := store.Open(ctx, filepath.Join(root, ".memobrain", "index.db"), store.KindIndex)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = db.Close() }()
	put := func(p, c string) {
		if _, err := fsys.WriteFile(p, []byte(c), "", false); err != nil {
			t.Fatal(err)
		}
	}
	put("Plan.md", "# Plan\n")
	put("Other/Plan.md", "# other plan\n")
	put("Notes/A.md", "Café [[Plan]] [[Plan#Goals|goals]] ![[Plan]] [p](../Plan.md) [[Missing]] `[[Plan]]`\n")
	put("Notes/B.md", "[[Other/Plan]] and [[A]]\n")
	ix := indexer.New(fsys, db, zerolog.Nop(), nil)
	if err := ix.Full(ctx); err != nil {
		t.Fatal(err)
	}

	// Rename Plan.md -> Roadmap.md: name-based links follow, the code span and ghost stay.
	plan, err := links.PlanRename(ctx, db, fsys, "Plan.md", "Roadmap.md")
	if err != nil {
		t.Fatal(err)
	}
	if len(plan.Moves) != 1 || len(plan.Files) != 1 || plan.Files[0].Path != "Notes/A.md" || len(plan.Files[0].Edits) != 4 {
		t.Fatalf("plan: %+v", plan)
	}
	if err := links.ApplyRename(fsys, plan); err != nil {
		t.Fatal(err)
	}
	a, _ := fsys.ReadFile("Notes/A.md")
	want := "Café [[Roadmap]] [[Roadmap#Goals|goals]] ![[Roadmap]] [p](../Roadmap.md) [[Missing]] `[[Plan]]`\n"
	if string(a.Data) != want {
		t.Fatalf("A.md = %q\nwant   %q", a.Data, want)
	}
	if _, err := fsys.ReadFile("Roadmap.md"); err != nil {
		t.Fatal("file not moved")
	}
	// Notes/B.md linked to Other/Plan: unaffected.
	b, _ := fsys.ReadFile("Notes/B.md")
	if string(b.Data) != "[[Other/Plan]] and [[A]]\n" {
		t.Fatalf("B.md changed: %q", b.Data)
	}

	// Moving a folder keeps unique-name wikilinks untouched but fixes ambiguous ones.
	if err := ix.Rebuild(ctx); err != nil {
		t.Fatal(err)
	}
	plan, err = links.PlanRename(ctx, db, fsys, "Notes", "Archive/Notes")
	if err != nil {
		t.Fatal(err)
	}
	if len(plan.Moves) != 2 {
		t.Fatalf("folder moves: %+v", plan.Moves)
	}
	if err := links.ApplyRename(fsys, plan); err != nil {
		t.Fatal(err)
	}
	a, _ = fsys.ReadFile("Archive/Notes/A.md")
	if want := "Café [[Roadmap]] [[Roadmap#Goals|goals]] ![[Roadmap]] [p](../../Roadmap.md) [[Missing]] `[[Plan]]`\n"; string(a.Data) != want {
		t.Fatalf("moved A.md = %q\nwant      %q", a.Data, want)
	}

	// A stale plan is refused and leaves everything untouched.
	if err := ix.Rebuild(ctx); err != nil {
		t.Fatal(err)
	}
	stale, _ := links.PlanRename(ctx, db, fsys, "Roadmap.md", "Final.md")
	_, _ = fsys.WriteFile("Archive/Notes/A.md", []byte("[[Roadmap]] changed\n"), "", false)
	if err := links.ApplyRename(fsys, stale); err == nil {
		t.Fatal("stale plan must fail")
	}
	if _, err := fsys.ReadFile("Roadmap.md"); err != nil {
		t.Fatal("failed rename must not move the file")
	}
}

func TestFuzzyScoreAndSuggest(t *testing.T) {
	if links.FuzzyScore("road", "Roadmap") <= links.FuzzyScore("map", "Roadmap") {
		t.Error("prefix must beat substring")
	}
	if links.FuzzyScore("rdm", "Roadmap") == 0 || links.FuzzyScore("xyz", "Roadmap") != 0 {
		t.Error("subsequence matching broken")
	}
	if links.FuzzyScore("roadmap", "Roadmap") != 1000 {
		t.Error("exact match scores 1000")
	}
	ix, ctx := setup(t, map[string]string{
		"Projects/Roadmap.md": "---\naliases: [Plan]\n---\n# Roadmap\n\n## Goals ^goals1\n\nShip it ^ship\n",
		"Notes/Road trip.md":  "# Trip #travel/eu\n",
		"Other.md":            "tags: #travel #work\n",
	})
	db := ix.DB()
	notes, err := links.SuggestNotes(ctx, db, "road", 10)
	if err != nil || len(notes) < 2 || notes[0].Kind != "note" {
		t.Fatalf("notes: %+v %v", notes, err)
	}
	alias, _ := links.SuggestNotes(ctx, db, "plan", 10)
	if len(alias) == 0 || alias[0].Kind != "alias" || alias[0].Path != "Projects/Roadmap.md" {
		t.Fatalf("alias: %+v", alias)
	}
	heads, _ := links.SuggestHeadings(ctx, db, "Projects/Roadmap.md", "go", 10)
	if len(heads) != 1 || heads[0].Label != "Goals" {
		t.Fatalf("headings: %+v", heads)
	}
	blocks, _ := links.SuggestBlocks(ctx, db, "Projects/Roadmap.md", "", 10)
	if len(blocks) != 2 || blocks[1].Label != "ship" || blocks[1].Detail != "Ship it" {
		t.Fatalf("blocks: %+v", blocks)
	}
	tags, _ := links.SuggestTags(ctx, db, "#tra", 10)
	if len(tags) != 2 || tags[0].Label != "travel" || tags[1].Label != "travel/eu" {
		t.Fatalf("tags: %+v", tags)
	}
}

func TestRenameRewritesLinksInsideDrawings(t *testing.T) {
	ctx := context.Background()
	root := t.TempDir()
	fsys, _ := vault.NewFS(root)
	db, err := store.Open(ctx, filepath.Join(root, ".memobrain", "index.db"), store.KindIndex)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = db.Close() }()
	put := func(p, c string) {
		if _, err := fsys.WriteFile(p, []byte(c), "", false); err != nil {
			t.Fatal(err)
		}
	}
	put("Plan.md", "# Plan\n")
	drawing := `{
  "type": "excalidraw",
  "elements": [
    {"id": "a", "type": "rectangle", "link": "[[Plan]]"},
    {"id": "b", "type": "text", "text": "see [[Plan#Goals|goals]] and [[Missing]]", "originalText": "see [[Plan#Goals|goals]] and [[Missing]]"},
    {"id": "c", "type": "rectangle", "link": "https://example.com/[[Plan]]x"}
  ],
  "files": {}
}`
	put("Board.excalidraw", drawing)
	ix := indexer.New(fsys, db, zerolog.Nop(), nil)
	if err := ix.Full(ctx); err != nil {
		t.Fatal(err)
	}
	plan, err := links.PlanRename(ctx, db, fsys, "Plan.md", "Roadmap.md")
	if err != nil {
		t.Fatal(err)
	}
	var edits int
	for _, f := range plan.Files {
		if f.Path == "Board.excalidraw" {
			edits = len(f.Edits)
		}
	}
	if edits != 3 { // element link, text and originalText; the one inside the URL is left alone
		t.Fatalf("drawing edits = %d, plan: %+v", edits, plan)
	}
	if err := links.ApplyRename(fsys, plan); err != nil {
		t.Fatal(err)
	}
	got, _ := fsys.ReadFile("Board.excalidraw")
	for _, want := range []string{`"link": "[[Roadmap]]"`, `see [[Roadmap#Goals|goals]] and [[Missing]]`} {
		if !strings.Contains(string(got.Data), want) {
			t.Errorf("missing %q in\n%s", want, got.Data)
		}
	}
	if strings.Count(string(got.Data), "[[Plan") != 1 { // only the URL keeps the old text
		t.Errorf("a link still points at the old name:\n%s", got.Data)
	}
	if !strings.Contains(string(got.Data), `https://example.com/[[Plan]]x`) {
		t.Errorf("a URL was rewritten:\n%s", got.Data)
	}
	if !json.Valid(got.Data) {
		t.Errorf("drawing is no longer valid JSON:\n%s", got.Data)
	}
}
