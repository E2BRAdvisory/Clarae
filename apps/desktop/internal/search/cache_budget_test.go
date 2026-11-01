package search

import (
	"context"
	"path/filepath"
	"strings"
	"testing"

	"github.com/rs/zerolog"

	"memobrain/apps/desktop/internal/indexer"
	"memobrain/apps/desktop/internal/store"
	"memobrain/apps/desktop/internal/vault"
)

// The cache budget counts the indexed text, not the file sizes: a drawing
// whose embedded image dwarfs its text must not switch the cache off.
func TestCacheBudgetCountsIndexedText(t *testing.T) {
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
	t.Cleanup(func() { _ = db.Close() })
	image := strings.Repeat("A", 200_000)
	drawing := `{"type":"excalidraw","version":2,"elements":[{"id":"t1","type":"text","text":"hello drawing","isDeleted":false}],` +
		`"files":{"f1":{"id":"f1","mimeType":"image/png","dataURL":"data:image/png;base64,` + image + `"}}}`
	for p, c := range map[string]string{"d.excalidraw": drawing, "n.md": "# note\nsome text"} {
		if _, err := fsys.WriteFile(p, []byte(c), "", false); err != nil {
			t.Fatal(err)
		}
	}
	if err := indexer.New(fsys, db, zerolog.Nop(), nil).Full(ctx); err != nil {
		t.Fatal(err)
	}
	e := New(db)
	e.SetCacheBudget(64 << 10) // far below the drawing's 200 KB, far above its text
	snap, err := e.snapshot(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if snap == nil || len(snap.files) != 2 {
		t.Fatalf("cache disabled by the file size of the drawing: %+v", snap)
	}
	e.SetCacheBudget(8) // below the text itself
	if snap, _ := e.snapshot(ctx); snap != nil {
		t.Fatal("a vault above the budget must not be cached")
	}
}
