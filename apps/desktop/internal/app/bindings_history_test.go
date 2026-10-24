package app

import (
	"strings"
	"testing"
	"time"
)

// A note written through the bindings is snapshotted by the watcher-driven snapshotter, can be
// restored after an edit (keeping the replaced text), and the snapshot store never shows up in
// the index.
func TestHistoryEndToEnd(t *testing.T) {
	a, info, _ := newTestApp(t)
	v, h := NewVaultAPI(a), NewHistoryAPI(a)
	if _, err := v.WriteNote(info.ID, "Note.md", "first version", ""); err != nil {
		t.Fatal(err)
	}
	var snaps int
	for i := 0; i < 200 && snaps == 0; i++ { // watcher debounce (1.5 s) + worker
		time.Sleep(50 * time.Millisecond)
		l, err := h.List(info.ID, "Note.md")
		if err != nil {
			t.Fatal(err)
		}
		snaps = len(l)
	}
	if snaps != 1 {
		t.Fatalf("snapshots = %d, want 1", snaps)
	}
	l, _ := h.List(info.ID, "Note.md")
	cur, _ := v.ReadNote(info.ID, "Note.md")
	if _, err := v.WriteNote(info.ID, "Note.md", "second version", cur.Hash); err != nil {
		t.Fatal(err)
	}
	if _, err := h.Restore(info.ID, l[0].ID); err != nil {
		t.Fatal(err)
	}
	got, _ := v.ReadNote(info.ID, "Note.md")
	if got.Content != "first version" {
		t.Fatalf("content = %q", got.Content)
	}
	after, _ := h.List(info.ID, "Note.md")
	if len(after) != 2 || after[0].Reason != "pre-restore" {
		t.Fatalf("snapshots after restore = %+v", after)
	}
	if c, err := h.Read(info.ID, after[0].ID); err != nil || c.Content != "second version" {
		t.Fatalf("pre-restore content = %+v %v", c, err)
	}

	ov, _ := a.vault(info.ID)
	rows, err := ov.Indexer.DB().Query(`SELECT path FROM files`)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = rows.Close() }()
	for rows.Next() {
		var p string
		_ = rows.Scan(&p)
		if strings.Contains(p, "snapshots") {
			t.Fatalf("snapshot indexed: %s", p)
		}
	}
}
