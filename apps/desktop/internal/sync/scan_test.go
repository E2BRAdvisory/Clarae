package sync

import (
	"context"
	"os"
	"path/filepath"
	"strconv"
	stdsync "sync"
	"testing"
	"time"
)

// countHashes makes e count (and record) the files it hashes.
func countHashes(e *Engine) func() []string {
	var mu stdsync.Mutex
	var hashed []string
	inner := e.hashFile
	e.hashFile = func(rel string) (string, int64, error) {
		mu.Lock()
		hashed = append(hashed, rel)
		mu.Unlock()
		return inner(rel)
	}
	return func() []string {
		mu.Lock()
		defer mu.Unlock()
		return append([]string(nil), hashed...)
	}
}

func setMtime(t *testing.T, dir, path string, mtime time.Time) {
	t.Helper()
	if err := os.Chtimes(filepath.Join(dir, path), mtime, mtime); err != nil {
		t.Fatal(err)
	}
}

func mtimeOf(t *testing.T, dir, path string) time.Time {
	t.Helper()
	st, err := os.Stat(filepath.Join(dir, path))
	if err != nil {
		t.Fatal(err)
	}
	return st.ModTime()
}

// scanVault prepares synced files with an mtime an hour old and runs one
// complete scan, as a previous run of the application would have left them.
func scanVault(t *testing.T, names ...string) (*Engine, string, map[string]File) {
	t.Helper()
	remote := newScriptRemote()
	e, dir := newTestEngine(t, remote, 0)
	old := time.Now().Add(-time.Hour).Truncate(time.Second)
	rows := map[string]File{}
	for _, n := range names {
		f := syncedFile(t, e, remote, dir, n, []byte("content of "+n+"\n"))
		setMtime(t, dir, n, old)
		f.LocalMtime = old.UnixNano()
		if err := e.cfg.DB.PutFile(context.Background(), f); err != nil {
			t.Fatal(err)
		}
		rows[n] = f
	}
	if err := e.scan(context.Background()); err != nil {
		t.Fatal(err)
	}
	return e, dir, rows
}

// The first scan of a new engine (an application start) trusts the files the
// previous run already verified: it reads none of them.
func TestFirstScanAfterRestartDoesNotRehash(t *testing.T) {
	e, _, _ := scanVault(t, "a.md", "b.md", "sub/c.md")
	e2 := New(e.cfg)
	hashed := countHashes(e2)
	if err := e2.scan(context.Background()); err != nil {
		t.Fatal(err)
	}
	if h := hashed(); len(h) != 0 {
		t.Fatalf("first scan after a restart hashed %v, want nothing", h)
	}
	if n, _ := e2.cfg.DB.PendingCount(context.Background()); n != 0 {
		t.Fatalf("%d files pending on an unchanged vault", n)
	}
}

// A file rewritten right after the last scan, inside the same timestamp tick
// (same size, same mtime as recorded), is still detected after a restart.
func TestFirstScanAfterRestartCatchesRacyWrite(t *testing.T) {
	ctx := context.Background()
	remote := newScriptRemote()
	e, dir := newTestEngine(t, remote, 0)
	syncedFile(t, e, remote, dir, "a.md", []byte("version one\n"))
	syncedFile(t, e, remote, dir, "b.md", []byte("untouched\n"))
	setMtime(t, dir, "b.md", time.Now().Add(-time.Hour))
	if err := e.scan(ctx); err != nil {
		t.Fatal(err)
	}
	recorded := mtimeOf(t, dir, "a.md")
	writeFile(t, dir, "a.md", []byte("version two\n")) // same length
	setMtime(t, dir, "a.md", recorded)                 // a coarse clock: the mtime does not move

	e2 := New(e.cfg)
	hashed := countHashes(e2)
	if err := e2.scan(ctx); err != nil {
		t.Fatal(err)
	}
	if h := hashed(); len(h) != 1 || h[0] != "a.md" {
		t.Fatalf("hashed %v, want only the racy a.md", h)
	}
	row := parked(t, e2, "a.md")
	if row.State != StateLocalModify || row.LocalHash != hashOf([]byte("version two\n")) {
		t.Fatalf("a.md row %+v: the rewrite inside the racy window was missed", row)
	}
}

// A file changed while the application was closed has a new mtime: it is
// rehashed (and only it), even with the same size.
func TestFirstScanAfterRestartCatchesOfflineEdit(t *testing.T) {
	ctx := context.Background()
	e, dir, rows := scanVault(t, "a.md", "b.md")
	writeFile(t, dir, "a.md", []byte("CONTENT OF a.md\n")) // same length
	setMtime(t, dir, "a.md", time.Unix(0, rows["a.md"].LocalMtime).Add(17*time.Minute))

	e2 := New(e.cfg)
	hashed := countHashes(e2)
	if err := e2.scan(ctx); err != nil {
		t.Fatal(err)
	}
	if h := hashed(); len(h) != 1 || h[0] != "a.md" {
		t.Fatalf("hashed %v, want only a.md", h)
	}
	if row := parked(t, e2, "a.md"); row.State != StateLocalModify {
		t.Fatalf("a.md state %s, want %s", row.State, StateLocalModify)
	}
}

// Without a usable scan time nothing is trusted: the value is missing (first
// run of this version) or in the future (the clock went back).
func TestFirstScanWithoutUsableScanTimeRehashes(t *testing.T) {
	ctx := context.Background()
	for _, tc := range []struct {
		name  string
		setup func(e *Engine)
	}{
		{"missing", func(e *Engine) {
			if err := e.cfg.DB.DeleteMeta(ctx, MetaLastScan); err != nil {
				t.Fatal(err)
			}
		}},
		{"clock went back", func(e *Engine) {
			last, err := e.cfg.DB.Meta(ctx, MetaLastScan)
			if err != nil || last == "" {
				t.Fatalf("scan time not stored (%q, %v)", last, err)
			}
			ns, _ := strconv.ParseInt(last, 10, 64)
			e.cfg.Now = func() time.Time { return time.Unix(0, ns).Add(-10 * time.Minute) }
		}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			e, _, _ := scanVault(t, "a.md", "b.md", "c.md")
			tc.setup(e)
			e2 := New(e.cfg)
			hashed := countHashes(e2)
			if err := e2.scan(ctx); err != nil {
				t.Fatal(err)
			}
			if h := hashed(); len(h) != 3 {
				t.Fatalf("hashed %v, want every file", h)
			}
			// The scan time is stored again: the next start trusts the files.
			e3 := New(e.cfg)
			e3.cfg.Now = time.Now
			hashed = countHashes(e3)
			if err := e3.scan(ctx); err != nil {
				t.Fatal(err)
			}
			if h := hashed(); len(h) != 0 {
				t.Fatalf("scan after the store hashed %v", h)
			}
		})
	}
}

// An interrupted scan does not store its start: the rows it did not reach
// were never verified against the disk.
func TestInterruptedScanKeepsPreviousScanTime(t *testing.T) {
	ctx := context.Background()
	e, _, _ := scanVault(t, "a.md")
	before, _ := e.cfg.DB.Meta(ctx, MetaLastScan)
	cctx, cancel := context.WithCancel(ctx)
	cancel()
	e2 := New(e.cfg)
	e2.cfg.Now = func() time.Time { return time.Now().Add(time.Hour) }
	if err := e2.scan(cctx); err == nil {
		t.Fatal("cancelled scan succeeded")
	}
	if after, _ := e.cfg.DB.Meta(ctx, MetaLastScan); after != before {
		t.Fatalf("scan time moved from %s to %s after an interrupted scan", before, after)
	}
}
