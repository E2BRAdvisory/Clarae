package indexer

import (
	"context"
	"fmt"
	"path/filepath"
	"reflect"
	"testing"

	"github.com/rs/zerolog"

	"memobrain/apps/desktop/internal/links"
	"memobrain/apps/desktop/internal/store"
	"memobrain/apps/desktop/internal/vault"
)

func resolvedLinks(t *testing.T, ix *Indexer) []string {
	t.Helper()
	rows, err := ix.db.Query(`SELECT path, line, target_raw, COALESCE(target_resolved,'') FROM links ORDER BY path, line, rowid`)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = rows.Close() }()
	var out []string
	for rows.Next() {
		var p, raw, res string
		var line int
		if err := rows.Scan(&p, &line, &raw, &res); err != nil {
			t.Fatal(err)
		}
		out = append(out, fmt.Sprintf("%s:%d %s -> %s", p, line, raw, res))
	}
	return out
}

// TestBatchesAndIncrementalResolve checks that (a) a vault larger than one write
// batch is indexed completely and (b) the cheap per-note link resolution used
// after a plain edit leaves exactly the state a full ResolveAll would.
func TestBatchesAndIncrementalResolve(t *testing.T) {
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
	defer func() { _ = db.Close() }()
	const n = batchMaxJobs*2 + 37
	write := func(p, s, hash string) {
		t.Helper()
		if _, err := fsys.WriteFile(p, []byte(s), hash, hash == ""); err != nil {
			t.Fatal(err)
		}
	}
	for i := 0; i < n; i++ {
		write(fmt.Sprintf("d%d/n%d.md", i%7, i), fmt.Sprintf("# n%d\n[[n%d]] [[n%d]] [[ghost]] [[Alias Two]]\n", i, (i+1)%n, (i*3)%n), "")
	}
	write("holder.md", "---\naliases: [Alias One]\n---\nhold\n", "")
	ix := New(fsys, db, zerolog.Nop(), nil)
	if err := ix.Full(ctx); err != nil {
		t.Fatal(err)
	}
	var files int
	if err := db.QueryRow(`SELECT count(*) FROM files`).Scan(&files); err != nil {
		t.Fatal(err)
	}
	if files != n+1 {
		t.Fatalf("indexed %d files, want %d", files, n+1)
	}

	// A plain edit: only the note's own links are re-resolved.
	c, err := fsys.ReadFile("d3/n3.md")
	if err != nil {
		t.Fatal(err)
	}
	write("d3/n3.md", "# n3\n[[n10]] [[Alias One]] [[nope]]\n", c.Hash)
	if err := ix.Update(ctx, []string{"d3/n3.md"}); err != nil {
		t.Fatal(err)
	}
	incremental := resolvedLinks(t, ix)
	if err := links.ResolveAll(ctx, db); err != nil {
		t.Fatal(err)
	}
	if full := resolvedLinks(t, ix); !reflect.DeepEqual(incremental, full) {
		t.Fatal("incremental resolution differs from ResolveAll")
	}

	// An alias change makes another note's links resolve: must be picked up.
	h, err := fsys.ReadFile("holder.md")
	if err != nil {
		t.Fatal(err)
	}
	write("holder.md", "---\naliases: [Alias Two]\n---\nhold\n", h.Hash)
	if err := ix.Update(ctx, []string{"holder.md"}); err != nil {
		t.Fatal(err)
	}
	incremental = resolvedLinks(t, ix)
	if err := links.ResolveAll(ctx, db); err != nil {
		t.Fatal(err)
	}
	if full := resolvedLinks(t, ix); !reflect.DeepEqual(incremental, full) {
		t.Fatal("alias change not re-resolved")
	}
	var resolved int
	if err := db.QueryRow(`SELECT count(*) FROM links WHERE target_raw = 'Alias Two' AND target_resolved = 'holder.md'`).Scan(&resolved); err != nil || resolved == 0 {
		t.Fatalf("alias links not resolved (%d, %v)", resolved, err)
	}

	// A new note satisfies a previously dangling link.
	write("nope.md", "# nope\n", "")
	if err := ix.Update(ctx, []string{"nope.md"}); err != nil {
		t.Fatal(err)
	}
	var target string
	if err := db.QueryRow(`SELECT COALESCE(target_resolved,'') FROM links WHERE path = 'd3/n3.md' AND target_raw = 'nope'`).Scan(&target); err != nil || target != "nope.md" {
		t.Fatalf("new note did not resolve the dangling link: %q %v", target, err)
	}
}
