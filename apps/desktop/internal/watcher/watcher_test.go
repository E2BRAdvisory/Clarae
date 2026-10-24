package watcher

import (
	"context"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/rs/zerolog"
)

func TestWatcherDebouncesAndCoalesces(t *testing.T) {
	root := t.TempDir()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	w, err := New(ctx, root, Options{Debounce: 100 * time.Millisecond, ReconcileInterval: -1, Logger: zerolog.Nop()})
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = w.Close() }()

	if err := os.MkdirAll(filepath.Join(root, "Dir"), 0o755); err != nil {
		t.Fatal(err)
	}
	time.Sleep(50 * time.Millisecond) // let the new directory be watched
	for i := 0; i < 3; i++ {
		if err := os.WriteFile(filepath.Join(root, "Dir", "a.md"), []byte("x"), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.WriteFile(filepath.Join(root, ".DS_Store"), []byte("junk"), 0o644); err != nil {
		t.Fatal(err)
	}

	select {
	case ch := <-w.C():
		if ch.Reconcile {
			t.Fatal("unexpected reconcile")
		}
		found := false
		for _, p := range ch.Paths {
			if p == ".DS_Store" {
				t.Fatal("excluded file reported")
			}
			if p == "Dir/a.md" {
				found = true
			}
		}
		if !found {
			t.Fatalf("Dir/a.md not reported: %v", ch.Paths)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("no change delivered")
	}
}
