package app

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
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
	want := map[string]string{"Known.md": ChangeModify, "New.md": ChangeCreate, "Gone.md": ChangeDelete, "Folder": ChangeCreate}
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
