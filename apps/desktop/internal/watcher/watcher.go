// Package watcher reports file system changes of a vault: fsnotify events
// (recursive, debounced and coalesced per path) plus a periodic
// reconciliation pass, because fsnotify is not reliable on every platform
// and volume (§2.5 "watcher", risk register).
package watcher

import (
	"context"
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/fsnotify/fsnotify"
	"github.com/rs/zerolog"

	"memobrain/shared/pathrules"
)

// Change is a batch of vault-relative paths that may have changed (created,
// modified, renamed or deleted). Consumers re-stat each path to learn what
// happened; the watcher deliberately does not try to classify events.
type Change struct {
	Paths []string
	// Reconcile is true for the periodic full pass (Paths is then empty and
	// the consumer should compare its own state with the disk).
	Reconcile bool
}

// Options tune the watcher.
type Options struct {
	Debounce          time.Duration // default 1.5 s
	ReconcileInterval time.Duration // default 5 min; 0 disables
	Logger            zerolog.Logger
}

// source delivers raw file system events: fsnotify on the desktop (notifier_native.go), nothing in
// the browser build (notifier_js.go), where Notify reports the changes instead.
type source interface {
	Add(path string) error
	Close() error
	Events() <-chan fsnotify.Event
	Errors() <-chan error
}

// Watcher watches one vault root.
type Watcher struct {
	root string
	opts Options
	fsw  source
	out  chan Change
	done chan struct{} // closed when the loop exits; the out channel is never closed

	mu      sync.Mutex
	pending map[string]struct{}
	timer   *time.Timer
}

// New starts watching root (recursively). Changes are delivered on C().
func New(ctx context.Context, root string, opts Options) (*Watcher, error) {
	if opts.Debounce <= 0 {
		opts.Debounce = 1500 * time.Millisecond
	}
	if opts.ReconcileInterval < 0 {
		opts.ReconcileInterval = 0
	} else if opts.ReconcileInterval == 0 {
		opts.ReconcileInterval = 5 * time.Minute
	}
	fsw, err := newSource()
	if err != nil {
		return nil, err
	}
	w := &Watcher{root: root, opts: opts, fsw: fsw, out: make(chan Change, 16), done: make(chan struct{}), pending: map[string]struct{}{}}
	if err := w.addRecursive(root); err != nil {
		_ = fsw.Close()
		return nil, err
	}
	go w.loop(ctx)
	return w, nil
}

// C delivers debounced change batches. The channel is never closed: stop
// reading when the context given to New is cancelled.
func (w *Watcher) C() <-chan Change { return w.out }

// Close stops the watcher.
func (w *Watcher) Close() error { return w.fsw.Close() }

func (w *Watcher) addRecursive(dir string) error {
	return filepath.WalkDir(dir, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return nil //nolint:nilerr // unreadable subtree: skip
		}
		if !d.IsDir() {
			return nil
		}
		rel, _ := filepath.Rel(w.root, path)
		if rel != "." && w.skipDir(filepath.ToSlash(rel)) {
			return fs.SkipDir
		}
		if err := w.fsw.Add(path); err != nil {
			w.opts.Logger.Warn().Err(err).Str("dir", path).Msg("watch add failed")
		}
		return nil
	})
}

// skipDir excludes local-only folders whose churn is noise (caches, git).
func (w *Watcher) skipDir(rel string) bool {
	if rel == ".git" || strings.HasPrefix(rel, ".git/") {
		return true
	}
	return pathrules.IsExcluded(rel, false)
}

func (w *Watcher) loop(ctx context.Context) {
	defer close(w.done)
	var reconcile <-chan time.Time
	if w.opts.ReconcileInterval > 0 {
		t := time.NewTicker(w.opts.ReconcileInterval)
		defer t.Stop()
		reconcile = t.C
	}
	for {
		select {
		case <-ctx.Done():
			return
		case ev, ok := <-w.fsw.Events():
			if !ok {
				return
			}
			w.handle(ev)
		case err, ok := <-w.fsw.Errors():
			if !ok {
				return
			}
			w.opts.Logger.Warn().Err(err).Msg("fsnotify error")
		case <-reconcile:
			select {
			case w.out <- Change{Reconcile: true}:
			case <-ctx.Done():
			}
		}
	}
}

func (w *Watcher) handle(ev fsnotify.Event) {
	rel, err := filepath.Rel(w.root, ev.Name)
	if err != nil {
		return
	}
	rel = filepath.ToSlash(rel)
	if _, base := pathrules.Split(rel); strings.HasPrefix(base, ".memobrain-tmp-") {
		return // our own atomic-write temporaries
	}
	normalized, err := pathrules.Normalize(rel)
	if err != nil || pathrules.IsExcluded(normalized, false) {
		return
	}
	var existing []string
	// New folders must be watched too (fsnotify is not recursive). Files
	// created before the watch was in place raise no event, so everything
	// already inside the new folder is reported explicitly.
	if ev.Has(fsnotify.Create) {
		if st, err := os.Lstat(ev.Name); err == nil && st.IsDir() && !w.skipDir(normalized) {
			_ = w.addRecursive(ev.Name)
			existing = w.listBelow(ev.Name)
		}
	}
	w.queue(append(existing, normalized))
}

// Notify reports vault-relative paths that changed without a file system event: the browser build,
// which has no fsnotify, learns of its own writes this way (vault.FS.SetOnChange). Paths go through
// the same filtering, debouncing and coalescing as events.
func (w *Watcher) Notify(paths []string) {
	var keep []string
	for _, p := range paths {
		if _, base := pathrules.Split(p); strings.HasPrefix(base, ".memobrain-tmp-") {
			continue
		}
		if n, err := pathrules.Normalize(p); err == nil && !pathrules.IsExcluded(n, false) {
			keep = append(keep, n)
		}
	}
	if len(keep) > 0 {
		w.queue(keep)
	}
}

func (w *Watcher) queue(paths []string) {
	w.mu.Lock()
	for _, p := range paths {
		w.pending[p] = struct{}{}
	}
	if w.timer == nil {
		w.timer = time.AfterFunc(w.opts.Debounce, w.flush)
	} else {
		w.timer.Reset(w.opts.Debounce)
	}
	w.mu.Unlock()
}

// listBelow returns the vault-relative paths of everything inside dir.
func (w *Watcher) listBelow(dir string) []string {
	var out []string
	_ = filepath.WalkDir(dir, func(path string, _ fs.DirEntry, err error) error {
		if err != nil || path == dir {
			return nil //nolint:nilerr // unreadable entries are skipped
		}
		rel, err := filepath.Rel(w.root, path)
		if err != nil {
			return nil //nolint:nilerr // outside the root: ignore
		}
		if n, err := pathrules.Normalize(filepath.ToSlash(rel)); err == nil && !pathrules.IsExcluded(n, false) {
			out = append(out, n)
		}
		return nil
	})
	return out
}

func (w *Watcher) flush() {
	w.mu.Lock()
	paths := make([]string, 0, len(w.pending))
	for p := range w.pending {
		paths = append(paths, p)
	}
	w.pending = map[string]struct{}{}
	w.timer = nil
	w.mu.Unlock()
	if len(paths) == 0 {
		return
	}
	sort.Strings(paths)
	select {
	case w.out <- Change{Paths: paths}:
	case <-w.done:
	case <-time.After(5 * time.Second):
		w.opts.Logger.Warn().Int("paths", len(paths)).Msg("watcher consumer too slow; batch dropped")
	}
}

// IsNotExist helps consumers classify a re-stat after a change.
func IsNotExist(err error) bool { return errors.Is(err, fs.ErrNotExist) }
