package db

import (
	"errors"
	"fmt"
	"io/fs"
	"strings"
	"testing"
)

// latestMigration is what the worker waits for: the highest embedded version.
func TestLatestMigration(t *testing.T) {
	v, err := latestMigration()
	if err != nil {
		t.Fatal(err)
	}
	entries, err := fs.ReadDir(migrations, "migrations")
	if err != nil {
		t.Fatal(err)
	}
	prefix := fmt.Sprintf("%04d_", v)
	found := false
	for _, e := range entries {
		if strings.HasPrefix(e.Name(), prefix) {
			found = true
		}
		if e.Name() > prefix+"\xff" {
			t.Errorf("%s sorts after the latest version %d", e.Name(), v)
		}
	}
	if !found || v < 7 {
		t.Fatalf("latest migration %d (file %s* found: %v)", v, prefix, found)
	}
}

// The upgrade guard: a database without any applied migration is refused, one with a schema passes.
func TestRequireInitializedRefusesAnEmptyDatabase(t *testing.T) {
	err := requireInitialized(0)
	if !errors.Is(err, ErrNotInitialized) {
		t.Fatalf("version 0: %v, want ErrNotInitialized", err)
	}
	for _, want := range []string{"DB_EXPECT_INITIALIZED", "pg_dump", "audit log"} {
		if !strings.Contains(err.Error(), want) {
			t.Errorf("the error does not mention %q: %v", want, err)
		}
	}
	for _, v := range []int64{1, 15, 16} {
		if err := requireInitialized(v); err != nil {
			t.Errorf("version %d: %v", v, err)
		}
	}
}
