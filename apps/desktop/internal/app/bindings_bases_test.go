package app

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestBasesAPI(t *testing.T) {
	a, info, _ := newTestApp(t)
	v, b := NewVaultAPI(a), NewBasesAPI(a)
	if _, err := v.WriteNote(info.ID, "Tasks/One.md", "---\nstatus: open\nprice: 5\n---\nbody\n", ""); err != nil {
		t.Fatal(err)
	}
	if _, err := v.WriteNote(info.ID, "Tasks/Two.md", "---\nstatus: done\nprice: 7\n---\nbody\n", ""); err != nil {
		t.Fatal(err)
	}
	waitIndexed(t, a, info.ID, 2)
	src := "# mine\nextra: keep\n" + b.NewBaseContent("Tasks") +
		"    sort:\n      - property: price\n        direction: DESC\n"
	if _, err := v.WriteNote(info.ID, "Tasks/Board.base", src, ""); err != nil {
		t.Fatal(err)
	}
	if _, err := b.Load(info.ID, "Tasks/One.md"); err == nil {
		t.Error("a note is not a base")
	}
	bi, err := b.Load(info.ID, "Tasks/Board.base")
	if err != nil || bi.ParseError != "" || len(bi.Views) != 1 || len(bi.Views[0].BaseFilters) != 2 {
		t.Fatalf("load: %+v %v", bi, err)
	}

	var res struct{ paths []string }
	run := func() {
		r, err := b.Run(info.ID, "Tasks/Board.base", 0, "")
		if err != nil {
			t.Fatal(err)
		}
		res.paths = nil
		for _, row := range r.Rows {
			res.paths = append(res.paths, row.Path)
		}
	}
	// The index is asynchronous: wait until both rows have properties.
	for i := 0; i < 100; i++ {
		run()
		if len(res.paths) == 2 && res.paths[0] == "Tasks/Two.md" {
			break
		}
		time.Sleep(20 * time.Millisecond)
	}
	if strings.Join(res.paths, ",") != "Tasks/Two.md,Tasks/One.md" {
		t.Fatalf("rows: %v", res.paths)
	}
	r, _ := b.Run(info.ID, "Tasks/Board.base", 0, "")
	hash := r.Rows[1].Hash // One.md
	if _, err := b.UpdateProperty(info.ID, "Tasks/One.md", "status", `"review"`, hash); err != nil {
		t.Fatal(err)
	}
	if _, err := b.UpdateProperty(info.ID, "Tasks/One.md", "status", `"x"`, hash); err == nil || !strings.Contains(err.Error(), "conflict") {
		t.Fatalf("stale hash must conflict: %v", err)
	}
	if _, err := b.UpdateProperty(info.ID, "Tasks/One.md", "file.name", `"x"`, ""); err == nil {
		t.Error("file properties are not editable")
	}
	if _, err := b.UpdateProperty(info.ID, "Tasks/Board.base", "k", `"x"`, ""); err == nil {
		t.Error("only notes have properties")
	}

	patch := `{"order":["file.name","status"],"addFilter":"status != \"done\""}`
	if _, err := b.UpdateView(info.ID, "Tasks/Board.base", 0, patch, "stale"); err == nil || !strings.Contains(err.Error(), "conflict") {
		t.Fatalf("stale base hash must conflict: %v", err)
	}
	if _, err := b.UpdateView(info.ID, "Tasks/Board.base", 0, patch, bi.Hash); err != nil {
		t.Fatal(err)
	}
	after, _ := v.ReadNote(info.ID, "Tasks/Board.base")
	if !strings.Contains(after.Content, "# mine") || !strings.Contains(after.Content, "extra: keep") || !strings.Contains(after.Content, "status") {
		t.Fatalf("base after update:\n%s", after.Content)
	}
}

func TestBasesAPIRefusesHugeBase(t *testing.T) {
	a, info, root := newTestApp(t)
	b := NewBasesAPI(a)
	// Written behind the app's back, as a sync or another program would.
	huge := "# " + strings.Repeat("x", maxBaseSize) + "\nviews:\n  - type: table\n    name: T\n"
	if err := os.WriteFile(filepath.Join(root, "Huge.base"), []byte(huge), 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := b.Load(info.ID, "Huge.base"); err == nil || !strings.Contains(err.Error(), "too large") {
		t.Errorf("load: %v", err)
	}
	if _, err := b.Run(info.ID, "Huge.base", 0, ""); err == nil || !strings.Contains(err.Error(), "too large") {
		t.Errorf("run: %v", err)
	}
}
