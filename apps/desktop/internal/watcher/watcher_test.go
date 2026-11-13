package watcher

import (
	"context"
	"os"
	"path/filepath"
	"runtime"
	"testing"
	"time"

	"github.com/rs/zerolog"
)

func TestWatcherDebouncesAndCoalesces(t *testing.T) {
	if runtime.GOOS == "js" {
		t.Skip("the browser build has no fsnotify; see TestNotifyDebouncesAndCoalesces")
	}
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

// Notify is how the browser build learns of the core's own writes: same filtering, debouncing and
// coalescing as fsnotify events, on every platform.
func TestNotifyDebouncesAndCoalesces(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	w, err := New(ctx, t.TempDir(), Options{Debounce: 50 * time.Millisecond, ReconcileInterval: -1, Logger: zerolog.Nop()})
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = w.Close() }()

	for i := 0; i < 3; i++ {
		w.Notify([]string{"Dir/a.md"})
	}
	w.Notify([]string{".DS_Store", ".clarae-tmp-123", "Dir/b.md", "../escape.md"})

	select {
	case ch := <-w.C():
		if ch.Reconcile {
			t.Fatal("unexpected reconcile")
		}
		want := map[string]bool{"Dir/a.md": true, "Dir/b.md": true}
		if len(ch.Paths) != len(want) {
			t.Fatalf("paths = %v, want exactly %v", ch.Paths, want)
		}
		for _, p := range ch.Paths {
			if !want[p] {
				t.Fatalf("unexpected path %q in %v", p, ch.Paths)
			}
		}
	case <-time.After(5 * time.Second):
		t.Fatal("no change delivered")
	}
}
