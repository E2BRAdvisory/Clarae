//go:build js && wasm

package vaultdir

import (
	"context"
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"testing"

	"clarae/apps/desktop/internal/store"
)

func putDB(t *testing.T, path, key, value string) {
	t.Helper()
	db, err := store.Open(context.Background(), path, store.KindSync)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = db.Close() }()
	if _, err := db.Exec("INSERT INTO sync_meta(key, value) VALUES (?, ?)", key, value); err != nil {
		t.Fatal(err)
	}
}

func getDB(t *testing.T, path, key string) string {
	t.Helper()
	db, err := store.Open(context.Background(), path, store.KindSync)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = db.Close() }()
	var v string
	_ = db.QueryRow("SELECT value FROM sync_meta WHERE key = ?", key).Scan(&v)
	return v
}

// In the browser a database is a name in sqlite-wasm's pool and the pool cannot rename: the key a
// profile of 1.x created stays the key of its database, and no empty former folder appears in the
// vault (it would end up in the ZIP).
func TestDBKeepsTheKeyOfAProfileOf1x(t *testing.T) {
	root := t.TempDir()
	former := filepath.Join(root, legacy, "sync.db")
	putDB(t, former, "cloud_vault", "abc")

	path, err := DB(root, "sync.db")
	if err != nil {
		t.Fatal(err)
	}
	if path != former {
		t.Fatalf("DB = %q, want the key of 1.x %q", path, former)
	}
	if got := getDB(t, path, "cloud_vault"); got != "abc" {
		t.Fatalf("the link of 1.x is not found under the key DB returns: %q", got)
	}
	if ok, _ := store.Exists(filepath.Join(root, current, "sync.db")); ok {
		t.Fatal("a database was made under the current key beside the one of 1.x")
	}
	// What the folder holds as files moves as everywhere else, and the folder stays gone.
	if _, err := os.Lstat(filepath.Join(root, legacy)); !errors.Is(err, fs.ErrNotExist) {
		t.Fatalf("an empty former folder is in the vault: %v", err)
	}
}

func TestDBNewProfileUsesTheCurrentKey(t *testing.T) {
	root := t.TempDir()
	path, err := DB(root, "sync.db")
	if err != nil {
		t.Fatal(err)
	}
	if want := filepath.Join(root, current, "sync.db"); path != want {
		t.Fatalf("DB = %q, want %q", path, want)
	}
	putDB(t, path, "k", "v")
	if again, _ := DB(root, "sync.db"); again != path {
		t.Fatalf("the key changed: %q", again)
	}
	if _, err := os.Lstat(filepath.Join(root, legacy)); !errors.Is(err, fs.ErrNotExist) {
		t.Fatalf("a former folder appeared: %v", err)
	}
}

// With a database under both keys the current one wins; the old one is not touched.
func TestDBCurrentKeyWins(t *testing.T) {
	root := t.TempDir()
	former, cur := filepath.Join(root, legacy, "sync.db"), filepath.Join(root, current, "sync.db")
	putDB(t, former, "who", "former")
	putDB(t, cur, "who", "current")
	path, err := DB(root, "sync.db")
	if err != nil {
		t.Fatal(err)
	}
	if path != cur {
		t.Fatalf("DB = %q, want %q", path, cur)
	}
	if got := getDB(t, former, "who"); got != "former" {
		t.Fatalf("the database of 1.x changed: %q", got)
	}
}
