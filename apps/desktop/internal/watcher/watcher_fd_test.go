//go:build !js

package watcher

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"sort"
	"strings"
	"testing"
	"time"

	"github.com/rs/zerolog"
)

// openFDs counts the descriptors of this process (macOS and Linux).
func openFDs(t *testing.T) int {
	t.Helper()
	dir := "/dev/fd"
	if runtime.GOOS == "linux" {
		dir = "/proc/self/fd"
	}
	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Skipf("cannot count descriptors: %v", err)
	}
	return len(entries)
}

// TestWatcherDescriptors measures the descriptors a watcher keeps open on a
// large vault (CLARAE_WATCH_FD_DIR, e.g. a perf dataset; it is only read),
// with the platform's source and with plain fsnotify.
func TestWatcherDescriptors(t *testing.T) {
	dir := os.Getenv("CLARAE_WATCH_FD_DIR")
	if dir == "" {
		t.Skip("set CLARAE_WATCH_FD_DIR to a vault to measure")
	}
	files, dirs := 0, 0
	_ = filepath.WalkDir(dir, func(_ string, d os.DirEntry, err error) error {
		if err == nil {
			if d.IsDir() {
				dirs++
			} else {
				files++
			}
		}
		return nil
	})
	measure := func(name string, factory func() (source, error)) string {
		old := sourceFactory
		sourceFactory = factory
		defer func() { sourceFactory = old }()
		before := openFDs(t)
		ctx, cancel := context.WithCancel(context.Background())
		defer cancel()
		start := time.Now()
		w, err := New(ctx, dir, Options{Logger: zerolog.Nop(), ReconcileInterval: -1})
		if err != nil {
			return fmt.Sprintf("%s: %v", name, err)
		}
		took := time.Since(start)
		after := openFDs(t)
		_ = w.Close()
		return fmt.Sprintf("%s: %d descriptors (%d -> %d), degraded folders %d, start %v", name, after-before, before, after, w.Degraded(), took.Round(time.Millisecond))
	}
	out := []string{
		measure("platform source", newSource),
		measure("fsnotify", newFsnotifySource),
	}
	sort.Strings(out)
	t.Logf("vault %s: %d files in %d folders\n%s", dir, files, dirs, strings.Join(out, "\n"))
}
