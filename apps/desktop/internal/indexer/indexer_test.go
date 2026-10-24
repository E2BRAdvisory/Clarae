package indexer

import (
	"context"
	"path/filepath"
	"testing"

	"github.com/rs/zerolog"

	"nodus/apps/desktop/internal/store"
	"nodus/apps/desktop/internal/vault"
)

func TestFullUpdateRebuildSearch(t *testing.T) {
	ctx := context.Background()
	root := t.TempDir()
	fsys, err := vault.NewFS(root)
	if err != nil {
		t.Fatal(err)
	}
	db, err := store.Open(ctx, filepath.Join(root, ".nodus", "index.db"), store.KindIndex)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = db.Close() }()

	write := func(p, s string) {
		t.Helper()
		if _, err := fsys.WriteFile(p, []byte(s), "", false); err != nil {
			t.Fatal(err)
		}
	}
	write("Notes/budget.md", "---\ntags: [finance]\n---\n# Budget 2026\n\nSee [[Plan]] and #quarterly.\n")
	write("Plan.md", "# Plan\n\nNothing yet.\n")
	write("img/logo.png", "PNGDATA")

	ix := New(fsys, db, zerolog.Nop(), nil)
	if err := ix.Full(ctx); err != nil {
		t.Fatal(err)
	}
	count := func(q string, args ...any) int {
		t.Helper()
		var n int
		if err := db.QueryRowContext(ctx, q, args...).Scan(&n); err != nil {
			t.Fatal(err)
		}
		return n
	}
	if count(`SELECT count(*) FROM files`) != 3 {
		t.Fatalf("files: %d", count(`SELECT count(*) FROM files`))
	}
	if count(`SELECT count(*) FROM tags WHERE path='Notes/budget.md'`) != 2 {
		t.Fatal("tags not indexed")
	}
	if count(`SELECT count(*) FROM links WHERE path='Notes/budget.md' AND target_raw='Plan'`) != 1 {
		t.Fatal("link not indexed")
	}
	if count(`SELECT count(*) FROM headings WHERE path='Plan.md' AND text='Plan'`) != 1 {
		t.Fatal("heading not indexed")
	}

	hits, err := ix.Search(ctx, "udget", 10)
	if err != nil || len(hits) != 1 || hits[0].Path != "Notes/budget.md" {
		t.Fatalf("search: %v %v", hits, err)
	}
	if hits, _ := ix.Search(ctx, "ab", 10); len(hits) != 0 {
		t.Fatal("queries under 3 characters must return nothing")
	}

	// Update: modified, deleted, folder removed.
	write("Plan.md", "# Plan\n\nNow with #todo.\n")
	if err := fsys.Delete("img"); err != nil {
		t.Fatal(err)
	}
	if err := ix.Update(ctx, []string{"Plan.md", "img"}); err != nil {
		t.Fatal(err)
	}
	if count(`SELECT count(*) FROM tags WHERE path='Plan.md' AND name='todo'`) != 1 {
		t.Fatal("update did not reparse")
	}
	if count(`SELECT count(*) FROM files WHERE path LIKE 'img/%'`) != 0 {
		t.Fatal("deleted folder still indexed")
	}

	// Full pass after an external deletion removes the row.
	if err := fsys.Delete("Notes/budget.md"); err != nil {
		t.Fatal(err)
	}
	if err := ix.Full(ctx); err != nil {
		t.Fatal(err)
	}
	if count(`SELECT count(*) FROM files`) != 1 {
		t.Fatalf("expected 1 file after deletion, got %d", count(`SELECT count(*) FROM files`))
	}
	if err := ix.Rebuild(ctx); err != nil {
		t.Fatal(err)
	}
	if count(`SELECT count(*) FROM fts_content`) != 1 {
		t.Fatal("rebuild lost rows")
	}
}

func TestDrawingsAndCanvasesAreIndexed(t *testing.T) {
	ctx := context.Background()
	root := t.TempDir()
	fsys, err := vault.NewFS(root)
	if err != nil {
		t.Fatal(err)
	}
	db, err := store.Open(ctx, filepath.Join(root, ".nodus", "index.db"), store.KindIndex)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = db.Close() }()
	write := func(p, s string) {
		t.Helper()
		if _, err := fsys.WriteFile(p, []byte(s), "", false); err != nil {
			t.Fatal(err)
		}
	}
	write("Plan.md", "# Plan\n")
	write("Sketch.excalidraw", `{"type":"excalidraw","elements":[
	  {"id":"a","type":"text","text":"architecture overview"},
	  {"id":"b","type":"rectangle","link":"[[Plan]]"}]}`)
	write("Map.canvas", `{"nodes":[{"id":"n","type":"text","x":0,"y":0,"width":10,"height":10,"text":"roadmap ideas"},
	  {"id":"f","type":"file","x":0,"y":0,"width":10,"height":10,"file":"Plan.md"}],"edges":[]}`)
	write("Broken.excalidraw", `{not json`)

	ix := New(fsys, db, zerolog.Nop(), nil)
	if err := ix.Full(ctx); err != nil {
		t.Fatal(err)
	}
	count := func(q string, args ...any) int {
		t.Helper()
		var n int
		if err := db.QueryRowContext(ctx, q, args...).Scan(&n); err != nil {
			t.Fatal(err)
		}
		return n
	}
	// Both sources show up as backlinks of the note.
	if n := count(`SELECT count(*) FROM links WHERE target_resolved='Plan.md' AND path IN ('Sketch.excalidraw','Map.canvas')`); n != 2 {
		t.Fatalf("links from drawing and canvas = %d", n)
	}
	// The text of elements is searchable.
	for q, want := range map[string]string{"architecture": "Sketch.excalidraw", "roadmap": "Map.canvas"} {
		hits, err := ix.Search(ctx, q, 10)
		if err != nil || len(hits) != 1 || hits[0].Path != want {
			t.Fatalf("search %q: %v %v", q, hits, err)
		}
	}
	// A file that does not parse is still listed.
	if count(`SELECT count(*) FROM files WHERE path='Broken.excalidraw'`) != 1 {
		t.Fatal("broken drawing must stay listed")
	}
	// Editing the drawing re-indexes it.
	write2 := func(p, s, hash string) {
		if _, err := fsys.WriteFile(p, []byte(s), hash, false); err != nil {
			t.Fatal(err)
		}
	}
	cur, _ := fsys.ReadFile("Sketch.excalidraw")
	write2("Sketch.excalidraw", `{"elements":[{"id":"a","type":"text","text":"deployment diagram"}]}`, cur.Hash)
	if err := ix.Update(ctx, []string{"Sketch.excalidraw"}); err != nil {
		t.Fatal(err)
	}
	if hits, _ := ix.Search(ctx, "deployment", 10); len(hits) != 1 {
		t.Fatal("update did not re-index the drawing")
	}
	if n := count(`SELECT count(*) FROM links WHERE path='Sketch.excalidraw'`); n != 0 {
		t.Fatalf("stale links: %d", n)
	}
}
