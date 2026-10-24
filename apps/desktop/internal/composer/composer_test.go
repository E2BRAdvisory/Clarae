package composer

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"nodus/apps/desktop/internal/indexer"
	"nodus/apps/desktop/internal/store"
	"nodus/apps/desktop/internal/vault"

	"github.com/rs/zerolog"
)

type fixture struct {
	root string
	fsys *vault.FS
	ix   *indexer.Indexer
	env  Env
}

func newFixture(t *testing.T, files map[string]string) *fixture {
	t.Helper()
	root := t.TempDir()
	for p, c := range files {
		abs := filepath.Join(root, filepath.FromSlash(p))
		if err := os.MkdirAll(filepath.Dir(abs), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(abs, []byte(c), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	fsys, err := vault.NewFS(root)
	if err != nil {
		t.Fatal(err)
	}
	db, err := store.Open(context.Background(), filepath.Join(t.TempDir(), "index.db"), store.KindIndex)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = db.Close() })
	ix := indexer.New(fsys, db, zerolog.Nop(), nil)
	if err := ix.Full(context.Background()); err != nil {
		t.Fatal(err)
	}
	f := &fixture{root: root, fsys: fsys, ix: ix}
	f.env = Env{
		FS: fsys, DB: db,
		Trash:   func(p string) error { _, err := fsys.Trash(p); return err },
		Reindex: func(paths []string) { _ = ix.Update(context.Background(), paths) },
	}
	return f
}

func (f *fixture) read(t *testing.T, p string) string {
	t.Helper()
	c, err := f.fsys.ReadFile(p)
	if err != nil {
		t.Fatalf("read %s: %v", p, err)
	}
	return string(c.Data)
}

func TestMergeRedirectsLinksAndTrashesSource(t *testing.T) {
	f := newFixture(t, map[string]string{
		"A.md":     "---\ntags: [a]\n---\nTarget text\n",
		"B.md":     "---\ntags: [b]\n---\nSource body with [[A]]\n",
		"C.md":     "See [[B]] and [[B|alias]] and [[B#Head]] and ![[B]].\n",
		"D.md":     "unrelated [[A]]\n",
		"sub/E.md": "[md](../B.md)\n",
	})
	plan, err := PlanMerge(context.Background(), f.env, "B.md", "A.md")
	if err != nil {
		t.Fatal(err)
	}
	if plan.Notes != 2 || plan.Links != 5 {
		t.Fatalf("plan = %+v, want 5 links in 2 notes", plan)
	}
	res, err := ApplyMerge(context.Background(), f.env, "B.md", "A.md", MergeOptions{})
	if err != nil || !res.Trashed {
		t.Fatalf("merge = %+v, %v", res, err)
	}
	a := f.read(t, "A.md")
	if !strings.HasPrefix(a, "---\ntags: [a]\n---\nTarget text\n\n## B\n\nSource body with [[A]]\n") {
		t.Errorf("target = %q", a)
	}
	if strings.Contains(a, "tags: [b]") {
		t.Errorf("source frontmatter must not be merged: %q", a)
	}
	if c := f.read(t, "C.md"); c != "See [[A]] and [[A|alias]] and [[A#Head]] and ![[A]].\n" {
		t.Errorf("C = %q", c)
	}
	if e := f.read(t, "sub/E.md"); !strings.Contains(e, "(../A.md)") {
		t.Errorf("E = %q", e)
	}
	if _, err := f.fsys.ReadFile("B.md"); err == nil {
		t.Error("source should be gone")
	}
	if _, err := f.fsys.ReadFile(".trash/B.md"); err != nil {
		t.Errorf("source should be in the trash: %v", err)
	}
}

func TestMergeRollsBackWhenLinksCannotBeRewritten(t *testing.T) {
	f := newFixture(t, map[string]string{"A.md": "target\n", "B.md": "source\n", "ro/C.md": "[[B]]\n"})
	// A note in a read-only folder cannot be rewritten: the redirect step fails after
	// the target was already written, and the target must be restored.
	if os.Geteuid() == 0 {
		t.Skip("permissions are not enforced for root")
	}
	ro := filepath.Join(f.root, "ro")
	if err := os.Chmod(ro, 0o555); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.Chmod(ro, 0o755) })
	if _, err := ApplyMerge(context.Background(), f.env, "B.md", "A.md", MergeOptions{}); err == nil {
		t.Fatal("expected an error")
	}
	if got := f.read(t, "A.md"); got != "target\n" {
		t.Errorf("target must be restored, got %q", got)
	}
	if got := f.read(t, "B.md"); got != "source\n" {
		t.Errorf("source must be untouched, got %q", got)
	}
}

