package vaultdir

import (
	"errors"
	"fmt"
	"io/fs"
	"maps"
	"os"
	"path/filepath"
	"runtime"
	"slices"
	"strings"
	"sync"
	"testing"

	"clarae/shared/pathrules"
)

var (
	legacy  = pathrules.LegacyConfigDirs[0]
	current = pathrules.ConfigDir
)

// localFiles is what a vault of 1.x keeps in its configuration folder that never syncs.
func localFiles() map[string]string {
	return map[string]string{
		"index.db":                "index main",
		"index.db-wal":            "index wal",
		"sync.db":                 "sync main",
		"sync.db-wal":             "sync wal",
		"sync.db-shm":             "sync shm",
		"workspace.json":          "{layout}",
		"workspaces.json":         "{layouts}",
		"cache/drawings/a.svg":    "<svg a>",
		"cache/outbox/b.bin":      "outbox b",
		"snapshots/2026/note.md":  "snapshot",
		"snapshots/2026/other.md": "snapshot 2",
	}
}

// settings is what syncs.
func settings() map[string]string {
	return map[string]string{
		"editor.json":             `{"font":14}`,
		"hotkeys.json":            `{}`,
		"templates/daily.md":      "# daily",
		"templates/sub/b.md":      "# b",
		"excalidraw-library.json": `[]`,
	}
}

func seed(t *testing.T, root, dir string, files map[string]string) {
	t.Helper()
	for rel, content := range files {
		p := filepath.Join(root, dir, filepath.FromSlash(rel))
		if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(p, []byte(content), 0o644); err != nil {
			t.Fatal(err)
		}
	}
}

// tree lists the files under root/dir (slash-separated, relative to dir) with their content;
// folders are listed with a trailing slash. A missing dir gives nil.
func tree(t *testing.T, root, dir string) map[string]string {
	t.Helper()
	base := filepath.Join(root, dir)
	if _, err := os.Lstat(base); errors.Is(err, fs.ErrNotExist) {
		return nil
	}
	out := map[string]string{}
	err := filepath.WalkDir(base, func(p string, d fs.DirEntry, err error) error {
		if err != nil || p == base {
			return err
		}
		rel, _ := filepath.Rel(base, p)
		rel = filepath.ToSlash(rel)
		if d.IsDir() {
			out[rel+"/"] = ""
			return nil
		}
		b, err := os.ReadFile(p)
		out[rel] = string(b)
		return err
	})
	if err != nil {
		t.Fatal(err)
	}
	return out
}

// files drops the folders from a tree.
func files(tr map[string]string) map[string]string {
	out := map[string]string{}
	for k, v := range tr {
		if !strings.HasSuffix(k, "/") {
			out[k] = v
		}
	}
	return out
}

func mustEnsure(t *testing.T, root string) {
	t.Helper()
	if err := Ensure(root); err != nil {
		t.Fatalf("Ensure: %v", err)
	}
}

func TestEnsureNothingToDo(t *testing.T) {
	root := t.TempDir()
	mustEnsure(t, root)
	if entries, _ := os.ReadDir(root); len(entries) != 0 {
		t.Fatalf("Ensure created %v in a folder with no configuration folder", entries)
	}
	// Only the current folder: left as it is, and no former folder appears.
	seed(t, root, current, localFiles())
	before := tree(t, root, current)
	mustEnsure(t, root)
	if got := tree(t, root, current); !maps.Equal(got, before) {
		t.Fatalf("the current folder changed: %v", got)
	}
	if _, err := os.Lstat(filepath.Join(root, legacy)); !errors.Is(err, fs.ErrNotExist) {
		t.Fatalf("a former folder appeared: %v", err)
	}
}

func TestEnsureMovesTheLocalPartOnly(t *testing.T) {
	root := t.TempDir()
	seed(t, root, legacy, localFiles())
	seed(t, root, legacy, settings())
	mustEnsure(t, root)

	if got := files(tree(t, root, current)); !maps.Equal(got, localFiles()) {
		t.Fatalf("the current folder holds %v, want the local part %v", got, localFiles())
	}
	// The settings stay where a 1.x client still reads them; nothing else is left there.
	if got := files(tree(t, root, legacy)); !maps.Equal(got, settings()) {
		t.Fatalf("the former folder holds %v, want the settings %v", got, settings())
	}
	// Idempotent.
	before := tree(t, root, current)
	mustEnsure(t, root)
	if got := tree(t, root, current); !maps.Equal(got, before) {
		t.Fatal("a second Ensure changed the current folder")
	}
}

func TestEnsureRemovesTheEmptiedFolder(t *testing.T) {
	root := t.TempDir()
	seed(t, root, legacy, localFiles())
	mustEnsure(t, root)
	if _, err := os.Lstat(filepath.Join(root, legacy)); !errors.Is(err, fs.ErrNotExist) {
		t.Fatalf("the emptied former folder is still there: %v", err)
	}
	if got := files(tree(t, root, current)); !maps.Equal(got, localFiles()) {
		t.Fatalf("lost files: %v", got)
	}
}

