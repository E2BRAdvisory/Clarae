package db

import (
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
