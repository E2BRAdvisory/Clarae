package vault

import (
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"testing"

	"nodus/shared/pathrules"
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

func TestRenameTrashWalk(t *testing.T) {
	f := newTestFS(t)
	for _, p := range []string{"a.md", "Dir/b.md", "Dir/Sub/c.png", ".nodus/editor.json", ".nodus/cache/x.svg", ".DS_Store"} {
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
	want := map[string]bool{"a.md": true, "Dir": true, "Dir/Sub": true, "Dir/Sub/c.png": true, ".nodus": true, ".nodus/editor.json": true, ".trash": true}
	for _, p := range paths {
		if p == ".DS_Store" || p == ".nodus/cache" || p == ".nodus/cache/x.svg" {
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
