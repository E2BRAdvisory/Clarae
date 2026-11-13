package watcher

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"syscall"
	"testing"
	"time"

	"github.com/fsnotify/fsnotify"
	"github.com/rs/zerolog"
)

// waitPaths collects change batches until every wanted path was reported.
func waitPaths(t *testing.T, w *Watcher, want ...string) {
	t.Helper()
	missing := map[string]bool{}
	for _, p := range want {
		missing[p] = true
	}
	deadline := time.After(10 * time.Second)
	for len(missing) > 0 {
		select {
		case ch := <-w.C():
			for _, p := range ch.Paths {
				delete(missing, p)
			}
		case <-deadline:
			t.Fatalf("not reported: %v", missing)
		}
	}
}

// In-place writes (no rename), deletions and a folder moved in from outside
// the vault are all reported, whatever the platform's source.
func TestWatcherReportsInPlaceWritesAndMovedFolders(t *testing.T) {
	if runtime.GOOS == "js" {
		t.Skip("the browser build has no file system events")
	}
	root := t.TempDir()
	outside := t.TempDir()
	if err := os.MkdirAll(filepath.Join(root, "Deep", "Er"), 0o755); err != nil {
		t.Fatal(err)
	}
	note := filepath.Join(root, "Deep", "Er", "n.md")
	if err := os.WriteFile(note, []byte("a"), 0o644); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	w, err := New(ctx, root, Options{Debounce: 50 * time.Millisecond, ReconcileInterval: -1, Logger: zerolog.Nop()})
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = w.Close() }()
	time.Sleep(100 * time.Millisecond)

	f, err := os.OpenFile(note, os.O_WRONLY|os.O_APPEND, 0)
	if err != nil {
		t.Fatal(err)
	}
	_, _ = f.WriteString("more")
	_ = f.Close()
	waitPaths(t, w, "Deep/Er/n.md")

	if err := os.Remove(note); err != nil {
		t.Fatal(err)
	}
	waitPaths(t, w, "Deep/Er/n.md")

	moved := filepath.Join(outside, "Imported")
	if err := os.MkdirAll(filepath.Join(moved, "Sub"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(moved, "Sub", "x.md"), []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.Rename(moved, filepath.Join(root, "Imported")); err != nil {
		t.Skipf("cannot move across temp folders: %v", err)
	}
	waitPaths(t, w, "Imported", "Imported/Sub/x.md")
}

// limitedSource is a per-folder source that runs out of watches.
type limitedSource struct {
	left  int
	added []string
}

func (s *limitedSource) Recursive() bool { return false }
func (s *limitedSource) Add(p string) error {
	if s.left == 0 {
		return fmt.Errorf("inotify_add_watch: %w", syscall.ENOSPC)
	}
	s.left--
	s.added = append(s.added, p)
	return nil
}
func (s *limitedSource) Close() error                  { return nil }
func (s *limitedSource) Events() <-chan fsnotify.Event { return nil }
func (s *limitedSource) Errors() <-chan error          { return nil }

// Past the watch limit the remaining folders are counted, not retried one
// by one, and the reconciliation runs every minute.
func TestWatcherDegradedAtWatchLimit(t *testing.T) {
	root := t.TempDir()
	for i := 0; i < 10; i++ {
		if err := os.MkdirAll(filepath.Join(root, fmt.Sprintf("d%02d", i)), 0o755); err != nil {
			t.Fatal(err)
		}
	}
	src := &limitedSource{left: 4}
	old := sourceFactory
	sourceFactory = func() (source, error) { return src, nil }
	defer func() { sourceFactory = old }()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	w, err := New(ctx, root, Options{Logger: zerolog.Nop()})
	if err != nil {
		t.Fatal(err)
	}
	if len(src.added) != 4 || w.Degraded() != 7 { // root + 10 folders, 4 watched
		t.Fatalf("added %d, degraded %d", len(src.added), w.Degraded())
	}
	if w.opts.ReconcileInterval != degradedReconcileInterval {
		t.Fatalf("reconcile every %v", w.opts.ReconcileInterval)
	}
}

// Git internals and the app's own index files are never reported.
func TestWatcherIgnoresGitAndInternals(t *testing.T) {
	if runtime.GOOS == "js" {
		t.Skip("the browser build has no file system events")
	}
	root := t.TempDir()
	for _, d := range []string{".git", ".clarae"} {
		if err := os.MkdirAll(filepath.Join(root, d), 0o755); err != nil {
			t.Fatal(err)
		}
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	w, err := New(ctx, root, Options{Debounce: 50 * time.Millisecond, ReconcileInterval: -1, Logger: zerolog.Nop()})
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = w.Close() }()
	time.Sleep(100 * time.Millisecond)
	for p, c := range map[string]string{".git/HEAD": "ref", ".clarae/index.db-wal": "x", "a.md": "a"} {
		if err := os.WriteFile(filepath.Join(root, filepath.FromSlash(p)), []byte(c), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	deadline := time.After(10 * time.Second)
	for {
		select {
		case ch := <-w.C():
			done := false
			for _, p := range ch.Paths {
				if p == ".git" || p == ".git/HEAD" || p == ".clarae/index.db-wal" {
					t.Fatalf("reported %s", p)
				}
				done = done || p == "a.md"
			}
			if done {
				return
			}
		case <-deadline:
			t.Fatal("a.md not reported")
		}
	}
}
