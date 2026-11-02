// Package watcher reports file system changes of a vault: file system events
// (FSEvents on macOS, fsnotify elsewhere; recursive, debounced and coalesced
// per path) plus a periodic reconciliation pass, because events are not
// reliable on every platform and volume (§2.5 "watcher", risk register).
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
	"syscall"
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
	MaxWait           time.Duration // default 2 s, at least Debounce: a writer that never pauses cannot postpone a change longer
	ReconcileInterval time.Duration // default 5 min (none in the browser); negative disables
	Logger            zerolog.Logger
}

// source delivers raw file system events: FSEvents on macOS (notifier_darwin.go), fsnotify on the
// other desktops (notifier_fsnotify.go), nothing in the browser build (notifier_js.go), where Notify
// reports the changes instead. An event with no Op asks for a reconciliation (events were lost).
type source interface {
	// Recursive sources watch a whole tree from one Add of its root; the
	// others need an Add per folder.
	Recursive() bool
	Add(path string) error
	Close() error
	Events() <-chan fsnotify.Event
	Errors() <-chan error
}

// Watcher watches one vault root.
type Watcher struct {
	root     string
	realRoot string // root with symlinks resolved: FSEvents reports real paths
	opts     Options
	fsw      source
	out      chan Change
	done     chan struct{} // closed when the loop exits; the out channel is never closed

	mu      sync.Mutex
	pending map[string]struct{}
	timer   *time.Timer
	first   time.Time // when the oldest pending path was queued

	// degraded counts the folders a per-folder source could not watch (the
	// inotify or descriptor limit): their changes are only found by the
	// reconciliation, which then runs more often. Guarded by mu.
	degraded int
}

// New starts watching root (recursively). Changes are delivered on C().
func New(ctx context.Context, root string, opts Options) (*Watcher, error) {
	if opts.Debounce <= 0 {
		opts.Debounce = 1500 * time.Millisecond
	}
	if opts.MaxWait <= 0 {
		opts.MaxWait = 2 * time.Second
	}
	opts.MaxWait = max(opts.MaxWait, opts.Debounce)
	if opts.ReconcileInterval < 0 {
		opts.ReconcileInterval = 0
	} else if opts.ReconcileInterval == 0 {
		opts.ReconcileInterval = defaultReconcileInterval
	}
	fsw, err := sourceFactory()
	if err != nil {
		return nil, err
	}
	real, err := filepath.EvalSymlinks(root)
	if err != nil {
		real = root
	}
	w := &Watcher{root: root, realRoot: real, opts: opts, fsw: fsw, out: make(chan Change, 16), done: make(chan struct{}), pending: map[string]struct{}{}}
	if fsw.Recursive() {
		err = fsw.Add(root)
	} else {
		err = w.addRecursive(root)
	}
	if err != nil {
		_ = fsw.Close()
		return nil, err
	}
	if n := w.Degraded(); n > 0 {
		w.opts.Logger.Warn().Int("folders", n).Dur("reconcile", degradedReconcileInterval).
			Msg("watch limit reached: changes in the unwatched folders are found by the periodic reconciliation")
		if w.opts.ReconcileInterval == 0 || w.opts.ReconcileInterval > degradedReconcileInterval {
			w.opts.ReconcileInterval = degradedReconcileInterval
		}
	}
	go w.loop(ctx)
	return w, nil
}

// sourceFactory builds the event source (replaced in tests).
var sourceFactory = newSource

// degradedReconcileInterval is the reconciliation period while some folders
// could not be watched.
const degradedReconcileInterval = time.Minute

