package indexer

import (
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/rs/zerolog"
)

// countResolveAll counts the whole-vault link resolutions of the Full passes.
func countResolveAll(t *testing.T) *int {
	t.Helper()
	n := new(int)
	testHookResolveAll = func() { *n++ }
	t.Cleanup(func() { testHookResolveAll = nil })
	return n
}

func (v *testVault) resolvedTo(raw string) string {
	v.t.Helper()
	var r string
	if err := v.ix.db.QueryRowContext(v.ctx, `SELECT COALESCE(target_resolved, '') FROM links WHERE target_raw = ?`, raw).Scan(&r); err != nil {
		v.t.Fatal(err)
	}
	return r
}

// A Full that finds nothing to write or remove does not resolve the whole vault again; one that
// adds, changes or removes a file does, and so does the first Full of a new Indexer.
func TestFullResolvesLinksOnlyWhenSomethingChanged(t *testing.T) {
	v := newTestVault(t)
	resolves := countResolveAll(t)
	v.write("a.md", "[[b]] [[c]]\n")
	v.write("c.md", "c\n")
	full := func(want int) {
		t.Helper()
		if err := v.ix.Full(v.ctx); err != nil {
			t.Fatal(err)
		}
		if *resolves != want {
			t.Fatalf("ResolveAll ran %d times, want %d", *resolves, want)
		}
	}
	full(1)
	full(1) // nothing changed
	// Same content, new mtime: only a touch.
	future := time.Now().Add(time.Hour)
	if err := os.Chtimes(filepath.Join(v.root, "c.md"), future, future); err != nil {
		t.Fatal(err)
	}
	full(1)
	// A file added behind the indexer's back: [[b]] now resolves.
	if err := os.WriteFile(filepath.Join(v.root, "b.md"), []byte("b\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	full(2)
	if got := v.resolvedTo("b"); got != "b.md" {
		t.Fatalf("[[b]] -> %q", got)
	}
	// Removed: [[c]] is a ghost link again.
	if err := os.Remove(filepath.Join(v.root, "c.md")); err != nil {
		t.Fatal(err)
	}
	full(3)
	if got := v.resolvedTo("c"); got != "" {
		t.Fatalf("[[c]] -> %q after c.md was removed", got)
	}
	full(3)
	// Updates keep the links resolved themselves: no resolution needed afterwards.
	v.write("c.md", "c again\n")
	if err := v.ix.Update(v.ctx, []string{"c.md"}); err != nil {
		t.Fatal(err)
	}
	full(3)
	if got := v.resolvedTo("c"); got != "c.md" {
		t.Fatalf("[[c]] -> %q after the Update", got)
	}
	// A new Indexer (a vault opened again, maybe after a crash between the batches and the
	// resolution) resolves once.
	if _, err := v.ix.db.ExecContext(v.ctx, `UPDATE links SET target_resolved = NULL`); err != nil {
		t.Fatal(err)
	}
	v.ix = New(v.fs, v.ix.db, zerolog.Nop(), nil)
	full(4)
	if v.resolvedTo("b") != "b.md" || v.resolvedTo("c") != "c.md" {
		t.Fatal("the first Full of a new Indexer did not resolve the links")
	}
	full(4)
	// Rebuild always resolves.
	if err := v.ix.Rebuild(v.ctx); err != nil {
		t.Fatal(err)
	}
	if *resolves != 5 {
		t.Fatalf("Rebuild: ResolveAll ran %d times", *resolves)
	}
}

// Reconcile lists the changes it found: added, modified and removed files, not the ones whose
// content is unchanged.
func TestReconcileReportsChanges(t *testing.T) {
	v := newTestVault(t)
	v.write("keep.md", "k\n")
	v.write("touched.md", "t\n")
	v.write("edit.md", "e\n")
	v.write("gone.md", "g\n")
	v.write("img/logo.png", "PNG")
	first, err := v.ix.Reconcile(v.ctx)
	if err != nil {
		t.Fatal(err)
	}
	slices.Sort(first.Added)
	if want := []string{"edit.md", "gone.md", "img/logo.png", "keep.md", "touched.md"}; !slices.Equal(first.Added, want) {
		t.Fatalf("first pass added %v", first.Added)
	}
	if again, err := v.ix.Reconcile(v.ctx); err != nil || !again.Empty() {
		t.Fatalf("unchanged vault: %+v %v", again, err)
	}
	future := time.Now().Add(time.Hour)
	for _, p := range []string{"touched.md", "img/logo.png"} {
		if err := os.Chtimes(filepath.Join(v.root, filepath.FromSlash(p)), future, future); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.WriteFile(filepath.Join(v.root, "edit.md"), []byte("edited\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(v.root, "new.md"), []byte("n\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.Remove(filepath.Join(v.root, "gone.md")); err != nil {
		t.Fatal(err)
	}
	got, err := v.ix.Reconcile(v.ctx)
	if err != nil {
		t.Fatal(err)
	}
	if !slices.Equal(got.Added, []string{"new.md"}) || !slices.Equal(got.Modified, []string{"edit.md"}) || !slices.Equal(got.Removed, []string{"gone.md"}) {
		t.Fatalf("reconciled %+v", got)
	}
	v.assertMatchesDisk()
}

// A note larger than maxParseBytes is indexed by name only: no parse, no body in the full-text
// index. Once it shrinks it is parsed again.
func TestOversizeNoteIndexedByNameOnly(t *testing.T) {
	old := maxParseBytes
	maxParseBytes = 1 << 10
	t.Cleanup(func() { maxParseBytes = old })
	v := newTestVault(t)
	big := "# Huge\n\n[[target]] #tag uniquebodyword\n" + strings.Repeat("filler line\n", 200)
	v.write("Huge dump.md", big)
	v.write("Huge drawing.excalidraw", `{"type":"excalidraw","elements":[{"type":"text","text":"uniquedrawingword `+strings.Repeat("x", 2000)+`"}]}`)
	if err := v.ix.Full(v.ctx); err != nil {
		t.Fatal(err)
	}
	if v.count(`SELECT count(*) FROM files WHERE path IN ('Huge dump.md', 'Huge drawing.excalidraw')`) != 2 {
		t.Fatal("oversize files not listed")
	}
	if v.count(`SELECT count(*) FROM links`)+v.count(`SELECT count(*) FROM tags`)+v.count(`SELECT count(*) FROM headings`) != 0 {
		t.Fatal("oversize note parsed")
	}
	for _, q := range []string{"uniquebodyword", "uniquedrawingword"} {
		if hits, err := v.ix.Search(v.ctx, q, 10); err != nil || len(hits) != 0 {
			t.Fatalf("body of an oversize file searchable: %v %v", hits, err)
		}
	}
	if hits, err := v.ix.Search(v.ctx, "Huge dump", 10); err != nil || len(hits) != 1 {
		t.Fatalf("oversize note not found by name: %v %v", hits, err)
	}
	v.write("Huge dump.md", "# Small\n\n[[target]] #tag uniquebodyword\n")
	if err := v.ix.Update(v.ctx, []string{"Huge dump.md"}); err != nil {
		t.Fatal(err)
	}
	if v.count(`SELECT count(*) FROM links WHERE path = 'Huge dump.md'`) != 1 || v.count(`SELECT count(*) FROM tags WHERE path = 'Huge dump.md'`) != 1 {
		t.Fatal("the note was not parsed once small again")
	}
	if hits, err := v.ix.Search(v.ctx, "uniquebodyword", 10); err != nil || len(hits) != 1 {
		t.Fatalf("body not searchable once small again: %v %v", hits, err)
	}
}
