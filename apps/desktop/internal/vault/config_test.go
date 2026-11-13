package vault

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"sync"
	"testing"

	"clarae/shared/hashing"
	"clarae/shared/pathrules"
)

var (
	cfgLegacy  = pathrules.LegacyConfigDirs[0]
	cfgCurrent = pathrules.ConfigDir
)

func put(t *testing.T, fs *FS, rel, content string) {
	t.Helper()
	p := filepath.Join(fs.Root(), filepath.FromSlash(rel))
	if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(p, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
}

func has(fs *FS, rel string) bool {
	_, err := os.Lstat(filepath.Join(fs.Root(), filepath.FromSlash(rel)))
	return err == nil
}

func content(t *testing.T, fs *FS, rel string) string {
	t.Helper()
	b, err := os.ReadFile(filepath.Join(fs.Root(), filepath.FromSlash(rel)))
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}

func TestReadConfigResolver(t *testing.T) {
	fs := newTestFS(t)
	if _, err := fs.ReadConfig("editor.json"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("missing: %v", err)
	}
	put(t, fs, cfgLegacy+"/editor.json", "legacy")
	c, err := fs.ReadConfig("editor.json")
	if err != nil || string(c.Data) != "legacy" || c.Path != cfgLegacy+"/editor.json" {
		t.Fatalf("only the former folder: %+v %v", c, err)
	}
	put(t, fs, cfgCurrent+"/editor.json", "current")
	if c, err = fs.ReadConfig("editor.json"); err != nil || string(c.Data) != "current" {
		t.Fatalf("both: %+v %v", c, err)
	}
	// A nested name.
	put(t, fs, cfgLegacy+"/templates/daily.md", "# daily")
	if c, err = fs.ReadConfig("templates/daily.md"); err != nil || string(c.Data) != "# daily" {
		t.Fatalf("nested: %+v %v", c, err)
	}
	// What never syncs is read from the current folder only.
	put(t, fs, cfgLegacy+"/workspace.json", "stale layout")
	if _, err := fs.ReadConfig("workspace.json"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("a local file was read from the former folder: %v", err)
	}
	// Names that are not inside the folder.
	for _, bad := range []string{"", "..", "../x.json", "/etc/passwd", "a/../../b.json", "a\\b"} {
		if _, err := fs.ReadConfig(bad); err == nil || errors.Is(err, ErrNotFound) {
			t.Errorf("ReadConfig(%q) = %v, want an invalid path", bad, err)
		}
		if _, err := fs.WriteConfig(bad, []byte("x"), "", false); err == nil {
			t.Errorf("WriteConfig(%q) succeeded", bad)
		}
	}
}

func TestWriteConfigWritesWhereTheFileIs(t *testing.T) {
	fs := newTestFS(t)
	put(t, fs, cfgLegacy+"/editor.json", "v1")
	c, err := fs.WriteConfig("editor.json", []byte("v2"), "", false)
	if err != nil || c.Path != cfgLegacy+"/editor.json" {
		t.Fatalf("%+v %v", c, err)
	}
	if got := content(t, fs, cfgLegacy+"/editor.json"); got != "v2" || has(fs, cfgCurrent+"/editor.json") {
		t.Fatalf("former = %q, a copy in the current folder: %v", got, has(fs, cfgCurrent+"/editor.json"))
	}
	// expectedHash is checked against the file wherever it is.
	if _, err := fs.WriteConfig("editor.json", []byte("v3"), hashing.Sum([]byte("other")).Hex(), false); !errors.Is(err, ErrHashMismatch) {
		t.Fatalf("stale hash: %v", err)
	}
	if _, err := fs.WriteConfig("editor.json", []byte("v3"), hashing.Sum([]byte("v2")).Hex(), false); err != nil {
		t.Fatal(err)
	}
	if _, err := fs.WriteConfig("editor.json", []byte("v4"), "", true); !errors.Is(err, ErrExists) {
		t.Fatalf("create over an existing file: %v", err)
	}
	// The current folder wins when both have it.
	put(t, fs, cfgCurrent+"/editor.json", "current")
	if _, err := fs.WriteConfig("editor.json", []byte("current 2"), "", false); err != nil {
		t.Fatal(err)
	}
	if content(t, fs, cfgCurrent+"/editor.json") != "current 2" || content(t, fs, cfgLegacy+"/editor.json") != "v3" {
		t.Fatal("the write went to the wrong folder")
	}
}

func TestWriteConfigNewFilePolicy(t *testing.T) {
	fs := newTestFS(t)
	legacyNew := false
	fs.SetConfigPolicy(func() bool { return legacyNew })

	if c, err := fs.WriteConfig("a.json", []byte("{}"), "", false); err != nil || c.Path != cfgCurrent+"/a.json" {
		t.Fatalf("default: %+v %v", c, err)
	}
	legacyNew = true
	if c, err := fs.WriteConfig("b.json", []byte("{}"), "", false); err != nil || c.Path != cfgLegacy+"/b.json" {
		t.Fatalf("linked, move off: %+v %v", c, err)
	}
	if p, err := fs.ConfigPath("c.json"); err != nil || p != cfgLegacy+"/c.json" {
		t.Fatalf("ConfigPath of a new file = %q %v", p, err)
	}
	if p, err := fs.ConfigPath("b.json"); err != nil || p != cfgLegacy+"/b.json" {
		t.Fatalf("ConfigPath of a file in the former folder = %q %v", p, err)
	}
	// Local data is canonical whatever the policy says.
	if c, err := fs.WriteConfig("workspace.json", []byte("{}"), "", false); err != nil || c.Path != cfgCurrent+"/workspace.json" {
		t.Fatalf("local file: %+v %v", c, err)
	}
	// A file that already exists is not moved by a new policy.
	legacyNew = false
	if c, err := fs.WriteConfig("b.json", []byte("{1}"), "", false); err != nil || c.Path != cfgLegacy+"/b.json" {
		t.Fatalf("existing file after the policy changed: %+v %v", c, err)
	}
	fs.SetConfigPolicy(nil)
}

func TestWriteConfigNotifiesTheChange(t *testing.T) {
	fs := newTestFS(t)
	var got []string
	fs.SetOnChange(func(p []string) { got = append(got, p...) })
	if _, err := fs.WriteConfig("editor.json", []byte("{}"), "", false); err != nil {
		t.Fatal(err)
	}
	if len(got) != 1 || got[0] != cfgCurrent+"/editor.json" {
		t.Fatalf("changed = %v", got)
	}
}

func TestMoveConfig(t *testing.T) {
	fs := newTestFS(t)
	put(t, fs, cfgLegacy+"/editor.json", "{a}")
	put(t, fs, cfgLegacy+"/templates/sub/daily.md", "# daily")

	to, moved, err := fs.MoveConfig(cfgLegacy+"/editor.json", hashing.Sum([]byte("{a}")).Hex())
	if err != nil || !moved || to != cfgCurrent+"/editor.json" {
		t.Fatalf("MoveConfig = %q %v %v", to, moved, err)
	}
	if has(fs, cfgLegacy+"/editor.json") || content(t, fs, cfgCurrent+"/editor.json") != "{a}" {
		t.Fatal("the file did not move")
	}
	// The nested file moves, and the folders it leaves empty go, but not the one with another file.
	put(t, fs, cfgLegacy+"/hotkeys.json", "{}")
	if _, moved, err := fs.MoveConfig(cfgLegacy+"/templates/sub/daily.md", ""); err != nil || !moved {
		t.Fatalf("nested: %v %v", moved, err)
	}
	if has(fs, cfgLegacy+"/templates") {
		t.Fatal("an emptied folder is still there")
	}
	if !has(fs, cfgLegacy) || content(t, fs, cfgCurrent+"/templates/sub/daily.md") != "# daily" {
		t.Fatal("the former folder holding another file must stay")
	}
	if _, moved, err := fs.MoveConfig(cfgLegacy+"/hotkeys.json", ""); err != nil || !moved {
		t.Fatalf("last: %v %v", moved, err)
	}
	if has(fs, cfgLegacy) {
		t.Fatal("the empty former folder is still there")
	}
}

func TestMoveConfigNeverOverwritesOrLosesAChange(t *testing.T) {
	fs := newTestFS(t)
	put(t, fs, cfgLegacy+"/editor.json", "legacy")
	put(t, fs, cfgCurrent+"/editor.json", "current")
	if to, moved, err := fs.MoveConfig(cfgLegacy+"/editor.json", ""); err != nil || moved || to != "" {
		t.Fatalf("destination exists: %q %v %v", to, moved, err)
	}
	if content(t, fs, cfgLegacy+"/editor.json") != "legacy" || content(t, fs, cfgCurrent+"/editor.json") != "current" {
		t.Fatal("a file was touched")
	}

	// A file changed since the engine last saw it stays where it is.
	put(t, fs, cfgLegacy+"/hotkeys.json", "edited")
	if _, moved, err := fs.MoveConfig(cfgLegacy+"/hotkeys.json", hashing.Sum([]byte("known")).Hex()); !errors.Is(err, ErrHashMismatch) || moved {
		t.Fatalf("changed file: %v %v", moved, err)
	}
	if !has(fs, cfgLegacy+"/hotkeys.json") || has(fs, cfgCurrent+"/hotkeys.json") {
		t.Fatal("a changed file was moved")
	}

	// Not ours to move: a missing file, a local-only name, the current folder, a folder.
	put(t, fs, cfgLegacy+"/workspace.json", "layout")
	put(t, fs, cfgLegacy+"/dir/x.json", "x")
	for _, p := range []string{cfgLegacy + "/missing.json", cfgLegacy + "/workspace.json", cfgCurrent + "/editor.json", cfgLegacy + "/dir", "Notes/a.md"} {
		if to, moved, err := fs.MoveConfig(p, ""); err != nil || moved {
			t.Errorf("MoveConfig(%q) = %q %v %v, want a no-op", p, to, moved, err)
		}
	}
	if !has(fs, cfgLegacy+"/workspace.json") || !has(fs, cfgLegacy+"/dir/x.json") {
		t.Fatal("something that is not a settings file moved")
	}
}

func TestMoveConfigLeavesASymlinkAlone(t *testing.T) {
	if runtime.GOOS == "windows" || runtime.GOOS == "js" {
		t.Skip("symlinks")
	}
	fs := newTestFS(t)
	outside := filepath.Join(t.TempDir(), "secret.json")
	if err := os.WriteFile(outside, []byte("secret"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Join(fs.Root(), cfgLegacy), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(outside, filepath.Join(fs.Root(), cfgLegacy, "editor.json")); err != nil {
		t.Fatal(err)
	}
	// Either a refusal (it points outside the vault) or a no-op, never a move.
	if _, moved, err := fs.MoveConfig(cfgLegacy+"/editor.json", ""); moved {
		t.Fatalf("a symlink was moved (err %v)", err)
	}
	if has(fs, cfgCurrent+"/editor.json") {
		t.Fatal("the link target reached the current folder")
	}
}

// Writers that never stop while the file is moved from the former folder to the current one: the
// file ends in one place only, with the last content written, and no write is lost or lands in the
// folder the file left.
func TestWriteConfigDuringAMove(t *testing.T) {
	for i := 0; i < 20; i++ {
		fs := newTestFS(t)
		put(t, fs, cfgLegacy+"/editor.json", "start")
		const writers, writes = 4, 25
		var wg sync.WaitGroup
		start := make(chan struct{})
		for w := 0; w < writers; w++ {
			wg.Add(1)
			go func() {
				defer wg.Done()
				<-start
				for k := 0; k < writes; k++ {
					if _, err := fs.WriteConfig("editor.json", []byte(fmt.Sprintf("w%d-%d", w, k)), "", false); err != nil {
						t.Errorf("write: %v", err)
						return
					}
				}
			}()
		}
		wg.Add(1)
		go func() {
			defer wg.Done()
			<-start
			if _, _, err := fs.MoveConfig(cfgLegacy+"/editor.json", ""); err != nil {
				t.Errorf("move: %v", err)
			}
		}()
		close(start)
		wg.Wait()
		if has(fs, cfgLegacy+"/editor.json") {
			t.Fatalf("iteration %d: a write recreated the file in the former folder", i)
		}
		c, err := fs.ReadConfig("editor.json")
		if err != nil || c.Path != cfgCurrent+"/editor.json" {
			t.Fatalf("iteration %d: %+v %v", i, c, err)
		}
	}
}

// A read that overlaps a move finds the file in one of the two places, never neither.
func TestReadConfigDuringAMove(t *testing.T) {
	fs := newTestFS(t)
	put(t, fs, cfgLegacy+"/editor.json", "x")
	var wg sync.WaitGroup
	wg.Add(2)
	go func() {
		defer wg.Done()
		for k := 0; k < 200; k++ {
			if _, err := fs.ReadConfig("editor.json"); err != nil {
				t.Errorf("read %d: %v", k, err)
				return
			}
		}
	}()
	go func() {
		defer wg.Done()
		if _, _, err := fs.MoveConfig(cfgLegacy+"/editor.json", ""); err != nil {
			t.Errorf("move: %v", err)
		}
	}()
	wg.Wait()
}

func TestShelveConfig(t *testing.T) {
	fs := newTestFS(t)
	put(t, fs, cfgCurrent+"/editor.json", "mine")
	put(t, fs, cfgCurrent+"/templates/sub/daily.md", "# daily")
	put(t, fs, cfgCurrent+"/hotkeys.json", "{current}")
	put(t, fs, cfgLegacy+"/hotkeys.json", "{legacy}") // the former folder wins
	put(t, fs, cfgCurrent+"/workspace.json", "layout")
	put(t, fs, cfgCurrent+"/sync.db", "db")
	put(t, fs, cfgCurrent+"/cache/drawings/a.svg", "<svg>")

	n, err := fs.ShelveConfig()
	if err != nil || n != 2 {
		t.Fatalf("ShelveConfig = %d, %v; want 2", n, err)
	}
	if content(t, fs, cfgLegacy+"/editor.json") != "mine" || content(t, fs, cfgLegacy+"/templates/sub/daily.md") != "# daily" {
		t.Fatal("the settings did not move")
	}
	if has(fs, cfgCurrent+"/editor.json") || has(fs, cfgCurrent+"/templates") {
		t.Fatal("a moved file or its emptied folder is still in the current folder")
	}
	if content(t, fs, cfgLegacy+"/hotkeys.json") != "{legacy}" || content(t, fs, cfgCurrent+"/hotkeys.json") != "{current}" {
		t.Fatal("a file of the former folder was overwritten, or its twin lost")
	}
	for _, rel := range []string{"workspace.json", "sync.db", "cache/drawings/a.svg"} {
		if !has(fs, cfgCurrent+"/"+rel) || has(fs, cfgLegacy+"/"+rel) {
			t.Errorf("%s, which never syncs, moved", rel)
		}
	}
	// Nothing to do on a vault with no configuration folder.
	empty := newTestFS(t)
	if n, err := empty.ShelveConfig(); n != 0 || err != nil {
		t.Fatalf("empty vault: %d %v", n, err)
	}
}
