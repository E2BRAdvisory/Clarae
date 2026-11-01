package indexer

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"testing"
	"time"
)

func (v *testVault) count(q string) int {
	v.t.Helper()
	var n int
	if err := v.ix.db.QueryRowContext(v.ctx, q).Scan(&n); err != nil {
		v.t.Fatal(err)
	}
	return n
}

// An Update of content that is already indexed (the watcher reporting a
// write a binding has just indexed) only refreshes the stat columns: the
// derived rows and the FTS row are not written again.
func TestUpdateSkipsIdenticalContent(t *testing.T) {
	v := newTestVault(t)
	v.write("a.md", "# A\n\n[[b]] #tag\n")
	if err := v.ix.Update(v.ctx, []string{"a.md"}); err != nil {
		t.Fatal(err)
	}
	// A marker row a re-parse would delete with the other derived rows.
	if _, err := v.ix.db.ExecContext(v.ctx, `INSERT INTO headings (path, level, text, line) VALUES ('a.md', 9, 'marker', 99)`); err != nil {
		t.Fatal(err)
	}
	if err := v.ix.Update(v.ctx, []string{"a.md"}); err != nil {
		t.Fatal(err)
	}
	if v.count(`SELECT count(*) FROM headings WHERE text = 'marker'`) != 1 {
		t.Fatal("identical content was parsed and written again")
	}
	v.write("a.md", "# A changed\n")
	if err := v.ix.Update(v.ctx, []string{"a.md"}); err != nil {
		t.Fatal(err)
	}
	if v.count(`SELECT count(*) FROM headings WHERE text = 'marker'`) != 0 || v.count(`SELECT count(*) FROM headings WHERE text = 'A changed'`) != 1 {
		t.Fatal("changed content not indexed")
	}
	if v.count(`SELECT body_bytes FROM files WHERE path = 'a.md'`) != len("# A changed\n") {
		t.Fatal("body_bytes not stored")
	}
}

// A folder Update indexes what lies below that folder only, and removing a
// large folder drops all of it (in a few transactions, not one per file).
func TestUpdateFolderAndRemoveFolder(t *testing.T) {
	v := newTestVault(t)
	v.write("outside.md", "x")
	const n = 1200
	for i := 0; i < n; i++ {
		v.write(fmt.Sprintf("Big/sub%d/n%04d.md", i%7, i), fmt.Sprintf("# %d\naliases: none\n", i))
	}
	if err := v.ix.Update(v.ctx, []string{"Big"}); err != nil {
		t.Fatal(err)
	}
	if got := v.count(`SELECT count(*) FROM files`); got != n {
		t.Fatalf("indexed %d files, want %d (outside.md must not be walked)", got, n)
	}
	if err := os.RemoveAll(filepath.Join(v.root, "Big")); err != nil {
		t.Fatal(err)
	}
	if err := v.ix.Update(v.ctx, []string{"Big"}); err != nil {
		t.Fatal(err)
	}
	if got := v.count(`SELECT count(*) FROM files`) + v.count(`SELECT count(*) FROM headings`) + v.count(`SELECT count(*) FROM fts_content`); got != 0 {
		t.Fatalf("%d rows left after removing the folder", got)
	}
}

// A cancelled Full returns without leaving preparation workers blocked.
func TestFullCancelLeavesNoWorkers(t *testing.T) {
	v := newTestVault(t)
	for i := 0; i < 3*batchMaxJobs; i++ {
		v.write(fmt.Sprintf("n%04d.md", i), fmt.Sprintf("# note %d\n", i))
	}
	before := runtime.NumGoroutine()
	ctx, cancel := context.WithCancel(v.ctx)
	setFullBatchHook(t, cancel)
	if err := v.ix.Full(ctx); !errors.Is(err, context.Canceled) {
		t.Fatalf("Full = %v, want context.Canceled", err)
	}
	deadline := time.Now().Add(5 * time.Second)
	for runtime.NumGoroutine() > before && time.Now().Before(deadline) {
		time.Sleep(10 * time.Millisecond)
	}
	if g := runtime.NumGoroutine(); g > before {
		buf := make([]byte, 1<<16)
		t.Fatalf("%d goroutines left (was %d):\n%s", g, before, buf[:runtime.Stack(buf, true)])
	}
	// The index is still usable: a new Full completes it.
	if err := v.ix.Full(v.ctx); err != nil {
		t.Fatal(err)
	}
	v.assertMatchesDisk()
}
