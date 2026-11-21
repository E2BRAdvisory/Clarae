package vault

import (
	"errors"
	"io"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"testing/iotest"

	"clarae/shared/pathrules"
)

func newTestFS(t *testing.T) *FS {
	t.Helper()
	root := t.TempDir()
	f, err := NewFS(root)
	if err != nil {
		t.Fatal(err)
	}
	return f
}

func TestWriteReadAtomic(t *testing.T) {
	f := newTestFS(t)
	c, err := f.WriteFile("Notes/today.md", []byte("# Hi\n"), "", true)
	if err != nil {
		t.Fatal(err)
	}
	if c.Path != "Notes/today.md" || c.Size != 5 || c.Hash == "" {
		t.Fatalf("unexpected content %+v", c)
	}
	if _, err := f.WriteFile("Notes/today.md", []byte("x"), "", true); !errors.Is(err, ErrExists) {
		t.Fatalf("create on existing: %v", err)
	}
	got, err := f.ReadFile("Notes/today.md")
	if err != nil || string(got.Data) != "# Hi\n" {
		t.Fatalf("read: %v %q", err, got.Data)
	}

	// Optimistic concurrency: a stale hash must be rejected.
	if _, err := f.WriteFile("Notes/today.md", []byte("v2"), "stale", false); !errors.Is(err, ErrHashMismatch) {
		t.Fatalf("stale hash: %v", err)
	}
	if _, err := f.WriteFile("Notes/today.md", []byte("v2"), got.Hash, false); err != nil {
		t.Fatalf("fresh hash: %v", err)
	}
	// Expected-existing file that was deleted meanwhile.
	if err := f.Delete("Notes/today.md"); err != nil {
		t.Fatal(err)
	}
	if _, err := f.WriteFile("Notes/today.md", []byte("v3"), got.Hash, false); !errors.Is(err, ErrHashMismatch) {
		t.Fatalf("deleted meanwhile: %v", err)
	}

	// No temporary files left behind.
	entries, _ := os.ReadDir(filepath.Join(f.Root(), "Notes"))
	for _, e := range entries {
		if e.Name() != "today.md" {
			t.Fatalf("leftover %s", e.Name())
		}
	}
}

func TestPathGuards(t *testing.T) {
	f := newTestFS(t)
	for _, bad := range []string{"../x.md", "/etc/passwd", "a/../../x", "", "a\\b.md", "CON.md"} {
		if _, _, err := f.Resolve(bad); err == nil {
			t.Errorf("Resolve(%q) must fail", bad)
		}
	}
	if runtime.GOOS == "windows" {
		return
	}
	// A symlink inside the vault pointing outside must be rejected.
	outside := t.TempDir()
	if err := os.Symlink(outside, filepath.Join(f.Root(), "escape")); err != nil {
		t.Fatal(err)
	}
	if _, _, err := f.Resolve("escape/secret.md"); !errors.Is(err, ErrOutsideVault) {
		t.Fatalf("symlink escape: %v", err)
	}
	// The symlink itself is invisible to Walk.
	entries, err := f.ListTree()
	if err != nil {
		t.Fatal(err)
	}
	for _, e := range entries {
		if e.Name == "escape" {
			t.Fatal("symlink listed")
		}
	}
}

// A name that only starts with ".." is an ordinary vault folder or file (Obsidian users name
// folders "..Archive" to sort them first); only the ".." segment leaves the vault.
func TestDotDotPrefixedNamesAreInside(t *testing.T) {
	f := newTestFS(t)
	for _, p := range []string{"..Archivio/nota.md", "..md", "Dir/..x/y.md"} {
		if _, err := f.WriteFile(p, []byte(p), "", true); err != nil {
			t.Fatalf("WriteFile(%q): %v", p, err)
		}
		c, err := f.ReadFile(p)
		if err != nil || string(c.Data) != p {
			t.Fatalf("ReadFile(%q) = %q, %v", p, c.Data, err)
		}
	}
	if runtime.GOOS == "windows" {
		return
	}
	// Symlinks to the parent folder, or to a sibling whose name starts with the vault's, still escape.
	parent := filepath.Dir(f.Root())
	sibling := f.Root() + "..x"
	if err := os.Mkdir(sibling, 0o755); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(sibling) })
	for name, target := range map[string]string{"up": parent, "..up": parent, "..sib": sibling} {
		if err := os.Symlink(target, filepath.Join(f.Root(), name)); err != nil {
			t.Fatal(err)
		}
		if _, _, err := f.Resolve(name + "/secret.md"); !errors.Is(err, ErrOutsideVault) {
			t.Fatalf("symlink %s -> %s: %v", name, target, err)
		}
	}
}

