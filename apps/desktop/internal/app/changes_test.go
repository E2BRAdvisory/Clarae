package app

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

func TestClassifyChangesUsesTheIndexAsThePreviousState(t *testing.T) {
	a, info, root := newTestApp(t)
	for _, name := range []string{"Known.md", "Gone.md"} {
		if err := os.WriteFile(filepath.Join(root, name), []byte("# "+name), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	ov, _ := a.vault(info.ID)
	if err := ov.Indexer.Update(context.Background(), []string{"Known.md", "Gone.md"}); err != nil {
		t.Fatal(err)
	}
	waitIndexed(t, a, info.ID, 2)

	if err := os.WriteFile(filepath.Join(root, "Known.md"), []byte("# Known, edited"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "New.md"), []byte("# New"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Remove(filepath.Join(root, "Gone.md")); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(filepath.Join(root, "Folder"), 0o700); err != nil {
		t.Fatal(err)
	}

	got := classifyChanges(context.Background(), ov, []string{"Known.md", "New.md", "Gone.md", "Folder"})
	want := map[string]ChangeType{"Known.md": ChangeModify, "New.md": ChangeCreate, "Gone.md": ChangeDelete, "Folder": ChangeCreate}
	if len(got) != len(want) {
		t.Fatalf("changes = %+v", got)
	}
	for _, c := range got {
		if want[c.Path] != c.Type {
			t.Errorf("%s: type %q, want %q", c.Path, c.Type, want[c.Path])
		}
		switch {
		case c.Type == ChangeDelete && c.Entry != nil:
			t.Errorf("%s: a deletion carries no entry", c.Path)
		case c.Type != ChangeDelete && (c.Entry == nil || c.Entry.Path != c.Path):
			t.Errorf("%s: entry %+v", c.Path, c.Entry)
		}
	}
	for _, c := range got {
		if c.Path == "Known.md" && (c.Entry.Size != int64(len("# Known, edited")) || c.Entry.Kind != "md" || c.Entry.IsDir) {
			t.Errorf("Known.md entry = %+v", c.Entry)
		}
		if c.Path == "Folder" && !c.Entry.IsDir {
			t.Errorf("Folder entry = %+v", c.Entry)
		}
	}

	// The payload stays readable by frontends that only know `paths`.
	raw, err := json.Marshal(FileChangedPayload{VaultID: info.ID, Paths: []string{"Gone.md"}, Changes: got[2:3]})
	if err != nil {
		t.Fatal(err)
	}
	if s := string(raw); !strings.Contains(s, `"paths":["Gone.md"]`) || !strings.Contains(s, `"changes":[{"type":"delete","path":"Gone.md"}]`) {
		t.Fatalf("payload = %s", s)
	}
}

// Changes only a reconciliation finds (events lost, the periodic pass) reach the frontend and the
// history like a watcher batch: typed changes, and the folder of removed files when it is gone.
func TestReconcileEmitsFileChangesAndFeedsTheHistory(t *testing.T) {
	a, info, root := newTestApp(t)
	ov, _ := a.vault(info.ID)
	ov.cancel() // no watcher, no history worker: only the reconciliation reports what changed
	ctx := context.Background()
	for p, c := range map[string]string{"Keep.md": "k", "Edit.md": "e", "Dir/Sub/Gone.md": "g"} {
		abs := filepath.Join(root, filepath.FromSlash(p))
		if err := os.MkdirAll(filepath.Dir(abs), 0o700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(abs, []byte(c), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	if err := ov.Indexer.Full(ctx); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "Edit.md"), []byte("edited elsewhere"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "New.md"), []byte("new"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.RemoveAll(filepath.Join(root, "Dir")); err != nil {
		t.Fatal(err)
	}

	var mu sync.Mutex
	var events []FileChangedPayload
	a.setEmitter(func(name string, p any) {
		if name == EventVaultFileChanged.Name() {
			mu.Lock()
			events = append(events, p.(FileChangedPayload))
			mu.Unlock()
		}
	})
	collected := func() []FileChangedPayload {
		mu.Lock()
		defer mu.Unlock()
		out := events
		events = nil
		return out
	}
	a.reconcile(ctx, ov)
	got := collected()
	if len(got) != 1 {
		t.Fatalf("events = %+v", got)
	}
	want := map[string]ChangeType{"Edit.md": ChangeModify, "New.md": ChangeCreate, "Dir/Sub/Gone.md": ChangeDelete, "Dir": ChangeDelete}
	if p := got[0]; p.VaultID != info.ID || len(p.Changes) != len(want) || len(p.Paths) != len(want) {
		t.Fatalf("payload = %+v", p)
	}
	for _, c := range got[0].Changes {
		if want[c.Path] != c.Type {
			t.Errorf("%s: %q, want %q", c.Path, c.Type, want[c.Path])
		}
		if (c.Type == ChangeDelete) != (c.Entry == nil) {
			t.Errorf("%s: entry %+v", c.Path, c.Entry)
		}
	}

	ov.History.Flush()
	for _, p := range []string{"Edit.md", "New.md"} {
		if s, err := ov.History.List(p); err != nil || len(s) != 1 {
			t.Errorf("%s: snapshots %+v %v", p, s, err)
		}
	}

	// Nothing changed: no event.
	a.reconcile(ctx, ov)
	if got := collected(); len(got) != 0 {
		t.Fatalf("unchanged vault: %+v", got)
	}
}

// The frontend reloads the shape library of the open editors when vault:file-changed names it:
// the event comes both for the write the app makes itself (WriteConfig) and, on the desktop, for one
// made by someone else (another program: the sync engine writes through vault.FS, which the browser
// build reports itself).
func TestShapeLibraryWritesEmitFileChanged(t *testing.T) {
	a, info, root := newTestApp(t)
	var mu sync.Mutex
	var paths []string
	a.setEmitter(func(name string, p any) {
		if name == EventVaultFileChanged.Name() {
			mu.Lock()
			paths = append(paths, p.(FileChangedPayload).Paths...)
			mu.Unlock()
		}
	})
	saw := func() bool {
		deadline := time.Now().Add(5 * time.Second)
		for time.Now().Before(deadline) {
			mu.Lock()
			for _, p := range paths {
				if p == ".clarae/excalidraw-library.json" {
					paths = nil
					mu.Unlock()
					return true
				}
			}
			mu.Unlock()
			time.Sleep(20 * time.Millisecond)
		}
		return false
	}
	if err := NewVaultAPI(a).WriteConfig(info.ID, "excalidraw-library.json", `{"libraryItems":[]}`); err != nil {
		t.Fatal(err)
	}
	if !saw() {
		t.Error("WriteConfig of the library did not emit vault:file-changed")
	}
	if isWeb {
		return // the browser has no file watcher: only the writes of the core itself are reported
	}
	if err := os.WriteFile(filepath.Join(root, ".clarae", "excalidraw-library.json"), []byte(`{"libraryItems":[{"id":"x"}]}`), 0o600); err != nil {
		t.Fatal(err)
	}
	if !saw() {
		t.Error("an external write of the library did not emit vault:file-changed")
	}
}
