//go:build !js

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

// A database of 1.x with a write-ahead log that was never checkpointed (the app was killed): DB moves
// the main file and its journals together, and the rows that only the log holds are still there.
func TestDBMovesADatabaseWithItsLog(t *testing.T) {
	ctx := context.Background()
	src := t.TempDir()
	srcPath := filepath.Join(src, legacy, "sync.db")
	db, err := store.Open(ctx, srcPath, store.KindSync)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = db.Close() }()
	if _, err := db.ExecContext(ctx, "PRAGMA wal_autocheckpoint=0"); err != nil {
		t.Fatal(err)
	}
	if _, err := db.ExecContext(ctx, "INSERT INTO sync_meta(key, value) VALUES ('cloud_vault', 'abc')"); err != nil {
		t.Fatal(err)
	}
	// Copy what is on disk while the connection is open: the row is in the log only.
	root := t.TempDir()
	for _, suffix := range []string{"", "-wal", "-shm"} {
		b, err := os.ReadFile(srcPath + suffix)
		if err != nil {
			t.Fatalf("%s: %v", suffix, err)
		}
		dst := filepath.Join(root, legacy, "sync.db"+suffix)
		if err := os.MkdirAll(filepath.Dir(dst), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(dst, b, 0o644); err != nil {
			t.Fatal(err)
		}
	}
	if fi, err := os.Stat(srcPath + "-wal"); err != nil || fi.Size() == 0 {
		t.Fatalf("the fixture has no write-ahead log: %v", err)
	}

	path, err := DB(root, "sync.db")
	if err != nil {
		t.Fatal(err)
	}
	if want := filepath.Join(root, current, "sync.db"); path != want {
		t.Fatalf("DB = %q, want %q", path, want)
	}
	for _, suffix := range []string{"", "-wal"} {
		if _, err := os.Stat(path + suffix); err != nil {
			t.Fatalf("%s did not move: %v", suffix, err)
		}
		if _, err := os.Lstat(filepath.Join(root, legacy, "sync.db"+suffix)); !errors.Is(err, fs.ErrNotExist) {
			t.Fatalf("%s is still in the former folder: %v", suffix, err)
		}
	}
	moved, err := store.Open(ctx, path, store.KindSync)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = moved.Close() }()
	var v string
	if err := moved.QueryRowContext(ctx, "SELECT value FROM sync_meta WHERE key = 'cloud_vault'").Scan(&v); err != nil || v != "abc" {
		t.Fatalf("the row of the log is gone after the move: %q, %v", v, err)
	}
}

func TestDBOfAVaultWithNothingMakesNoFolder(t *testing.T) {
	root := t.TempDir()
	path, err := DB(root, "index.db")
	if err != nil {
		t.Fatal(err)
	}
	if want := filepath.Join(root, current, "index.db"); path != want {
		t.Fatalf("DB = %q, want %q", path, want)
	}
	if entries, _ := os.ReadDir(root); len(entries) != 0 {
		t.Fatalf("DB created %v", entries)
	}
}