func TestMergeValidation(t *testing.T) {
	f := newFixture(t, map[string]string{"A.md": "a\n", "img.png": "x"})
	ctx := context.Background()
	if _, err := PlanMerge(ctx, f.env, "A.md", "A.md"); err == nil {
		t.Error("merging into itself must fail")
	}
	if _, err := PlanMerge(ctx, f.env, "img.png", "A.md"); err == nil {
		t.Error("non-notes must be refused")
	}
	if _, err := PlanMerge(ctx, f.env, "Missing.md", "A.md"); err == nil {
		t.Error("a missing source must fail")
	}
}

func TestAppendedSeparators(t *testing.T) {
	got := string(Appended([]byte("t\n\n"), []byte("---\nx: 1\n---\nbody\n"), "S", MergeOptions{Separator: SepRule}))
	if got != "t\n\n---\n\nbody\n" {
		t.Errorf("rule = %q", got)
	}
	got = string(Appended([]byte(""), []byte("body"), "S", MergeOptions{Separator: SepNone}))
	if got != "body\n" {
		t.Errorf("none/empty target = %q", got)
	}
}

func TestSuggestTitle(t *testing.T) {
	cases := map[string]string{
		"## My **great** idea\nmore":      "My great idea",
		"\n\n- [ ] buy [[Milk|the milk]]": "buy the milk",
		"> quote: with/slash":             "quote with slash",
		"":                                "Untitled",
		"#":                               "Untitled",
		"1. [link](http://x.y) text":      "link text",
		strings.Repeat("word ", 30):       strings.TrimSpace(strings.Repeat("word ", 12)),
	}
	for in, want := range cases {
		if got := SuggestTitle(in); got != want {
			t.Errorf("SuggestTitle(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestExtract(t *testing.T) {
	f := newFixture(t, map[string]string{
		"Notes/Src.md": "---\nstatus: draft\n---\nintro\n",
		"Idea.md":      "existing\n",
	})
	res, err := Extract(f.fsys, ExtractOptions{SourcePath: "Notes/Src.md", Selection: "# Plan\nsteps\n", CarryFrontmatter: true})
	if err != nil {
		t.Fatal(err)
	}
	if res.Path != "Notes/Plan.md" || res.Link != "[[Plan]]" {
		t.Errorf("res = %+v", res)
	}
	if got := f.read(t, res.Path); got != "---\nstatus: draft\n---\n# Plan\nsteps\n" {
		t.Errorf("new note = %q", got)
	}
	// Name clash with a note elsewhere: a path link; clash in the same folder: a suffix.
	res, err = Extract(f.fsys, ExtractOptions{SourcePath: "Notes/Src.md", Selection: "x", Title: "Idea", Embed: true})
	if err != nil || res.Path != "Notes/Idea.md" || res.Link != "![[Notes/Idea]]" {
		t.Errorf("clash res = %+v, %v", res, err)
	}
	res, err = Extract(f.fsys, ExtractOptions{SourcePath: "Notes/Src.md", Selection: "y", Title: "Plan"})
	if err != nil || res.Path != "Notes/Plan 2.md" {
		t.Errorf("suffix res = %+v, %v", res, err)
	}
	if _, err := Extract(f.fsys, ExtractOptions{SourcePath: "Idea.md", Selection: "  \n"}); err == nil {
		t.Error("empty selection must fail")
	}
}
