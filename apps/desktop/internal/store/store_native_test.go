//go:build !js

package store

import (
	"bytes"
	"context"
	"log/slog"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

// A vault folder whose name holds URI metacharacters keeps index.db and sync.db inside it: before
// M12 "Progetti #1" and "Progetti #2" both opened the file "Progetti " next to them.
func TestOpenEscapesPath(t *testing.T) {
	ctx := context.Background()
	names := []string{"Progetti #1", "Progetti #2", "a%20b", "100% done", "spazi  e tab", "Città è 日本", "x%00y", "a+b&c=d;e,f@g$h"}
	if runtime.GOOS != "windows" {
		names = append(names, "why?", "a?b#c")
	}
	base, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	for _, name := range names {
		for _, kind := range []Kind{KindIndex, KindSync} {
			path := filepath.Join(base, name, ".clarae", string(kind)+".db")
			db, err := Open(ctx, path, kind)
			if err != nil {
				t.Fatalf("%q %s: %v", name, kind, err)
			}
			var seq int
			var schema, file string
			err = db.QueryRowContext(ctx, `PRAGMA database_list`).Scan(&seq, &schema, &file)
			_ = db.Close()
			if err != nil {
				t.Fatal(err)
			}
			if file != path {
				t.Errorf("%q %s: SQLite opened %q, want %q", name, kind, file, path)
			}
			if _, err := os.Stat(path); err != nil {
				t.Errorf("%q %s: %v", name, kind, err)
			}
		}
	}
	// Nothing landed next to the vault folders.
	entries, err := os.ReadDir(base)
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != len(names) {
		var got []string
		for _, e := range entries {
			got = append(got, e.Name())
		}
		t.Fatalf("base holds %q, want only the %d vault folders", got, len(names))
	}
}

// A database an older build left at the truncated path is reported, not moved or deleted.
func TestOpenWarnsAboutLegacyDatabase(t *testing.T) {
	ctx := context.Background()
	base, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	legacy := filepath.Join(base, "Progetti ")
	old, err := Open(ctx, legacy, KindSync) // the file the unescaped DSN created
	if err != nil {
		t.Fatal(err)
	}
	_ = old.Close()

	var buf bytes.Buffer
	prev := slog.Default()
	slog.SetDefault(slog.New(slog.NewTextHandler(&buf, nil)))
	t.Cleanup(func() { slog.SetDefault(prev) })

	path := filepath.Join(base, "Progetti #1", ".clarae", "sync.db")
	db, err := Open(ctx, path, KindSync)
	if err != nil {
		t.Fatal(err)
	}
	_ = db.Close()
	out := buf.String()
	if !strings.Contains(out, "level=WARN") || !strings.Contains(out, path) || !strings.Contains(out, legacy) {
		t.Fatalf("missing warning with both paths: %q", out)
	}
	if _, err := os.Stat(legacy); err != nil {
		t.Fatalf("legacy database touched: %v", err)
	}

	// No warning when the legacy path holds something else, or when the path needs no escaping.
	buf.Reset()
	if err := Reset(legacy); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(legacy, []byte("not a database"), 0o600); err != nil {
		t.Fatal(err)
	}
	for _, p := range []string{filepath.Join(base, "Progetti #2", ".clarae", "sync.db"), filepath.Join(base, "plain", "sync.db")} {
		db, err := Open(ctx, p, KindSync)
		if err != nil {
			t.Fatal(err)
		}
		_ = db.Close()
	}
	if buf.Len() != 0 {
		t.Fatalf("unexpected log: %q", buf.String())
	}
}
