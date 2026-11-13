package app

import (
	"context"
	"os"
	"path/filepath"
	"runtime"
	"testing"

	"github.com/rs/zerolog"

	"clarae/apps/desktop/internal/store"
	syncpkg "clarae/apps/desktop/internal/sync"
	"clarae/shared/pathrules"
)

// openLegacy opens a vault whose root was prepared by prepare, as a client of 1.x left it.
func openLegacy(t *testing.T, prepare func(root string)) (*App, VaultInfo, string) {
	t.Helper()
	ctx := context.Background()
	dataDir := t.TempDir()
	a := New(Options{DataDir: dataDir, Logger: zerolog.Nop(), Version: "test"})
	a.ctx = ctx
	a.emitter = func(string, any) {}
	db, err := store.Open(ctx, filepath.Join(dataDir, "app.db"), store.KindApp)
	if err != nil {
		t.Fatal(err)
	}
	a.appDB = db
	root := filepath.Join(t.TempDir(), "vault")
	if err := os.MkdirAll(root, 0o755); err != nil {
		t.Fatal(err)
	}
	prepare(root)
	info, err := a.openVault(root)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		a.mu.Lock()
		for id, v := range a.vaults {
			a.closeVaultLocked(id, v)
		}
		a.mu.Unlock()
		_ = db.Close()
	})
	return a, info, root
}

func writeIn(t *testing.T, root, rel, content string) {
	t.Helper()
	p := filepath.Join(root, filepath.FromSlash(rel))
	if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(p, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
}

func exists(root, rel string) bool {
	_, err := os.Lstat(filepath.Join(root, filepath.FromSlash(rel)))
	return err == nil
}

// A vault that is not linked to the cloud has no other client to stay compatible with: opening it
// moves everything of the former configuration folder, and the settings are read from the new one.
func TestOpenUnlinkedVaultOf1xMovesItsSettings(t *testing.T) {
	legacy, current := pathrules.LegacyConfigDirs[0], pathrules.ConfigDir
	a, info, root := openLegacy(t, func(root string) {
		writeIn(t, root, legacy+"/editor.json", `{"wrap":true}`)
		writeIn(t, root, legacy+"/templates/daily.md", "# daily")
		writeIn(t, root, legacy+"/workspace.json", `{"layout":1}`)
		writeIn(t, root, legacy+"/cache/drawings/a.svg", "<svg>")
		writeIn(t, root, "Note.md", "# hello")
	})
	for _, rel := range []string{"editor.json", "templates/daily.md", "workspace.json", "cache/drawings/a.svg"} {
		if !exists(root, current+"/"+rel) {
			t.Errorf("%s did not move to the current folder", rel)
		}
	}
	if exists(root, legacy) {
		t.Errorf("the former folder is still there: %v", func() []os.DirEntry { e, _ := os.ReadDir(filepath.Join(root, legacy)); return e }())
	}
	got, err := NewVaultAPI(a).ReadConfig(info.ID, "editor.json")
	if err != nil || got != `{"wrap":true}` {
		t.Fatalf("ReadConfig = %q, %v", got, err)
	}
}

// A linked vault keeps its settings where 1.x clients sharing it read them; only the local part moves.
func TestOpenLinkedVaultOf1xKeepsItsSettings(t *testing.T) {
	if runtime.GOOS == "js" {
		t.Skip("the browser core keeps sync.db in sqlite-wasm: a key, not a file to rename")
	}
	legacy, current := pathrules.LegacyConfigDirs[0], pathrules.ConfigDir
	_, _, root := openLegacy(t, func(root string) {
		writeIn(t, root, legacy+"/editor.json", `{"wrap":true}`)
		writeIn(t, root, legacy+"/workspace.json", `{"layout":1}`)
		ctx := context.Background()
		sdb, err := store.Open(ctx, filepath.Join(root, legacy, "sync.db"), store.KindSync)
		if err != nil {
			t.Fatal(err)
		}
		defer func() { _ = sdb.Close() }()
		if err := syncpkg.NewDB(sdb).SetMeta(ctx, syncpkg.MetaCloudVault, "00000000-0000-7000-8000-000000000001"); err != nil {
			t.Fatal(err)
		}
	})
	if !exists(root, legacy+"/editor.json") || exists(root, current+"/editor.json") {
		t.Error("the settings of a linked vault must stay in the former folder")
	}
	for _, rel := range []string{"workspace.json", "sync.db", "index.db"} {
		if !exists(root, current+"/"+rel) || exists(root, legacy+"/"+rel) {
			t.Errorf("%s is not in the current folder only", rel)
		}
	}
	linked, err := syncpkg.IsLinked(context.Background(), root)
	if err != nil || !linked {
		t.Fatalf("the link did not survive the move: %v, %v", linked, err)
	}
}