// Both folders hold an entry: the current one wins, the former one is kept, nothing is deleted.
func TestEnsureBothExist(t *testing.T) {
	root := t.TempDir()
	seed(t, root, legacy, localFiles())
	seed(t, root, legacy, settings())
	seed(t, root, current, map[string]string{
		"sync.db":                "NEW sync main",
		"workspace.json":         "NEW layout",
		"cache/drawings/a.svg":   "NEW svg",
		"cache/drawings/c.svg":   "<svg c>",
		"snapshots/2026/note.md": "NEW snapshot",
		"editor.json":            `{"font":99}`, // a setting: never touched by Ensure
	})
	mustEnsure(t, root)

	cur := files(tree(t, root, current))
	for rel, want := range map[string]string{
		"sync.db":                 "NEW sync main",
		"workspace.json":          "NEW layout",
		"cache/drawings/a.svg":    "NEW svg",
		"snapshots/2026/note.md":  "NEW snapshot",
		"editor.json":             `{"font":99}`,
		"index.db":                "index main", // moved: absent in the current folder
		"index.db-wal":            "index wal",
		"workspaces.json":         "{layouts}",
		"cache/outbox/b.bin":      "outbox b",
		"cache/drawings/c.svg":    "<svg c>",
		"snapshots/2026/other.md": "snapshot 2", // merged into the existing folder
	} {
		if cur[rel] != want {
			t.Errorf("current %s = %q, want %q", rel, cur[rel], want)
		}
	}
	// The journals of a database that the current folder already has are not mixed into it.
	for _, rel := range []string{"sync.db-wal", "sync.db-shm"} {
		if _, ok := cur[rel]; ok {
			t.Errorf("%s of the former sync.db was moved next to another sync.db", rel)
		}
	}
	old := files(tree(t, root, legacy))
	for rel, want := range map[string]string{
		"sync.db":                "sync main",
		"sync.db-wal":            "sync wal",
		"sync.db-shm":            "sync shm",
		"workspace.json":         "{layout}",
		"cache/drawings/a.svg":   "<svg a>",
		"snapshots/2026/note.md": "snapshot",
		"editor.json":            `{"font":14}`,
	} {
		if old[rel] != want {
			t.Errorf("former %s = %q, want %q (kept as it was)", rel, old[rel], want)
		}
	}
	for _, rel := range []string{"index.db", "workspaces.json", "cache/outbox/b.bin", "snapshots/2026/other.md"} {
		if _, ok := old[rel]; ok {
			t.Errorf("former %s should have moved", rel)
		}
	}
}

// crashed is the value the injected crash panics with.
type crashed struct{}

// A crash after the k-th rename, for every k: the next Ensure ends in the state an uninterrupted run
// reaches, and at no point a database sits in one folder with the journals in the other.
func TestEnsureCrashAtEveryRename(t *testing.T) {
	build := func(t *testing.T) string {
		root := t.TempDir()
		seed(t, root, legacy, localFiles())
		seed(t, root, legacy, settings())
		return root
	}
	// The reference: no crash, and how many renames it takes.
	ref := build(t)
	renames := 0
	afterRename = func(string) { renames++ }
	mustEnsure(t, ref)
	afterRename = nil
	wantCur, wantOld := tree(t, ref, current), tree(t, ref, legacy)
	if renames < 8 {
		t.Fatalf("only %d renames: the fixture does not exercise the move", renames)
	}

	defer func() { afterRename = nil }()
	for k := 1; k <= renames; k++ {
		t.Run(fmt.Sprintf("after-%d", k), func(t *testing.T) {
			root := build(t)
			n := 0
			afterRename = func(string) {
				if n++; n == k {
					panic(crashed{})
				}
			}
			func() {
				defer func() {
					if r := recover(); r != nil {
						if _, ok := r.(crashed); !ok {
							panic(r)
						}
					}
				}()
				_ = Ensure(root)
			}()
			afterRename = nil

			// Nothing is lost at the crash, and no database is split from its journals.
			assertNothingLost(t, root, localFiles(), settings())
			cur, old := files(tree(t, root, current)), files(tree(t, root, legacy))
			for _, db := range []string{"sync.db", "index.db"} {
				if _, inNew := cur[db]; inNew {
					for _, s := range sidecarSuffixes {
						if _, stranded := old[db+s]; stranded {
							t.Fatalf("%s is in the current folder, its %s still in the former one", db, s)
						}
					}
				}
			}

			// Recovery.
			mustEnsure(t, root)
			if got := tree(t, root, current); !maps.Equal(got, wantCur) {
				t.Fatalf("current after recovery = %v\nwant %v", got, wantCur)
			}
			if got := tree(t, root, legacy); !maps.Equal(got, wantOld) {
				t.Fatalf("former after recovery = %v\nwant %v", got, wantOld)
			}
		})
	}
}

