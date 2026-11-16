package vaultdir

import (
	"os"
	"path/filepath"
	"runtime"
	"testing"
)

// trashTo is a Trash function that moves the file under .trash/, like vault.FS.Trash.
func trashTo(root string) func(rel string) error {
	return func(rel string) error {
		dst := filepath.Join(root, ".trash", filepath.FromSlash(rel))
		if err := os.MkdirAll(filepath.Dir(dst), 0o755); err != nil {
			return err
		}
		return os.Rename(filepath.Join(root, filepath.FromSlash(rel)), dst)
	}
}

func cleanup(t *testing.T, root string, o CleanupOptions) CleanupResult {
	t.Helper()
	if o.Version == "" {
		o.Version = "1.7.2"
	}
	res, err := CleanupLegacy(root, o)
	if err != nil {
		t.Fatalf("CleanupLegacy: %v", err)
	}
	return res
}

// A vault that has both folders: the current one wins and the former one keeps what collided.
// After the cleanup the local-only duplicates are gone, the snapshots are merged, the settings of
// an unlinked vault are deleted when identical and trashed when different, and the former folder
// goes with them.
func TestCleanupLegacyUnlinkedVault(t *testing.T) {
	root := t.TempDir()
	seed(t, root, current, map[string]string{
		"index.db": "new index", "sync.db": "new sync", "workspace.json": "{new}",
		"cache/a.svg":            "new svg",
		"snapshots/2026/same.md": "same", "snapshots/2026/differs.md": "new version",
		"editor.json": `{"font":18}`, "hotkeys.json": "{}",
	})
	seed(t, root, legacy, map[string]string{
		"index.db": "old index", "index.db-wal": "old wal", "sync.db": "old sync", "sync.db-shm": "old shm", "workspace.json": "{old}",
		"cache/a.svg":            "old svg",
		"snapshots/2026/same.md": "same", "snapshots/2026/differs.md": "old version", "snapshots/2026/only-old.md": "only old",
		"editor.json": `{"font":14}`, "hotkeys.json": "{}", ".DS_Store": "junk",
	})
	res := cleanup(t, root, CleanupOptions{Trash: trashTo(root)})
	if res.Trashed != 1 || res.Moved != 1 || res.Kept != 1 {
		t.Fatalf("result: %+v", res)
	}
	// The current folder keeps its own files, and gains the snapshot it did not have.
	cur := files(tree(t, root, current))
	for k, want := range map[string]string{
		"index.db": "new index", "sync.db": "new sync", "workspace.json": "{new}", "cache/a.svg": "new svg",
		"snapshots/2026/same.md": "same", "snapshots/2026/differs.md": "new version", "snapshots/2026/only-old.md": "only old",
		"editor.json": `{"font":18}`, "hotkeys.json": "{}",
		"cache/" + cleanupMarker: "1.7.2\n",
	} {
		if cur[k] != want {
			t.Errorf("%s = %q, want %q", k, cur[k], want)
		}
	}
	// The former folder holds only the snapshot whose version differs; the different setting went to the trash.
	left := files(tree(t, root, legacy))
	if len(left) != 1 || left["snapshots/2026/differs.md"] != "old version" {
		t.Fatalf("former folder: %v", left)
	}
	if got := files(tree(t, root, ".trash")); len(got) != 1 || got[legacy+"/editor.json"] != `{"font":14}` {
		t.Fatalf("trash: %v", got)
	}
}

// With nothing kept the former folder itself is removed.
func TestCleanupLegacyRemovesTheEmptiedFolder(t *testing.T) {
	root := t.TempDir()
	seed(t, root, current, map[string]string{"index.db": "n", "sync.db": "n", "editor.json": "{}", "templates/a.md": "# a"})
	seed(t, root, legacy, map[string]string{"index.db": "o", "sync.db": "o", "editor.json": "{}", "templates/a.md": "# a"})
	res := cleanup(t, root, CleanupOptions{Trash: trashTo(root)})
	if res.Deleted != 4 || res.Kept != 0 {
		t.Fatalf("result: %+v", res)
	}
	if _, err := os.Lstat(filepath.Join(root, legacy)); !os.IsNotExist(err) {
		t.Fatalf("the former folder is still there: %v", err)
	}
	if _, err := os.Lstat(filepath.Join(root, ".trash")); !os.IsNotExist(err) {
		t.Fatal("identical copies must not go to the trash")
	}
}

// A linked vault keeps its settings, whatever they hold: the sync engine takes them over.
func TestCleanupLegacyLinkedVaultKeepsSettings(t *testing.T) {
	root := t.TempDir()
	seed(t, root, current, map[string]string{"sync.db": "n", "workspace.json": "{n}", "editor.json": `{"font":18}`})
	seed(t, root, legacy, map[string]string{"sync.db": "o", "workspace.json": "{o}", "editor.json": `{"font":14}`, "hotkeys.json": "{}"})
	res := cleanup(t, root, CleanupOptions{Linked: true, Trash: trashTo(root)})
	if res.Deleted != 2 || res.Kept != 2 || res.Trashed != 0 {
		t.Fatalf("result: %+v", res)
	}
	left := files(tree(t, root, legacy))
	if len(left) != 2 || left["editor.json"] != `{"font":14}` || left["hotkeys.json"] != "{}" {
		t.Fatalf("former folder: %v", left)
	}
}

