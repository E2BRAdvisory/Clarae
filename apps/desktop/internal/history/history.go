// Package history keeps device-local snapshots of the text files of a vault ("File recovery",
// §2.2.1): at most one snapshot per file every few minutes while it changes, deduplicated by
// content, pruned by age and total size. Snapshots live under .memobrain/snapshots, which is
// excluded from sync, the index and the file tree, so they never travel and never feed back
// into the watcher.
//
// The snapshotter is driven by the change batches the watcher already delivers (Observe), not
// by a scan: it costs nothing while the vault is idle and sees exactly the files that changed.
package history

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"sync"
	"time"
	"unicode/utf8"

	"github.com/rs/zerolog"

	"memobrain/apps/desktop/internal/vault"
	"memobrain/shared/hashing"
	"memobrain/shared/pathrules"
)

// Reason says why a snapshot was taken.
type Reason string

// Snapshot reasons.
const (
	ReasonPeriodic        Reason = "periodic"
	ReasonPreRestore      Reason = "pre-restore"
	ReasonPreSyncOverride Reason = "pre-sync-overwrite"
)

// Snapshot describes one stored version of a file.
type Snapshot struct {
	ID     string    `json:"id"`
	Path   string    `json:"path"`
	Time   time.Time `json:"time"`
	Size   int64     `json:"size"`
	Hash   string    `json:"hash"`
	Reason Reason    `json:"reason"`
}

// Deleted is a file that no longer exists but still has snapshots.
type Deleted struct {
	Path       string    `json:"path"`
	SnapshotID string    `json:"snapshotId"` // the newest snapshot
	Time       time.Time `json:"time"`
	Size       int64     `json:"size"`
}

// Content is a snapshot together with its text.
type Content struct {
	Snapshot Snapshot `json:"snapshot"`
	Content  string   `json:"content"`
}

// Settings are the per-vault history settings (stored in .memobrain/history.json).
type Settings struct {
	IntervalMinutes int `json:"intervalMinutes"` // minimum time between two snapshots of a file
	RetentionDays   int `json:"retentionDays"`
	MaxFileMB       int `json:"maxFileMb"`  // larger files are not snapshotted
	MaxTotalMB      int `json:"maxTotalMb"` // cap on the unique snapshot content
}

// DefaultSettings returns the defaults: 5 minutes, 7 days, 5 MB per file, 500 MB overall.
func DefaultSettings() Settings {
	return Settings{IntervalMinutes: 5, RetentionDays: 7, MaxFileMB: 5, MaxTotalMB: 500}
}

// Normalize replaces missing values with defaults and clamps the rest to sane bounds.
func (s Settings) Normalize() Settings {
	d := DefaultSettings()
	clamp := func(v, def, lo, hi int) int {
		if v == 0 {
			return def
		}
		return max(lo, min(hi, v))
	}
	return Settings{
		IntervalMinutes: clamp(s.IntervalMinutes, d.IntervalMinutes, 1, 24*60),
		RetentionDays:   clamp(s.RetentionDays, d.RetentionDays, 1, 3650),
		MaxFileMB:       clamp(s.MaxFileMB, d.MaxFileMB, 1, 1024),
		MaxTotalMB:      clamp(s.MaxTotalMB, d.MaxTotalMB, 10, 1<<20),
	}
}

const settingsFile = pathrules.ConfigDir + "/history.json"

// Errors.
var (
	ErrReadOnly = errors.New("history: vault is read-only")
	ErrSkipped  = errors.New("history: file is not eligible for a snapshot")
)

// Options configure a History.
type Options struct {
	FS     *vault.FS
	Logger zerolog.Logger
	// Now is the clock (tests inject a fake one).
	Now func() time.Time
	// ReadOnly reports whether the vault may not be changed (viewer on a share): no snapshots, no restore.
	ReadOnly func() bool
}

// History is the snapshot store of one open vault.
type History struct {
	fs       *vault.FS
	root     string
	log      zerolog.Logger
	now      func() time.Time
	readOnly func() bool

	mu       sync.Mutex // guards the files under .memobrain/snapshots and the fields below
	settings Settings
	last     map[string]time.Time // newest snapshot time per path (lazy cache)
	pending  map[string]struct{}  // paths seen changing, waiting for their interval

	wake   chan struct{}
	cancel context.CancelFunc
	done   chan struct{}
}

