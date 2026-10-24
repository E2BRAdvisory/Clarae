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
