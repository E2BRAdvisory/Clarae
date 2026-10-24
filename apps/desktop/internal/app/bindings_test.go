package app

import (
	"context"
	"encoding/base64"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/rs/zerolog"

	"nodus/apps/desktop/internal/store"
)

func newTestApp(t *testing.T) (*App, VaultInfo, string) {
	t.Helper()
	ctx := context.Background()
	dataDir := t.TempDir()
	a := New(Options{DataDir: dataDir, Logger: zerolog.Nop(), Version: "test"})
	a.ctx = ctx
	a.emitter = func(string, any) {}
	db, err := store.Open(ctx, filepath.Join(dataDir, "app.db"), store.KindApp)
	if err != nil {
		t.Fatal(err)
	}
	a.appDB = db
	root := filepath.Join(t.TempDir(), "vault")
	info, err := a.openVault(root)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		a.mu.Lock()
		for id, v := range a.vaults {
			a.closeVaultLocked(id, v)
		}
		a.mu.Unlock()
		_ = db.Close()
	})
	return a, info, root
}

func waitIndexed(t *testing.T, a *App, id string, want int) {
	t.Helper()
	ov, _ := a.vault(id)
	for i := 0; i < 100; i++ {
		var n int
		_ = ov.Indexer.DB().QueryRow(`SELECT count(*) FROM files WHERE kind='md'`).Scan(&n)
		if n >= want {
			return
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatalf("index did not reach %d notes", want)
}

func TestVaultConfigAllowList(t *testing.T) {
	a, info, root := newTestApp(t)
	v := NewVaultAPI(a)
	if got, err := v.ReadConfig(info.ID, "editor.json"); err != nil || got != "" {
		t.Fatalf("missing config: %q %v", got, err)
	}
	if err := v.WriteConfig(info.ID, "editor.json", `{"wrap":true}`); err != nil {
		t.Fatal(err)
	}
	if got, _ := v.ReadConfig(info.ID, "editor.json"); got != `{"wrap":true}` {
		t.Fatalf("roundtrip: %q", got)
	}
	for _, bad := range []string{"../evil.json", "index.db", "Notes.md", "types/../x.json"} {
		if err := v.WriteConfig(info.ID, bad, `{}`); err == nil {
			t.Errorf("%q must be refused", bad)
		}
		if _, err := v.ReadConfig(info.ID, bad); err == nil {
			t.Errorf("read %q must be refused", bad)
		}
	}
	if err := v.WriteConfig(info.ID, "editor.json", `not json`); err == nil {
		t.Error("invalid JSON must be refused")
	}
	if err := v.WriteConfig(info.ID, "types.json", `{"a":"bogus"}`); err == nil {
		t.Error("invalid schema must be refused")
	}
	if _, err := os.Stat(filepath.Join(root, ".nodus", "editor.json")); err != nil {
		t.Fatal(err)
	}
}

func TestAttachments(t *testing.T) {
	a, info, root := newTestApp(t)
	v := NewVaultAPI(a)
	data := base64.StdEncoding.EncodeToString([]byte("\x89PNG\r\n\x1a\nfake"))
	p1, err := v.SaveAttachment(info.ID, "attachments", "shot.png", data)
	if err != nil || p1 != "attachments/shot.png" {
		t.Fatalf("first: %q %v", p1, err)
	}
	p2, err := v.SaveAttachment(info.ID, "attachments", "shot.png", data)
	if err != nil || p2 != "attachments/shot 1.png" {
		t.Fatalf("collision: %q %v", p2, err)
	}
	if _, err := v.SaveAttachment(info.ID, "../out", "x.png", data); err == nil {
		t.Error("path traversal must be refused")
	}
	if _, err := os.Stat(filepath.Join(filepath.Dir(root), "out")); err == nil {
		t.Error("nothing may be written outside the vault")
	}
	bin, err := v.ReadBinary(info.ID, p1)
	if err != nil || bin.Mime != "image/png" || bin.Data != data {
		t.Fatalf("read binary: %+v %v", bin, err)
	}
}

func TestPropertiesTagsTrash(t *testing.T) {
	a, info, root := newTestApp(t)
	v, props, tags := NewVaultAPI(a), NewPropertiesAPI(a), NewTagsAPI(a)
	if _, err := v.WriteNote(info.ID, "Plan.md", "---\nstatus: draft # keep\n---\n# Plan #q4\n", ""); err != nil {
		t.Fatal(err)
	}
	if _, err := v.WriteNote(info.ID, "Other.md", "no frontmatter #q4 #solo\n", ""); err != nil {
		t.Fatal(err)
	}
	waitIndexed(t, a, info.ID, 2)

	note, _ := v.ReadNote(info.ID, "Plan.md")
	res, err := props.Update(info.ID, "Plan.md", "due", `"2026-12-01"`, note.Hash)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := props.Update(info.ID, "Plan.md", "due", `"2027-01-01"`, note.Hash); err == nil || !strings.Contains(err.Error(), "conflict") {
		t.Fatalf("stale hash must conflict: %v", err)
	}
	after, _ := v.ReadNote(info.ID, "Plan.md")
	if after.Hash != res.Hash || !strings.Contains(after.Content, "status: draft # keep") || !strings.Contains(after.Content, "due: 2026-12-01") {
		t.Fatalf("content: %q", after.Content)
	}
	if _, err := props.Update(info.ID, "Plan.md", "amount", `"abc"`, ""); err != nil {
		t.Fatal(err) // untyped: stored as text
	}
	if err := props.SetType(info.ID, "amount", "number"); err != nil {
		t.Fatal(err)
	}
	if _, err := props.Update(info.ID, "Plan.md", "amount", `"abc"`, ""); err == nil {
		t.Error("typed number must reject text")
	}
	if _, err := props.Update(info.ID, "Plan.md", "amount", `"42"`, ""); err != nil {
		t.Fatal(err)
	}
	if err := props.SetType(info.ID, "amount", "bogus"); err == nil {
		t.Error("unknown type must be refused")
	}

	waitProp := func() []PropertyKey {
		for i := 0; i < 100; i++ {
			keys, _ := props.Keys(info.ID)
			if len(keys) >= 3 {
				return keys
			}
			time.Sleep(20 * time.Millisecond)
		}
		keys, _ := props.Keys(info.ID)
		return keys
	}
	keys := waitProp()
	got := map[string]string{}
	for _, k := range keys {
		got[k.Key] = k.Kind
	}
	if got["status"] != "text" || got["due"] != "date" || got["amount"] != "number" {
		t.Fatalf("keys: %+v", keys)
	}

	list, err := tags.List(info.ID)
	if err != nil {
		t.Fatal(err)
	}
	counts := map[string]int{}
	for _, c := range list {
		counts[c.Name] = c.Count
	}
	if counts["q4"] != 2 || counts["solo"] != 1 {
		t.Fatalf("tags: %+v", list)
	}

	// Vault trash mode keeps files inside the vault.
	if err := NewSettingsAPI(a).Set(AppSettings{Theme: "system", TrashMode: "vault"}); err != nil {
		t.Fatal(err)
	}
	dest, err := v.Trash(info.ID, "Other.md")
	if err != nil || dest != ".trash/Other.md" {
		t.Fatalf("trash: %q %v", dest, err)
	}
	if _, err := os.Stat(filepath.Join(root, ".trash", "Other.md")); err != nil {
		t.Fatal("file not in .trash")
	}
	if err := NewSettingsAPI(a).Set(AppSettings{TrashMode: "elsewhere"}); err == nil {
		t.Error("invalid trash mode must be refused")
	}
}

func TestDrawingPreviewCache(t *testing.T) {
	a, info, root := newTestApp(t)
	d := NewDrawingAPI(a)
	hash := strings.Repeat("ab", 32)
	if got, err := d.ReadPreview(info.ID, hash); err != nil || got != "" {
		t.Fatalf("empty cache: %q %v", got, err)
	}
	if err := d.SavePreview(info.ID, hash, `<svg xmlns="http://www.w3.org/2000/svg"></svg>`); err != nil {
		t.Fatal(err)
	}
	if got, _ := d.ReadPreview(info.ID, hash); !strings.HasPrefix(got, "<svg") {
		t.Fatalf("round trip: %q", got)
	}
	if _, err := os.Stat(filepath.Join(root, ".nodus", "cache", "drawings", hash+".svg")); err != nil {
		t.Fatal(err)
	}
	for name, c := range map[string]struct{ hash, svg string }{
		"traversal": {"../../../etc/passwd", "<svg/>"},
		"short":     {"abcd", "<svg/>"},
		"not svg":   {hash, "hello"},
		"script":    {hash, "<svg><script>alert(1)</script></svg>"},
	} {
		if err := d.SavePreview(info.ID, c.hash, c.svg); err == nil {
			t.Errorf("%s must be refused", name)
		}
	}
}