// The former sync.db is never touched while it may be the one in use, and without a Trash function
// a setting that differs stays.
func TestCleanupLegacyLeavesWhatItCannotJudge(t *testing.T) {
	root := t.TempDir()
	seed(t, root, current, map[string]string{"editor.json": "new"})
	seed(t, root, legacy, map[string]string{"sync.db": "the one in use", "editor.json": "old"})
	res := cleanup(t, root, CleanupOptions{})
	// sync.db: the current folder has none, so the former one is not a duplicate.
	if res.Deleted != 0 || res.Kept != 2 {
		t.Fatalf("result: %+v", res)
	}
	if got := files(tree(t, root, legacy)); got["sync.db"] != "the one in use" || got["editor.json"] != "old" {
		t.Fatalf("former folder: %v", got)
	}
}

// A symlink in the former folder, and what it points to, are never touched.
func TestCleanupLegacyIgnoresSymlinks(t *testing.T) {
	if runtime.GOOS == "windows" || runtime.GOOS == "js" {
		t.Skip("symlinks")
	}
	root := t.TempDir()
	outside := t.TempDir()
	seed(t, outside, ".", map[string]string{"keep.txt": "mine"})
	seed(t, root, current, map[string]string{"sync.db": "n"})
	seed(t, root, legacy, map[string]string{"sync.db": "o"})
	if err := os.Symlink(outside, filepath.Join(root, legacy, "link")); err != nil {
		t.Fatal(err)
	}
	res := cleanup(t, root, CleanupOptions{})
	if res.Kept != 1 || res.Deleted != 1 {
		t.Fatalf("result: %+v", res)
	}
	if b, err := os.ReadFile(filepath.Join(outside, "keep.txt")); err != nil || string(b) != "mine" {
		t.Fatalf("the target of a symlink was touched: %q %v", b, err)
	}
	if _, err := os.Lstat(filepath.Join(root, legacy, "link")); err != nil {
		t.Fatal("the symlink was removed")
	}
}

// Once per version: a second call does nothing, even if a file reappeared, and a new version runs
// again. A vault without a former folder gets no marker.
func TestCleanupLegacyRunsOncePerVersion(t *testing.T) {
	root := t.TempDir()
	seed(t, root, current, map[string]string{"sync.db": "n", "editor.json": "{}"})
	seed(t, root, legacy, map[string]string{"editor.json": "{}"})
	if res := cleanup(t, root, CleanupOptions{Version: "1.7.2"}); res.Deleted != 1 {
		t.Fatalf("first run: %+v", res)
	}
	seed(t, root, legacy, map[string]string{"editor.json": "{}"})
	if res := cleanup(t, root, CleanupOptions{Version: "1.7.2"}); res != (CleanupResult{}) {
		t.Fatalf("second run: %+v", res)
	}
	if _, err := os.Lstat(filepath.Join(root, legacy, "editor.json")); err != nil {
		t.Fatal("the marker did not stop the second run")
	}
	if res := cleanup(t, root, CleanupOptions{Version: "1.8.1"}); res.Deleted != 1 {
		t.Fatalf("new version: %+v", res)
	}

	empty := t.TempDir()
	if res := cleanup(t, empty, CleanupOptions{}); res != (CleanupResult{}) {
		t.Fatalf("no former folder: %+v", res)
	}
	if tr := tree(t, empty, current); tr != nil {
		t.Fatalf("a vault with nothing to clean got files: %v", tr)
	}
}

// Ensure, AdoptSettings and CleanupLegacy together on the state a 1.x vault with both folders leaves.
func TestCleanupLegacyAfterEnsureAndAdopt(t *testing.T) {
	root := t.TempDir()
	seed(t, root, legacy, localFiles())
	seed(t, root, legacy, settings())
	cur := localFiles()
	cur["sync.db"] = "current sync"
	seed(t, root, current, cur)
	mustEnsure(t, root)
	if err := AdoptSettings(root); err != nil {
		t.Fatal(err)
	}
	cleanup(t, root, CleanupOptions{Trash: trashTo(root)})
	if _, err := os.Lstat(filepath.Join(root, legacy)); !os.IsNotExist(err) {
		t.Fatalf("the former folder is still there: %v (%v)", err, files(tree(t, root, legacy)))
	}
	got := files(tree(t, root, current))
	if got["sync.db"] != "current sync" || got["editor.json"] != `{"font":14}` {
		t.Fatalf("current folder: %v", got)
	}
}
