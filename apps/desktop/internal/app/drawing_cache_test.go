package app

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/rs/zerolog"

	"clarae/apps/desktop/internal/indexer"
	"clarae/apps/desktop/internal/store"
	"clarae/apps/desktop/internal/vault"
)

func TestPruneDrawingCache(t *testing.T) {
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
	ix := indexer.New(fsys, db, zerolog.Nop(), nil)

	live, err := fsys.WriteFile("Board.excalidraw", []byte(`{"type":"excalidraw","elements":[]}`), "", true)
	if err != nil {
		t.Fatal(err)
	}
	if err := ix.Full(ctx); err != nil {
		t.Fatal(err)
	}

	now := time.Now()
	old := now.Add(-time.Hour)
	cache := filepath.Join(root, ".clarae", "cache", "drawings")
	put := func(name string, mtime time.Time) string {
		t.Helper()
		if err := os.MkdirAll(cache, 0o755); err != nil {
			t.Fatal(err)
		}
		p := filepath.Join(cache, name)
		if err := os.WriteFile(p, []byte("<svg/>"), 0o644); err != nil {
			t.Fatal(err)
		}
		if err := os.Chtimes(p, mtime, mtime); err != nil {
			t.Fatal(err)
		}
		return p
	}
	exists := func(p string) bool { _, err := os.Stat(p); return err == nil }

	// Nothing was ever cached: no folder, no error.
	if n, err := pruneDrawingCache(ctx, fsys, db, now); err != nil || n != 0 {
		t.Fatalf("no cache folder: %d %v", n, err)
	}

	orphan := strings.Repeat("a1", 32)
	recent := strings.Repeat("b2", 32)
	files := map[string]string{
		"orphan":          put(orphan+".svg", old),
		"orphan dark":     put(orphan+".dark.svg", old),
		"recent orphan":   put(recent+".svg", now.Add(-time.Minute)),
		"live":            put(live.Hash+".svg", old),
		"live dark":       put(live.Hash+".dark.svg", old),
		"foreign":         put("notes.txt", old),
		"short hash":      put("abcd.svg", old),
		"unknown variant": put(orphan+".sepia.svg", old),
	}
	want := map[string]bool{
		"orphan": false, "orphan dark": false, "recent orphan": true, "live": true, "live dark": true,
		"foreign": true, "short hash": true, "unknown variant": true,
	}

	n, err := pruneDrawingCache(ctx, fsys, db, now)
	if err != nil || n != 2 {
		t.Fatalf("pruned %d, %v; want the two old orphans", n, err)
	}
	for name, p := range files {
		if exists(p) != want[name] {
			t.Errorf("%s: exists=%v, want %v", name, exists(p), want[name])
		}
	}

	// The same recent orphan, a little later, is pruned: the age is relative to now.
	if n, err := pruneDrawingCache(ctx, fsys, db, now.Add(time.Hour)); err != nil || n != 1 {
		t.Fatalf("later pass: %d %v", n, err)
	}
	if exists(files["recent orphan"]) {
		t.Error("the orphan stayed after it came of age")
	}

	// A drawing that changed: the hash of its previous content is an orphan, the new one is not.
	changed, err := fsys.WriteFile("Board.excalidraw", []byte(`{"type":"excalidraw","elements":[{"id":"a"}]}`), live.Hash, false)
	if err != nil {
		t.Fatal(err)
	}
	if err := ix.Full(ctx); err != nil {
		t.Fatal(err)
	}
	fresh := put(changed.Hash+".svg", old)
	if n, err := pruneDrawingCache(ctx, fsys, db, now); err != nil || n != 2 {
		t.Fatalf("after a save: %d %v", n, err)
	}
	if exists(files["live"]) || !exists(fresh) {
		t.Error("the preview of the previous content must go, the current one stay")
	}

	// A cancelled context stops before deleting anything.
	stale := put(orphan+".svg", old)
	cancelled, cancel := context.WithCancel(ctx)
	cancel()
	if _, err := pruneDrawingCache(cancelled, fsys, db, now); err == nil || !exists(stale) {
		t.Errorf("a cancelled pass must delete nothing (err %v)", err)
	}
}