// New creates the store and loads its settings.
func New(o Options) *History {
	h := &History{
		fs: o.FS, root: o.FS.Root(), log: o.Logger, now: o.Now, readOnly: o.ReadOnly,
		last: map[string]time.Time{}, pending: map[string]struct{}{}, wake: make(chan struct{}, 1),
	}
	if h.now == nil {
		h.now = time.Now
	}
	if h.readOnly == nil {
		h.readOnly = func() bool { return false }
	}
	h.settings = LoadSettings(h.root)
	return h
}

// LoadSettings reads .memobrain/history.json (defaults when absent or invalid).
func LoadSettings(root string) Settings {
	data, err := os.ReadFile(filepath.Join(root, filepath.FromSlash(settingsFile)))
	var s Settings
	if err == nil {
		_ = json.Unmarshal(data, &s)
	}
	return s.Normalize()
}

// Settings returns the current settings.
func (h *History) Settings() Settings {
	h.mu.Lock()
	defer h.mu.Unlock()
	return h.settings
}

// SetSettings validates, persists and applies new settings, then prunes with them.
func (h *History) SetSettings(s Settings) (Settings, error) {
	s = s.Normalize()
	data, err := json.MarshalIndent(s, "", "  ")
	if err != nil {
		return Settings{}, err
	}
	if err := writeAtomic(filepath.Join(h.root, filepath.FromSlash(settingsFile)), append(data, '\n')); err != nil {
		return Settings{}, err
	}
	h.mu.Lock()
	h.settings = s
	h.pruneLocked()
	h.mu.Unlock()
	return s, nil
}

// Start launches the background worker: snapshots of observed changes, a prune at startup and
// then hourly. It returns immediately; Close stops it.
func (h *History) Start(ctx context.Context) {
	ctx, h.cancel = context.WithCancel(ctx)
	h.done = make(chan struct{})
	go func() {
		defer close(h.done)
		h.Prune()
		tick := time.NewTicker(30 * time.Second)
		defer tick.Stop()
		lastPrune := time.Now()
		for {
			select {
			case <-ctx.Done():
				return
			case <-h.wake:
			case <-tick.C:
				if time.Since(lastPrune) >= time.Hour {
					h.Prune()
					lastPrune = time.Now()
				}
			}
			h.Flush()
		}
	}()
}

// Close stops the worker.
func (h *History) Close() {
	if h.cancel != nil {
		h.cancel()
		<-h.done
	}
}

// Observe records that these vault-relative paths changed (a watcher batch). The snapshot is
// taken by the worker, without blocking the caller.
func (h *History) Observe(paths []string) {
	h.mu.Lock()
	for _, p := range paths {
		if eligiblePath(p) {
			h.pending[p] = struct{}{}
		}
	}
	h.mu.Unlock()
	select {
	case h.wake <- struct{}{}:
	default:
	}
}

// eligiblePath keeps user content only: not the configuration folder, the trash, temporary or
// OS files.
func eligiblePath(p string) bool {
	n, err := pathrules.Normalize(p)
	if err != nil || n != p {
		return false
	}
	return !pathrules.HasPrefix(n, pathrules.ConfigDir) && !pathrules.IsExcluded(n, true)
}

func (h *History) lastOfLocked(path string) time.Time {
	if t, ok := h.last[path]; ok {
		return t
	}
	var t time.Time
	if s, ok := h.latest(path); ok {
		t = s.Time
	}
	h.last[path] = t
	return t
}

// Flush snapshots every pending file whose interval has elapsed; the others stay pending.
func (h *History) Flush() {
	if h.readOnly() {
		h.mu.Lock()
		h.pending = map[string]struct{}{}
		h.mu.Unlock()
		return
	}
	h.mu.Lock()
	now := h.now()
	interval := time.Duration(h.settings.IntervalMinutes) * time.Minute
	var due []string
	for p := range h.pending {
		if now.Sub(h.lastOfLocked(p)) >= interval {
			due = append(due, p)
			delete(h.pending, p)
		}
	}
	h.mu.Unlock()
	sort.Strings(due)
	for _, p := range due {
		if _, _, err := h.Take(p, ReasonPeriodic); err != nil && !errors.Is(err, ErrSkipped) && !os.IsNotExist(err) {
			h.log.Warn().Err(err).Str("path", p).Msg("snapshot")
		}
	}
}

