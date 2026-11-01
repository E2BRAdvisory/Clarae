package main

import (
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/rs/zerolog"
)

func TestSweepSpoolRemovesOnlyStaleSpoolFiles(t *testing.T) {
	dir := t.TempDir()
	now := time.Now()
	old := now.Add(-7 * time.Hour)
	files := map[string]time.Time{
		"memobrain-export-1.zip": old, // swept
		"memobrain-blob-2":       old, // swept
		"memobrain-upload-3":     old, // swept
		"memobrain-export-4.zip": now.Add(-time.Minute),
		"other-file":             old,
	}
	for name, mtime := range files {
		p := filepath.Join(dir, name)
		if err := os.WriteFile(p, []byte("x"), 0o600); err != nil {
			t.Fatal(err)
		}
		if err := os.Chtimes(p, mtime, mtime); err != nil {
			t.Fatal(err)
		}
	}
	sweepSpool(dir, now, zerolog.Nop())
	for name := range files {
		_, err := os.Stat(filepath.Join(dir, name))
		swept := os.IsNotExist(err)
		want := name == "memobrain-export-1.zip" || name == "memobrain-blob-2" || name == "memobrain-upload-3"
		if swept != want {
			t.Errorf("%s: swept %v, want %v", name, swept, want)
		}
	}
}
