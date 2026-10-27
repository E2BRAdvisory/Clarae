package history

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/rs/zerolog"

	"memobrain/apps/desktop/internal/indexer"
	"memobrain/apps/desktop/internal/store"
	"memobrain/apps/desktop/internal/vault"
	"memobrain/shared/pathrules"
)

type clock struct {
	mu sync.Mutex
	t  time.Time
}

func (c *clock) Now() time.Time { c.mu.Lock(); defer c.mu.Unlock(); return c.t }
func (c *clock) Advance(d time.Duration) {
	c.mu.Lock()
	c.t = c.t.Add(d)
	c.mu.Unlock()
}

func newHist(t *testing.T) (*History, *vault.FS, *clock) {
	t.Helper()
	fsys, err := vault.NewFS(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	clk := &clock{t: time.Date(2026, 1, 1, 12, 0, 0, 0, time.UTC)}
	return New(Options{FS: fsys, Logger: zerolog.Nop(), Now: clk.Now}), fsys, clk
}

func write(t *testing.T, fsys *vault.FS, rel, content string) {
	t.Helper()
	if _, err := fsys.WriteFile(rel, []byte(content), "", false); err != nil {
		t.Fatal(err)
	}
}

func list(t *testing.T, h *History, rel string) []Snapshot {
	t.Helper()
	s, err := h.List(rel)
	if err != nil {
		t.Fatal(err)
	}
	return s
}

func countBlobs(h *History) int {
	var n int
	_ = filepath.WalkDir(filepath.Join(h.snapDir(), blobsDir), func(_ string, d os.DirEntry, _ error) error {
		if d != nil && !d.IsDir() {
			n++
		}
		return nil
	})
	return n
}

func TestIntervalThrottleAndTrailingEdge(t *testing.T) {
	h, fsys, clk := newHist(t)
	write(t, fsys, "a.md", "v1")
	h.Observe([]string{"a.md"})
	h.Flush()
	if n := len(list(t, h, "a.md")); n != 1 {
		t.Fatalf("leading edge: want 1 snapshot, got %d", n)
	}
	clk.Advance(time.Minute)
	write(t, fsys, "a.md", "v2")
	h.Observe([]string{"a.md"})
	h.Flush()
	if n := len(list(t, h, "a.md")); n != 1 {
		t.Fatalf("within interval: want 1, got %d", n)
	}
	clk.Advance(4 * time.Minute) // 5 min after the first snapshot
	h.Flush()
	got := list(t, h, "a.md")
	if len(got) != 2 {
		t.Fatalf("trailing edge: want 2, got %d", len(got))
	}
	c, err := h.Read(got[0].ID)
	if err != nil || c.Content != "v2" || got[0].Reason != ReasonPeriodic {
		t.Fatalf("newest = %+v %v", c, err)
	}
}

func TestDedupeByContent(t *testing.T) {
	h, fsys, clk := newHist(t)
	write(t, fsys, "a.md", "same")
	if _, created, err := h.Take("a.md", ReasonPeriodic); err != nil || !created {
		t.Fatalf("first: %v %v", created, err)
	}
	clk.Advance(time.Hour)
	if _, created, err := h.Take("a.md", ReasonPeriodic); err != nil || created {
		t.Fatalf("identical content must not create a snapshot (%v, %v)", created, err)
	}
	write(t, fsys, "b.md", "same") // another file, same content: one shared blob
	if _, _, err := h.Take("b.md", ReasonPeriodic); err != nil {
		t.Fatal(err)
	}
	if n := countBlobs(h); n != 1 {
		t.Fatalf("blobs = %d, want 1", n)
	}
}

func TestSkipsBinaryLargeAndExcluded(t *testing.T) {
	h, fsys, _ := newHist(t)
	write(t, fsys, "img.bin", "a\x00b")
	if _, _, err := h.Take("img.bin", ReasonPeriodic); !errors.Is(err, ErrSkipped) {
		t.Fatalf("binary: %v", err)
	}
	if _, err := h.SetSettings(Settings{MaxFileMB: 1}); err != nil {
		t.Fatal(err)
	}
	write(t, fsys, "big.md", strings.Repeat("x", 1<<20+1))
	if _, _, err := h.Take("big.md", ReasonPeriodic); !errors.Is(err, ErrSkipped) {
		t.Fatalf("large: %v", err)
	}
	for _, p := range []string{".memobrain/editor.json", ".memobrain/snapshots/meta/x/1.json", ".trash/a.md", "x.tmp", ".DS_Store"} {
		if _, _, err := h.Take(p, ReasonPeriodic); !errors.Is(err, ErrSkipped) {
			t.Fatalf("%s: %v", p, err)
		}
	}
}

func TestReadOnlyVaultTakesNothing(t *testing.T) {
	fsys, err := vault.NewFS(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	h := New(Options{FS: fsys, Logger: zerolog.Nop(), ReadOnly: func() bool { return true }})
	write(t, fsys, "a.md", "x")
	h.Observe([]string{"a.md"})
	h.Flush()
	if _, _, err := h.Take("a.md", ReasonPeriodic); !errors.Is(err, ErrReadOnly) {
		t.Fatalf("take: %v", err)
	}
	if n := len(list(t, h, "a.md")); n != 0 {
		t.Fatalf("snapshots = %d", n)
	}
	if _, _, err := h.Restore("0123456789abcdef-1"); !errors.Is(err, ErrReadOnly) {
		t.Fatalf("restore: %v", err)
	}
}

func TestPruneRetention(t *testing.T) {
	h, fsys, clk := newHist(t)
	write(t, fsys, "live.md", "1")
	write(t, fsys, "gone.md", "1")
	for _, p := range []string{"live.md", "gone.md"} {
		if _, _, err := h.Take(p, ReasonPeriodic); err != nil {
			t.Fatal(err)
		}
	}
	clk.Advance(24 * time.Hour)
	write(t, fsys, "live.md", "2")
	if _, _, err := h.Take("live.md", ReasonPeriodic); err != nil {
		t.Fatal(err)
	}
	if err := fsys.Delete("gone.md"); err != nil {
		t.Fatal(err)
	}
	clk.Advance(6 * 24 * time.Hour) // v1 snapshots are exactly 7 days old: still retained
	h.Prune()
	if n := len(list(t, h, "live.md")); n != 2 {
		t.Fatalf("at 7 days: live has %d", n)
	}
	clk.Advance(time.Hour)
	h.Prune()
	if n := len(list(t, h, "live.md")); n != 1 {
		t.Fatalf("live after retention = %d, want 1 (newest kept)", n)
	}
	clk.Advance(30 * 24 * time.Hour)
	h.Prune()
	if n := len(list(t, h, "live.md")); n != 1 {
		t.Fatalf("existing file must keep its newest snapshot, has %d", n)
	}
	if n := len(list(t, h, "gone.md")); n != 0 {
		t.Fatalf("deleted file snapshots must expire, has %d", n)
	}
	if d, _ := h.ListDeleted(); len(d) != 0 {
		t.Fatalf("deleted list = %+v", d)
	}
	if n := countBlobs(h); n != 1 {
		t.Fatalf("blobs = %d, want 1", n)
	}
}

func TestPruneTotalSizeCapAndBlobGC(t *testing.T) {
	h, fsys, clk := newHist(t)
	if _, err := h.SetSettings(Settings{MaxTotalMB: 10}); err != nil {
		t.Fatal(err)
	}
	chunk := func(c byte) string { return strings.Repeat(string(c), 4<<20) }
	for _, c := range []byte("abc") { // 3 x 4 MB versions of one file
		write(t, fsys, "a.md", chunk(c))
		if _, _, err := h.Take("a.md", ReasonPeriodic); err != nil {
			t.Fatal(err)
		}
		clk.Advance(time.Minute)
	}
	if removed := h.Prune(); removed != 1 {
		t.Fatalf("removed = %d, want 1", removed)
	}
	got := list(t, h, "a.md")
	if len(got) != 2 {
		t.Fatalf("left %d", len(got))
	}
	c, err := h.Read(got[0].ID)
	if err != nil || c.Content != chunk('c') {
		t.Fatalf("newest must survive: %v", err)
	}
	if n := countBlobs(h); n != 2 {
		t.Fatalf("blobs = %d, want 2 (unreferenced blob collected)", n)
	}
}

func TestListDeletedAndRestoreRecreates(t *testing.T) {
	h, fsys, _ := newHist(t)
	write(t, fsys, "dir/n.md", "precious")
	snap, _, err := h.Take("dir/n.md", ReasonPeriodic)
	if err != nil {
		t.Fatal(err)
	}
	if d, _ := h.ListDeleted(); len(d) != 0 {
		t.Fatalf("existing file listed as deleted: %+v", d)
	}
	if err := fsys.Delete("dir/n.md"); err != nil {
		t.Fatal(err)
	}
	d, _ := h.ListDeleted()
	if len(d) != 1 || d[0].Path != "dir/n.md" || d[0].SnapshotID != snap.ID {
		t.Fatalf("deleted = %+v", d)
	}
	if _, _, err := h.Restore(snap.ID); err != nil {
		t.Fatal(err)
	}
	c, err := fsys.ReadFile("dir/n.md")
	if err != nil || string(c.Data) != "precious" {
		t.Fatalf("restored = %q %v", c.Data, err)
	}
	if d, _ := h.ListDeleted(); len(d) != 0 {
		t.Fatalf("still listed after restore: %+v", d)
	}
}

func TestRestoreKeepsCurrentVersion(t *testing.T) {
	h, fsys, clk := newHist(t)
	write(t, fsys, "a.md", "old")
	old, _, _ := h.Take("a.md", ReasonPeriodic)
	clk.Advance(time.Minute)
	write(t, fsys, "a.md", "unsnapshotted current")
	if _, _, err := h.Restore(old.ID); err != nil {
		t.Fatal(err)
	}
	c, _ := fsys.ReadFile("a.md")
	if string(c.Data) != "old" {
		t.Fatalf("file = %q", c.Data)
	}
	got := list(t, h, "a.md")
	if len(got) != 2 || got[0].Reason != ReasonPreRestore {
		t.Fatalf("snapshots = %+v", got)
	}
	cur, err := h.Read(got[0].ID)
	if err != nil || cur.Content != "unsnapshotted current" {
		t.Fatalf("pre-restore content = %q %v", cur.Content, err)
	}
	// Restoring a version equal to the file is a no-op.
	if _, _, err := h.Restore(old.ID); err != nil || len(list(t, h, "a.md")) != 2 {
		t.Fatalf("no-op restore: %v", err)
	}
}

func TestRestoreKeepsOversizeCurrentVersion(t *testing.T) {
	h, fsys, _ := newHist(t)
	write(t, fsys, "a.md", "old")
	old, _, _ := h.Take("a.md", ReasonPeriodic)
	if _, err := h.SetSettings(Settings{MaxFileMB: 1}); err != nil {
		t.Fatal(err)
	}
	big := strings.Repeat("y", 2<<20)
	write(t, fsys, "a.md", big)
	if _, _, err := h.Restore(old.ID); err != nil {
		t.Fatal(err)
	}
	got := list(t, h, "a.md")
	c, _ := h.Read(got[0].ID)
	if got[0].Reason != ReasonPreRestore || c.Content != big {
		t.Fatal("the oversize current content must be kept before the restore")
	}
}

func TestReadRejectsBadIDs(t *testing.T) {
	h, _, _ := newHist(t)
	for _, id := range []string{"", "../../etc/passwd", "zz-1", "0123456789abcdef-../1", "0123456789abcdef-1"} {
		if _, err := h.Read(id); err == nil {
			t.Fatalf("%q accepted", id)
		}
	}
}

func TestSettingsPersist(t *testing.T) {
	h, fsys, _ := newHist(t)
	if got := h.Settings(); got != DefaultSettings() {
		t.Fatalf("defaults = %+v", got)
	}
	if _, err := h.SetSettings(Settings{IntervalMinutes: 10, RetentionDays: 30, MaxFileMB: 2, MaxTotalMB: 100}); err != nil {
		t.Fatal(err)
	}
	h2 := New(Options{FS: fsys, Logger: zerolog.Nop()})
	if got := h2.Settings(); got.IntervalMinutes != 10 || got.RetentionDays != 30 || got.MaxFileMB != 2 || got.MaxTotalMB != 100 {
		t.Fatalf("reloaded = %+v", got)
	}
	if got, _ := h.SetSettings(Settings{IntervalMinutes: -4, RetentionDays: 99999}); got.IntervalMinutes != 1 || got.RetentionDays != 3650 {
		t.Fatalf("clamped = %+v", got)
	}
}

func TestWorkerSnapshotsObservedChange(t *testing.T) {
	h, fsys, _ := newHist(t)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	h.Start(ctx)
	defer h.Close()
	write(t, fsys, "a.md", "x")
	h.Observe([]string{"a.md"})
	deadline := time.Now().Add(5 * time.Second)
	for len(list(t, h, "a.md")) == 0 {
		if time.Now().After(deadline) {
			t.Fatal("worker did not snapshot")
		}
		time.Sleep(10 * time.Millisecond)
	}
}

// Snapshots must stay invisible to the rest of the app: sync/tree/index exclusion and the walk.
func TestSnapshotsInvisibleToTreeIndexAndSync(t *testing.T) {
	h, fsys, _ := newHist(t)
	write(t, fsys, "a.md", "# Note\ntext")
	if _, _, err := h.Take("a.md", ReasonPeriodic); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(fsys.Root(), ".memobrain", "snapshots")); err != nil {
		t.Fatal(err)
	}
	for _, p := range []string{".memobrain/snapshots", ".memobrain/snapshots/meta/k/1.json", ".memobrain/snapshots/blobs/ab/abcdef"} {
		if !pathrules.IsExcluded(p, false) {
			t.Fatalf("%s not excluded", p)
		}
	}
	tree, err := fsys.ListTree()
	if err != nil {
		t.Fatal(err)
	}
	var seen []string
	for _, e := range tree {
		seen = append(seen, e.Path)
	}
	_ = fsys.Walk(func(e vault.Entry) error { seen = append(seen, e.Path); return nil })
	if len(seen) == 0 {
		t.Fatal("walk saw nothing")
	}
	for _, p := range seen {
		if strings.HasPrefix(p, ".memobrain/snapshots") {
			t.Fatalf("tree/walk exposes %s", p)
		}
	}
	db, err := store.Open(context.Background(), filepath.Join(t.TempDir(), "index.db"), store.KindIndex)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = db.Close() }()
	if err := indexer.New(fsys, db, zerolog.Nop(), nil).Full(context.Background()); err != nil {
		t.Fatal(err)
	}
	rows, err := db.Query(`SELECT path FROM files`)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = rows.Close() }()
	n := 0
	for rows.Next() {
		var p string
		_ = rows.Scan(&p)
		n++
		if strings.HasPrefix(p, ".memobrain") {
			t.Fatalf("indexed %s", p)
		}
	}
	if n == 0 {
		t.Fatal("index is empty")
	}
}
