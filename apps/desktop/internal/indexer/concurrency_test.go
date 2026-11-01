package indexer

import (
	"context"
	"fmt"
	"math/rand/v2"
	"path/filepath"
	"sync"
	"testing"

	"github.com/rs/zerolog"

	"memobrain/apps/desktop/internal/store"
	"memobrain/apps/desktop/internal/vault"
)

type testVault struct {
	ctx  context.Context
	fs   *vault.FS
	ix   *Indexer
	t    *testing.T
	root string
}

func newTestVault(t *testing.T) *testVault {
	t.Helper()
	ctx := context.Background()
	root := t.TempDir()
	fsys, err := vault.NewFS(root)
	if err != nil {
		t.Fatal(err)
	}
	db, err := store.Open(ctx, filepath.Join(root, ".memobrain", "index.db"), store.KindIndex)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = db.Close() })
	return &testVault{ctx: ctx, fs: fsys, ix: New(fsys, db, zerolog.Nop(), nil), t: t, root: root}
}

func (v *testVault) write(p, s string) {
	v.t.Helper()
	if _, err := v.fs.WriteFile(p, []byte(s), "", false); err != nil {
		v.t.Fatal(err)
	}
}

// assertMatchesDisk checks that the index lists exactly the files on disk,
// each with the hash of its current content.
func (v *testVault) assertMatchesDisk() {
	v.t.Helper()
	disk := map[string]string{}
	if err := v.fs.Walk(func(e vault.Entry) error {
		if !e.IsDir {
			c, err := v.fs.ReadFile(e.Path)
			if err != nil {
				return err
			}
			disk[e.Path] = c.Hash
		}
		return nil
	}); err != nil {
		v.t.Fatal(err)
	}
	rows, err := v.ix.db.QueryContext(v.ctx, `SELECT path, hash FROM files`)
	if err != nil {
		v.t.Fatal(err)
	}
	defer func() { _ = rows.Close() }()
	indexed := map[string]string{}
	for rows.Next() {
		var p, h string
		if err := rows.Scan(&p, &h); err != nil {
			v.t.Fatal(err)
		}
		indexed[p] = h
	}
	for p, h := range disk {
		if indexed[p] != h {
			v.t.Errorf("%s: index hash %q, disk %q", p, indexed[p], h)
		}
	}
	for p := range indexed {
		if _, ok := disk[p]; !ok {
			v.t.Errorf("%s: indexed but not on disk", p)
		}
	}
}

func setFullBatchHook(t *testing.T, fn func()) {
	t.Helper()
	var once sync.Once
	testHookFullBatch = func() { once.Do(fn) }
	t.Cleanup(func() { testHookFullBatch = nil })
}

// A Full that read a note before an Update rewrote it must not write the
// older content over the Update's.
func TestFullDoesNotOverwriteNewerUpdate(t *testing.T) {
	v := newTestVault(t)
	v.write("a.md", "# A\n\n#old\n")
	setFullBatchHook(t, func() {
		v.write("a.md", "# A\n\n#new\n")
		if err := v.ix.Update(v.ctx, []string{"a.md"}); err != nil {
			t.Error(err)
		}
	})
	if err := v.ix.Full(v.ctx); err != nil {
		t.Fatal(err)
	}
	v.assertMatchesDisk()
	var tag string
	if err := v.ix.db.QueryRowContext(v.ctx, `SELECT name FROM tags WHERE path = 'a.md'`).Scan(&tag); err != nil || tag != "new" {
		t.Fatalf("tag %q (%v), want new", tag, err)
	}
}

// A note missing at the walk but recreated (and indexed by an Update)
// while the Full runs must not be removed by the Full.
func TestFullDoesNotRemoveRecreatedNote(t *testing.T) {
	v := newTestVault(t)
	v.write("gone.md", "x\n")
	v.write("b.md", "b\n")
	if err := v.ix.Full(v.ctx); err != nil {
		t.Fatal(err)
	}
	if err := v.fs.Delete("gone.md"); err != nil {
		t.Fatal(err)
	}
	v.write("b.md", "b2\n") // so the Full has a batch to write
	setFullBatchHook(t, func() {
		v.write("gone.md", "back\n")
		if err := v.ix.Update(v.ctx, []string{"gone.md"}); err != nil {
			t.Error(err)
		}
	})
	if err := v.ix.Full(v.ctx); err != nil {
		t.Fatal(err)
	}
	v.assertMatchesDisk()
}

// TestFullAlongsideUpdates runs full passes (initial, reconcile, rebuild)
// while notes are rewritten, created and deleted, each change followed by an
// Update as the bindings and the watcher do. Once everything settles the
// index matches the disk without any further pass.
func TestFullAlongsideUpdates(t *testing.T) {
	v := newTestVault(t)
	old := bulkMinFiles
	bulkMinFiles = 30 // exercise the key index drop/recreate too
	t.Cleanup(func() { bulkMinFiles = old })
	const n = 120
	for i := range n {
		v.write(fmt.Sprintf("n%03d.md", i), fmt.Sprintf("# N%d\n\n[[n%03d]] #v0\n", i, (i+1)%n))
	}
	var wg sync.WaitGroup
	wg.Add(2)
	go func() {
		defer wg.Done()
		for i := range 4 {
			var err error
			if i == 2 {
				err = v.ix.Rebuild(v.ctx)
			} else {
				err = v.ix.Full(v.ctx)
			}
			if err != nil {
				t.Error(err)
			}
		}
	}()
	go func() {
		defer wg.Done()
		rng := rand.New(rand.NewPCG(5, 6)) //nolint:gosec // reproducible test data
		for round := range 150 {
			p := fmt.Sprintf("n%03d.md", rng.IntN(n+20)) // some beyond n: creations
			if rng.IntN(8) == 0 {
				_ = v.fs.Delete(p)
			} else {
				v.write(p, fmt.Sprintf("# %s\n\n[[n%03d]] #v%d\n", p, rng.IntN(n), round))
			}
			if err := v.ix.Update(v.ctx, []string{p}); err != nil {
				t.Error(err)
			}
		}
	}()
	wg.Wait()
	v.assertMatchesDisk()
}