// Take snapshots the current content of a file now (ignoring the interval). It returns false
// when the content equals the newest snapshot (nothing new to keep). ErrSkipped means the file
// is not eligible (binary, too large, excluded).
func (h *History) Take(path string, reason Reason) (Snapshot, bool, error) {
	if h.readOnly() {
		return Snapshot{}, false, ErrReadOnly
	}
	if !eligiblePath(path) {
		return Snapshot{}, false, ErrSkipped
	}
	h.mu.Lock()
	defer h.mu.Unlock()
	c, err := h.fs.ReadFile(path)
	if err != nil {
		return Snapshot{}, false, err
	}
	if c.Size > int64(h.settings.MaxFileMB)<<20 || !isText(c.Data) {
		return Snapshot{}, false, ErrSkipped
	}
	return h.takeDataLocked(path, c.Data, c.Hash, reason)
}

func (h *History) takeDataLocked(path string, data []byte, hash string, reason Reason) (Snapshot, bool, error) {
	if s, ok := h.latest(path); ok && s.Hash == hash {
		return s, false, nil
	}
	s, err := h.put(path, data, hash, reason, h.now())
	if err != nil {
		return Snapshot{}, false, err
	}
	return s, true, nil
}

func isText(b []byte) bool {
	for _, c := range b {
		if c == 0 {
			return false
		}
	}
	return utf8.Valid(b)
}

// List returns the snapshots of a file, newest first.
func (h *History) List(path string) ([]Snapshot, error) {
	n, err := pathrules.Normalize(path)
	if err != nil {
		return nil, err
	}
	h.mu.Lock()
	defer h.mu.Unlock()
	key := pathKey(n)
	out := []Snapshot{}
	for _, ms := range h.metaTimes(key) {
		if s, err := h.readMeta(key, ms); err == nil {
			out = append(out, s)
		}
	}
	return out, nil
}

// Read returns the content of a snapshot.
func (h *History) Read(id string) (Content, error) {
	h.mu.Lock()
	defer h.mu.Unlock()
	return h.readLocked(id)
}

func (h *History) readLocked(id string) (Content, error) {
	key, ms, err := parseID(id)
	if err != nil {
		return Content{}, err
	}
	s, err := h.readMeta(key, ms)
	if err != nil {
		if os.IsNotExist(err) {
			return Content{}, ErrNotFound
		}
		return Content{}, err
	}
	data, err := os.ReadFile(h.blobPath(s.Hash))
	if err != nil {
		return Content{}, fmt.Errorf("snapshot content is missing: %w", err)
	}
	if hashing.Sum(data).Hex() != s.Hash {
		return Content{}, errors.New("snapshot content is corrupt")
	}
	return Content{Snapshot: s, Content: string(data)}, nil
}

// ListDeleted returns the files that no longer exist but have snapshots, newest first.
func (h *History) ListDeleted() ([]Deleted, error) {
	h.mu.Lock()
	defer h.mu.Unlock()
	out := []Deleted{}
	for _, list := range h.allMetas() {
		s := list[0]
		if h.exists(s.Path) {
			continue
		}
		out = append(out, Deleted{Path: s.Path, SnapshotID: s.ID, Time: s.Time, Size: s.Size})
	}
	sort.Slice(out, func(i, j int) bool {
		if !out[i].Time.Equal(out[j].Time) {
			return out[i].Time.After(out[j].Time)
		}
		return out[i].Path < out[j].Path
	})
	return out, nil
}

// Restore writes a snapshot back over its file (recreating it if it was deleted). Nothing is
// lost: the current content is snapshotted first ("pre-restore") and the write is guarded by
// the hash just read, so a concurrent external edit aborts the restore. It returns the new hash.
func (h *History) Restore(id string) (path, hash string, err error) {
	if h.readOnly() {
		return "", "", ErrReadOnly
	}
	h.mu.Lock()
	defer h.mu.Unlock()
	snap, err := h.readLocked(id)
	if err != nil {
		return "", "", err
	}
	path = snap.Snapshot.Path
	if !eligiblePath(path) {
		return "", "", ErrSkipped
	}
	cur, err := h.fs.ReadFile(path)
	exists := err == nil
	if err != nil && !os.IsNotExist(err) {
		return "", "", err
	}
	if exists {
		if cur.Hash == snap.Snapshot.Hash {
			return path, cur.Hash, nil // already that version
		}
		// The size cap and the text check do not apply here: whatever is about to be
		// overwritten must be kept.
		if _, _, err := h.takeDataLocked(path, cur.Data, cur.Hash, ReasonPreRestore); err != nil {
			return "", "", fmt.Errorf("cannot keep the current version before restoring: %w", err)
		}
	}
	expected := ""
	if exists {
		expected = cur.Hash
	}
	w, err := h.fs.WriteFile(path, []byte(snap.Content), expected, !exists)
	if err != nil {
		return "", "", err
	}
	return path, w.Hash, nil
}