func TestRenameTrashWalk(t *testing.T) {
	f := newTestFS(t)
	for _, p := range []string{"a.md", "Dir/b.md", "Dir/Sub/c.png", ".clarae/editor.json", ".clarae/cache/x.svg", ".DS_Store"} {
		if _, err := f.WriteFile(p, []byte(p), "", true); err != nil {
			t.Fatal(err)
		}
	}
	if err := f.Rename("Dir/b.md", "Dir/Sub/b2.md"); err != nil {
		t.Fatal(err)
	}
	if err := f.Rename("a.md", "Dir/Sub/b2.md"); !errors.Is(err, ErrExists) {
		t.Fatalf("rename onto existing: %v", err)
	}
	dest, err := f.Trash("Dir/Sub/b2.md")
	if err != nil || dest != pathrules.TrashDir+"/Dir/Sub/b2.md" {
		t.Fatalf("trash: %q %v", dest, err)
	}
	// Trashing a same-named file again gets a timestamp suffix.
	if _, err := f.WriteFile("Dir/Sub/b2.md", []byte("again"), "", true); err != nil {
		t.Fatal(err)
	}
	dest2, err := f.Trash("Dir/Sub/b2.md")
	if err != nil || dest2 == dest {
		t.Fatalf("second trash: %q %v", dest2, err)
	}

	tree, err := f.ListTree()
	if err != nil {
		t.Fatal(err)
	}
	var paths []string
	for _, e := range tree {
		paths = append(paths, e.Path)
	}
	want := map[string]bool{"a.md": true, "Dir": true, "Dir/Sub": true, "Dir/Sub/c.png": true, ".clarae": true, ".clarae/editor.json": true, ".trash": true}
	for _, p := range paths {
		if p == ".DS_Store" || p == ".clarae/cache" || p == ".clarae/cache/x.svg" {
			t.Fatalf("excluded entry listed: %s", p)
		}
	}
	for p := range want {
		found := false
		for _, q := range paths {
			if p == q {
				found = true
			}
		}
		if !found {
			t.Fatalf("missing %s in %v", p, paths)
		}
	}
	hash, n, err := f.HashFile("Dir/Sub/c.png")
	if err != nil || n != int64(len("Dir/Sub/c.png")) || len(hash) != 64 {
		t.Fatalf("hash: %s %d %v", hash, n, err)
	}
}

// A case-only rename works on a case-insensitive file system and never
// replaces another file on a case-sensitive one.
func TestRenameCaseOnly(t *testing.T) {
	f := newTestFS(t)
	root := f.Root()
	if _, err := f.WriteFile("idea.md", []byte("lower"), "", true); err != nil {
		t.Fatal(err)
	}
	_, statErr := os.Stat(filepath.Join(root, "IDEA.md"))
	caseInsensitive := statErr == nil
	if caseInsensitive {
		if err := f.Rename("idea.md", "Idea.md"); err != nil {
			t.Fatalf("case-only rename: %v", err)
		}
		entries, _ := os.ReadDir(root)
		found := false
		for _, e := range entries {
			found = found || e.Name() == "Idea.md"
		}
		if !found {
			t.Fatalf("not renamed: %v", entries)
		}
		return
	}
	if _, err := f.WriteFile("Idea.md", []byte("upper"), "", true); err != nil {
		t.Fatal(err)
	}
	if err := f.Rename("idea.md", "Idea.md"); !errors.Is(err, ErrExists) {
		t.Fatalf("expected ErrExists, got %v", err)
	}
	for name, want := range map[string]string{"idea.md": "lower", "Idea.md": "upper"} {
		if c, err := f.ReadFile(name); err != nil || string(c.Data) != want {
			t.Fatalf("%s = %q, %v", name, c.Data, err)
		}
	}
}

// Trashing the same path twice within a second keeps both copies.
func TestTrashSameNameTwice(t *testing.T) {
	f := newTestFS(t)
	var dests []string
	for _, body := range []string{"one", "two", "three"} {
		if _, err := f.WriteFile("n.md", []byte(body), "", true); err != nil {
			t.Fatal(err)
		}
		d, err := f.Trash("n.md")
		if err != nil {
			t.Fatal(err)
		}
		dests = append(dests, d)
	}
	seen := map[string]bool{}
	for i, d := range dests {
		if seen[d] {
			t.Fatalf("trash destination reused: %v", dests)
		}
		seen[d] = true
		if c, err := f.ReadFile(d); err != nil || string(c.Data) != []string{"one", "two", "three"}[i] {
			t.Fatalf("%s = %q, %v", d, c.Data, err)
		}
	}
}

