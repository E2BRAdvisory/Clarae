package store

import (
	"context"
	"database/sql"
	"path/filepath"
	"testing"
)

func TestOpenAndMigrate(t *testing.T) {
	ctx := context.Background()
	dir := t.TempDir()
	for _, kind := range []Kind{KindApp, KindIndex, KindSync} {
		db, err := Open(ctx, filepath.Join(dir, "sub", string(kind)+".db"), kind)
		if err != nil {
			t.Fatalf("%s: %v", kind, err)
		}
		// Reopening must be a no-op (migrations already applied).
		_ = db.Close()
		db, err = Open(ctx, filepath.Join(dir, "sub", string(kind)+".db"), kind)
		if err != nil {
			t.Fatalf("%s reopen: %v", kind, err)
		}
		_ = db.Close()
	}
}

// TestFTS5Trigram is SPIKE-02: modernc.org/sqlite must ship FTS5 with the
// trigram tokenizer for substring search (§2.4).
func TestFTS5Trigram(t *testing.T) {
	ctx := context.Background()
	db, err := Open(ctx, filepath.Join(t.TempDir(), "index.db"), KindIndex)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = db.Close() }()

	rows := []struct{ path, title, body string }{
		{"a.md", "Riunione budget", "Verbale della riunione sul budget 2026."},
		{"b.md", "Ricetta", "Pasta al pomodoro con basilico."},
		{"c.md", "Città", "Caffè a Milano e poi a Torino."},
	}
	for _, r := range rows {
		if _, err := db.ExecContext(ctx, `INSERT INTO fts_content(path, title, body) VALUES (?, ?, ?)`, r.path, r.title, r.body); err != nil {
			t.Fatal(err)
		}
	}
	tests := []struct {
		query string
		want  []string
	}{
		{"budget", []string{"a.md"}},
		{"BUDG", []string{"a.md"}},     // substring, case-insensitive
		{"omodor", []string{"b.md"}},   // inner substring
		{"ilano", []string{"c.md"}},    // unicode text
		{"riunione", []string{"a.md"}}, // title and body
		{"zzz", nil},
	}
	for _, tt := range tests {
		got, err := queryPaths(ctx, db, tt.query)
		if err != nil {
			t.Fatalf("%q: %v", tt.query, err)
		}
		if len(got) != len(tt.want) {
			t.Fatalf("%q: got %v want %v", tt.query, got, tt.want)
		}
		for i := range got {
			if got[i] != tt.want[i] {
				t.Fatalf("%q: got %v want %v", tt.query, got, tt.want)
			}
		}
	}
	if err := Reset(filepath.Join(t.TempDir(), "missing.db")); err != nil {
		t.Fatal(err)
	}
}

func queryPaths(ctx context.Context, db *sql.DB, q string) ([]string, error) {
	rows, err := db.QueryContext(ctx, `SELECT path FROM fts_content WHERE fts_content MATCH ? ORDER BY path`, q)
	if err != nil {
		return nil, err
	}
	defer func() { _ = rows.Close() }()
	var out []string
	for rows.Next() {
		var p string
		if err := rows.Scan(&p); err != nil {
			return nil, err
		}
		out = append(out, p)
	}
	return out, nil
}