// Degraded returns how many folders are not watched because a system limit
// was reached (0: everything is watched).
func (w *Watcher) Degraded() int {
	w.mu.Lock()
	defer w.mu.Unlock()
	return w.degraded
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
		w.mu.Lock()
		limited := w.degraded > 0
		w.mu.Unlock()
		if limited {
			// Past a limit every further Add fails as well: count, don't try.
			w.mu.Lock()
			w.degraded++
			w.mu.Unlock()
			return nil
		}
		if err := w.fsw.Add(path); err != nil {
			if !isLimit(err) {
				w.opts.Logger.Warn().Err(err).Str("dir", path).Msg("watch add failed")
				return nil
			}
			w.mu.Lock()
			w.degraded++
			w.mu.Unlock()
		}
		return nil
	})
}

// isLimit reports a system limit on watches or descriptors (inotify's
// max_user_watches gives ENOSPC, descriptors EMFILE/ENFILE).
func isLimit(err error) bool {
	return errors.Is(err, syscall.ENOSPC) || errors.Is(err, syscall.EMFILE) || errors.Is(err, syscall.ENFILE)
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
			if ev.Op == 0 { // the source lost events: compare everything
				w.reconcile(ctx)
				continue
			}
			w.handle(ev)
		case err, ok := <-w.fsw.Errors():
			if !ok {
				return
			}
			if errors.Is(err, fsnotify.ErrEventOverflow) {
				// The kernel queue overflowed (inotify IN_Q_OVERFLOW): some
				// events are lost, only a full comparison finds those changes.
				w.opts.Logger.Warn().Err(err).Msg("file system events lost; reconciling")
				w.reconcile(ctx)
				continue
			}
			w.opts.Logger.Warn().Err(err).Msg("fsnotify error")
		case <-reconcile:
			w.reconcile(ctx)
		}
	}
}

// reconcile asks the consumer for a full comparison with the disk.
func (w *Watcher) reconcile(ctx context.Context) {
	select {
	case w.out <- Change{Reconcile: true}:
	case <-ctx.Done():
	}
}

func (w *Watcher) handle(ev fsnotify.Event) {
	name := ev.Name
	if w.realRoot != w.root && strings.HasPrefix(name, w.realRoot+string(filepath.Separator)) {
		name = w.root + name[len(w.realRoot):]
	}
	rel, err := filepath.Rel(w.root, name)
	if err != nil || rel == "." || rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) {
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
	if normalized == ".git" || strings.HasPrefix(normalized, ".git/") {
		return // a recursive source also reports the folders addRecursive skips
	}
	var existing []string
	// New folders must be watched too (fsnotify is not recursive). Files
	// created before the watch was in place, or moved in with the folder,
	// raise no event, so everything already inside it is reported explicitly.
	if ev.Has(fsnotify.Create) {
		if st, err := os.Lstat(name); err == nil && st.IsDir() && !w.skipDir(normalized) {
			if !w.fsw.Recursive() {
				_ = w.addRecursive(name)
			}
			existing = w.listBelow(name)
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

// queue adds paths to the pending batch. Every event postpones the delivery
// by Debounce, but never past MaxWait after the oldest pending path.
func (w *Watcher) queue(paths []string) {
	w.mu.Lock()
	for _, p := range paths {
		w.pending[p] = struct{}{}
	}
	if w.timer == nil {
		w.first = time.Now()
		w.timer = time.AfterFunc(w.opts.Debounce, w.flush)
	} else {
		left := max(w.opts.MaxWait-time.Since(w.first), 0)
		w.timer.Reset(min(w.opts.Debounce, left))
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
	case <-time.After(consumerTimeout):
		// Dropping the batch would lose these changes until the next
		// reconciliation: they go back to the pending set and are delivered
		// with the next batch.
		w.opts.Logger.Warn().Int("paths", len(paths)).Msg("watcher consumer too slow; batch postponed")
		w.queue(paths)
	}
}

// consumerTimeout is how long flush waits for the consumer to take a batch
// before putting it back (a variable for the tests).
var consumerTimeout = 5 * time.Second

// IsNotExist helps consumers classify a re-stat after a change.
func IsNotExist(err error) bool { return errors.Is(err, fs.ErrNotExist) }