func TestWriteFileFromStreams(t *testing.T) {
	f := newTestFS(t)
	var changed []string
	f.SetOnChange(func(p []string) { changed = append(changed, p...) })
	data := strings.Repeat("attachment bytes ", 50000)
	hash, n, err := f.WriteFileFrom("Files/a.bin", strings.NewReader(data))
	if err != nil {
		t.Fatal(err)
	}
	got, err := f.ReadFile("Files/a.bin")
	if err != nil || string(got.Data) != data || got.Hash != hash || n != int64(len(data)) {
		t.Fatalf("read back: %v hash=%s/%s n=%d", err, hash, got.Hash, n)
	}
	if len(changed) != 1 || changed[0] != "Files/a.bin" {
		t.Fatalf("change callback: %v", changed)
	}
	// It never replaces a file.
	if _, _, err := f.WriteFileFrom("Files/a.bin", strings.NewReader("x")); !errors.Is(err, ErrExists) {
		t.Fatalf("existing file: %v", err)
	}
	// A failing reader leaves neither the file nor a staging file behind.
	boom := errors.New("boom")
	if _, _, err := f.WriteFileFrom("Files/b.bin", io.MultiReader(strings.NewReader("part"), iotest.ErrReader(boom))); !errors.Is(err, boom) {
		t.Fatalf("failing reader: %v", err)
	}
	entries, _ := os.ReadDir(filepath.Join(f.Root(), "Files"))
	if len(entries) != 1 || entries[0].Name() != "a.bin" {
		t.Fatalf("leftovers: %v", entries)
	}
	if _, _, err := f.WriteFileFrom("../out.bin", strings.NewReader("x")); err == nil {
		t.Fatal("a path outside the vault must be refused")
	}
}

func TestListFilesSeesWhatWalkExcludes(t *testing.T) {
	root := t.TempDir()
	f, err := NewFS(root)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := f.ListFiles(".clarae/cache/drawings"); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("missing folder: %v", err)
	}
	dir := filepath.Join(root, ".clarae", "cache", "drawings")
	if err := os.MkdirAll(filepath.Join(dir, "sub"), 0o755); err != nil {
		t.Fatal(err)
	}
	for _, n := range []string{"b.svg", "a.svg"} {
		if err := os.WriteFile(filepath.Join(dir, n), []byte("<svg/>"), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	got, err := f.ListFiles(".clarae/cache/drawings")
	if err != nil || len(got) != 2 || got[0].Path != ".clarae/cache/drawings/a.svg" || got[1].Name != "b.svg" || got[0].Size != 6 {
		t.Fatalf("list: %+v %v", got, err)
	}
	// Walk never shows the cache; ListFiles is how it is maintained. Still no way out of the vault.
	if err := f.Walk(func(e Entry) error {
		if strings.Contains(e.Path, "cache") {
			t.Errorf("Walk reached %s", e.Path)
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	if _, err := f.ListFiles("../"); err == nil {
		t.Error("a folder outside the vault must be refused")
	}
}

// WalkReport tells what Walk leaves out (ADR-0066): an unrepresentable name, a symlink and an excluded
// folder, each once and without its contents; Walk and WalkReport visit the same entries.
func TestWalkReportTellsWhatItSkips(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("':' and symlinks cannot be created by an ordinary Windows user")
	}
	f := newTestFS(t)
	root := f.Root()
	for _, p := range []string{"Notes/a.md", "Notes/Meeting 10:30.md", ".git/HEAD", ".git/objects/ab/cd", "Repo/.hg/store", "Notes/.DS_Store", "Bad:dir/inner.md"} {
		abs := filepath.Join(root, filepath.FromSlash(p))
		if err := os.MkdirAll(filepath.Dir(abs), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(abs, []byte("x"), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.Symlink(filepath.Join(root, "Notes", "a.md"), filepath.Join(root, "Notes", "link.md")); err != nil {
		t.Fatal(err)
	}
	var seen, plain []string
	skipped := map[string]Skipped{}
	err := f.WalkReport(func(e Entry) error {
		seen = append(seen, e.Path)
		return nil
	}, func(s Skipped) {
		if _, dup := skipped[s.Path]; dup {
			t.Errorf("%s reported twice", s.Path)
		}
		skipped[s.Path] = s
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := f.Walk(func(e Entry) error {
		plain = append(plain, e.Path)
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	if strings.Join(seen, ",") != "Notes,Notes/a.md,Repo" || strings.Join(plain, ",") != strings.Join(seen, ",") {
		t.Fatalf("visited %v, Walk %v", seen, plain)
	}
	want := map[string]Skipped{
		".git":                   {Path: ".git", IsDir: true, Kind: SkipExcluded, Exclusion: pathrules.ReasonVCS},
		"Repo/.hg":               {Path: "Repo/.hg", IsDir: true, Kind: SkipExcluded, Exclusion: pathrules.ReasonVCS},
		"Notes/.DS_Store":        {Path: "Notes/.DS_Store", Kind: SkipExcluded, Exclusion: pathrules.ReasonOSJunk},
		"Notes/link.md":          {Path: "Notes/link.md", Kind: SkipSymlink},
		"Notes/Meeting 10:30.md": {Path: "Notes/Meeting 10:30.md", Kind: SkipInvalidName},
		"Bad:dir":                {Path: "Bad:dir", IsDir: true, Kind: SkipInvalidName},
	}
	if len(skipped) != len(want) {
		t.Fatalf("skipped %+v", skipped)
	}
	for p, w := range want {
		got, ok := skipped[p]
		if w.Kind == SkipInvalidName && ok {
			if !strings.Contains(got.Detail, "forbidden character") {
				t.Errorf("%s: detail %q", p, got.Detail)
			}
			got.Detail = ""
		}
		if !ok || got != w {
			t.Errorf("%s: got %+v want %+v", p, got, w)
		}
	}
}