// assertNothingLost checks that every seeded file is in one of the two folders, with its content.
func assertNothingLost(t *testing.T, root string, seeded ...map[string]string) {
	t.Helper()
	cur, old := files(tree(t, root, current)), files(tree(t, root, legacy))
	for _, m := range seeded {
		for rel, want := range m {
			if cur[rel] != want && old[rel] != want {
				t.Errorf("%s lost or changed (current %q, former %q)", rel, cur[rel], old[rel])
			}
		}
	}
}

// The database main file is not moved while a journal that belongs to it is still behind.
func TestEnsureMovesJournalsBeforeTheMainFile(t *testing.T) {
	root := t.TempDir()
	seed(t, root, legacy, map[string]string{"sync.db": "m", "sync.db-wal": "w", "sync.db-shm": "s"})
	var order []string
	afterRename = func(p string) { order = append(order, filepath.Base(p)) }
	defer func() { afterRename = nil }()
	mustEnsure(t, root)
	if want := []string{"sync.db-shm", "sync.db-wal", "sync.db"}; !slices.Equal(order, want) {
		t.Fatalf("order of the moves = %v, want %v", order, want)
	}
}

func TestEnsureConcurrent(t *testing.T) {
	root := t.TempDir()
	seed(t, root, legacy, localFiles())
	seed(t, root, legacy, settings())
	var wg sync.WaitGroup
	errs := make(chan error, 16)
	for range 16 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			errs <- Ensure(root)
		}()
	}
	wg.Wait()
	close(errs)
	for err := range errs {
		if err != nil {
			t.Fatal(err)
		}
	}
	if got := files(tree(t, root, current)); !maps.Equal(got, localFiles()) {
		t.Fatalf("current = %v", got)
	}
	if got := files(tree(t, root, legacy)); !maps.Equal(got, settings()) {
		t.Fatalf("former = %v", got)
	}
}

func TestEnsureRefusesANonFolderCurrent(t *testing.T) {
	root := t.TempDir()
	seed(t, root, legacy, localFiles())
	if err := os.WriteFile(filepath.Join(root, current), []byte("a file"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := Ensure(root); err == nil {
		t.Fatal("Ensure went on although the current folder is a file")
	}
	if got := files(tree(t, root, legacy)); !maps.Equal(got, localFiles()) {
		t.Fatalf("the former folder was touched: %v", got)
	}
}

func TestEnsureLeavesASymlinkedFormerFolderAlone(t *testing.T) {
	if runtime.GOOS == "windows" || runtime.GOOS == "js" {
		t.Skip("symlinks")
	}
	outside, root := t.TempDir(), t.TempDir()
	seed(t, outside, ".", localFiles())
	if err := os.Symlink(outside, filepath.Join(root, legacy)); err != nil {
		t.Fatal(err)
	}
	mustEnsure(t, root)
	if got := files(tree(t, outside, ".")); !maps.Equal(got, localFiles()) {
		t.Fatalf("the folder behind the link was moved: %v", got)
	}
	if _, err := os.Lstat(filepath.Join(root, current)); !errors.Is(err, fs.ErrNotExist) {
		t.Fatalf("a current folder was made: %v", err)
	}
}

func TestAdoptSettings(t *testing.T) {
	root := t.TempDir()
	seed(t, root, legacy, localFiles())
	seed(t, root, legacy, settings())
	seed(t, root, current, map[string]string{
		"editor.json":        `{"font":99}`,
		"templates/daily.md": "# NEW daily",
	})
	if err := AdoptSettings(root); err != nil {
		t.Fatal(err)
	}
	cur := files(tree(t, root, current))
	want := map[string]string{"editor.json": `{"font":99}`, "templates/daily.md": "# NEW daily"}
	maps.Copy(want, localFiles())
	for rel, c := range settings() {
		if _, ok := want[rel]; !ok {
			want[rel] = c
		}
	}
	if !maps.Equal(cur, want) {
		t.Fatalf("current = %v\nwant %v", cur, want)
	}
	// What exists in both stays in the former folder, which therefore stays.
	old := files(tree(t, root, legacy))
	if len(old) != 2 || old["editor.json"] != `{"font":14}` || old["templates/daily.md"] != "# daily" {
		t.Fatalf("former = %v", old)
	}

	// With nothing left in common the former folder goes.
	root2 := t.TempDir()
	seed(t, root2, legacy, localFiles())
	seed(t, root2, legacy, settings())
	if err := AdoptSettings(root2); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Lstat(filepath.Join(root2, legacy)); !errors.Is(err, fs.ErrNotExist) {
		t.Fatalf("the emptied former folder is still there: %v", err)
	}
	all := localFiles()
	maps.Copy(all, settings())
	if got := files(tree(t, root2, current)); !maps.Equal(got, all) {
		t.Fatalf("current = %v", got)
	}
}

func TestIsNotEmpty(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "x"), nil, 0o644); err != nil {
		t.Fatal(err)
	}
	err := os.Remove(dir)
	if err == nil {
		t.Fatal("removed a folder that is not empty")
	}
	if !isNotEmpty(err) {
		t.Fatalf("isNotEmpty(%v) = false", err)
	}
}
