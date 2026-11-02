//go:build js && wasm

package store

import (
	"context"
	"path/filepath"
	"testing"
)

// sqlite-wasm stores a database under the full path, '#', '?' and '%' included: before M12 the
// sqlitejs driver cut the unescaped DSN at its first '?'.
func TestOpenEscapesPathJS(t *testing.T) {
	ctx := context.Background()
	base := t.TempDir()
	for _, name := range []string{"Progetti #1", "100%25 done", "why?", "a?b#c", "Città è"} {
		path := filepath.Join(base, name, ".memobrain", "sync.db")
		db, err := Open(ctx, path, KindSync)
		if err != nil {
			t.Fatalf("%q: %v", name, err)
		}
		_ = db.Close()
		if ok, err := Exists(path); err != nil || !ok {
			t.Errorf("%q: Exists = %v, %v", name, ok, err)
		}
	}
	for _, truncated := range []string{"Progetti ", "why", "a"} {
		if ok, _ := Exists(filepath.Join(base, truncated)); ok {
			t.Errorf("a database was stored under the truncated path %q", truncated)
		}
	}
}

// Only a '?' moved the database of the sqlitejs driver; the old one is found but left alone.
func TestLegacyDatabaseJS(t *testing.T) {
	ctx := context.Background()
	base := t.TempDir()
	legacy := filepath.Join(base, "why")
	old, err := Open(ctx, legacy, KindSync)
	if err != nil {
		t.Fatal(err)
	}
	_ = old.Close()

	if got, ok := legacyDatabase(filepath.Join(base, "why?", ".memobrain", "sync.db")); !ok || got != legacy {
		t.Fatalf("legacyDatabase = %q, %v; want %q, true", got, ok, legacy)
	}
	if ok, _ := Exists(legacy); !ok {
		t.Fatal("legacy database removed")
	}
	for _, p := range []string{
		filepath.Join(base, "why #1", ".memobrain", "sync.db"), // '#' never moved it
		filepath.Join(base, "plain", ".memobrain", "sync.db"),
		filepath.Join(base, "none?", ".memobrain", "sync.db"), // nothing stored at the truncated path
	} {
		if got, ok := legacyDatabase(p); ok {
			t.Errorf("%q: unexpected legacy database %q", p, got)
		}
	}
}
