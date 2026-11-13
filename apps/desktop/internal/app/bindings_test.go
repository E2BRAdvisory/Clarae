package app

import (
	"archive/zip"
	"context"
	"encoding/base64"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/rs/zerolog"

	"clarae/apps/desktop/internal/store"
	syncpkg "clarae/apps/desktop/internal/sync"
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
	if _, err := os.Stat(filepath.Join(root, ".clarae", "editor.json")); err != nil {
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
	if _, err := os.Stat(filepath.Join(root, ".clarae", "cache", "drawings", hash+".svg")); err != nil {
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

func TestImportLegacyDrawing(t *testing.T) {
	a, info, root := newTestApp(t)
	d := NewDrawingAPI(a)
	md := "# Excalidraw Data\n## Embedded Files\nf1: [[cat.png]]\n\n## Drawing\n```json\n" +
		`{"type":"excalidraw","version":2,"elements":[{"id":"a","type":"rectangle"}],"appState":{},"files":{}}` + "\n```\n"
	if err := os.MkdirAll(filepath.Join(root, "boards", "img"), 0o755); err != nil {
		t.Fatal(err)
	}
	for p, data := range map[string]string{"boards/Plan.excalidraw.md": md, "boards/img/cat.png": "PNG"} {
		if err := os.WriteFile(filepath.Join(root, p), []byte(data), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	got, err := d.ImportLegacy(info.ID, "boards/Plan.excalidraw.md")
	if err != nil || got != "boards/Plan.excalidraw" {
		t.Fatalf("import: %q %v", got, err)
	}
	out, err := os.ReadFile(filepath.Join(root, "boards", "Plan.excalidraw"))
	if err != nil || !strings.Contains(string(out), `"dataURL": "data:image/png;base64,UE5H"`) {
		t.Fatalf("converted drawing (images are found by name anywhere in the vault): %s %v", out, err)
	}
	if _, err := os.Stat(filepath.Join(root, "boards", "Plan.excalidraw.md")); err != nil {
		t.Error("the source note must be kept")
	}
	if again, _ := d.ImportLegacy(info.ID, "boards/Plan.excalidraw.md"); again != "boards/Plan 1.excalidraw" {
		t.Errorf("a second import must not overwrite: %q", again)
	}
	if _, err := d.ImportLegacy(info.ID, "boards/img/cat.png"); err == nil {
		t.Error("only .excalidraw.md files can be imported")
	}
}

func TestViewerMountIsReadOnlyThroughTheBindings(t *testing.T) {
	a, _, _ := newTestApp(t)
	ctx := context.Background()
	dir := filepath.Join(a.mountsDir(), "share-1")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "doc.md"), []byte("shared text"), 0o644); err != nil {
		t.Fatal(err)
	}
	mm := syncpkg.MountMeta{ShareID: "share-1", CloudVaultID: "cloud-1", Scope: "share:share-1", Permission: syncpkg.PermViewer, Name: "Team docs", OwnerName: "ada", ResourceType: "folder"}
	if err := syncpkg.PrepareMount(ctx, dir, mm, syncpkg.SessionInfo{ServerURL: "http://cloud.test"}); err != nil {
		t.Fatal(err)
	}
	info, err := a.openVault(dir)
	if err != nil {
		t.Fatal(err)
	}
	if info.Name != "Team docs" {
		t.Fatalf("a mount shows the name of its share, got %q", info.Name)
	}
	v := NewVaultAPI(a)
	if _, err := v.ReadNote(info.ID, "doc.md"); err != nil {
		t.Fatalf("a viewer reads: %v", err)
	}
	for name, err := range map[string]error{
		"WriteNote":    func() error { _, e := v.WriteNote(info.ID, "doc.md", "x", ""); return e }(),
		"CreateFolder": v.CreateFolder(info.ID, "new"),
		"Rename":       v.Rename(info.ID, "doc.md", "other.md"),
		"Trash":        func() error { _, e := v.Trash(info.ID, "doc.md"); return e }(),
		"Attachment":   func() error { _, e := v.SaveAttachment(info.ID, "", "a.png", "AAAA"); return e }(),
		"Property":     func() error { _, e := NewPropertiesAPI(a).Update(info.ID, "doc.md", "k", `"v"`, ""); return e }(),
	} {
		if err == nil || !strings.HasPrefix(err.Error(), "read-only:") {
			t.Errorf("%s on a viewer mount: %v", name, err)
		}
	}
	if b, _ := os.ReadFile(filepath.Join(dir, "doc.md")); string(b) != "shared text" {
		t.Error("the file must be untouched")
	}
	// The same vault as an editor can write.
	mm.Permission = syncpkg.PermEditor
	if err := a.sync.UpdateMount(ctx, info.ID, mm); err != nil {
		t.Fatal(err)
	}
	if _, err := v.WriteNote(info.ID, "doc.md", "edited", func() string { c, _ := v.ReadNote(info.ID, "doc.md"); return c.Hash }()); err != nil {
		t.Fatalf("an editor writes: %v", err)
	}
}

func TestExportZipWritesAnArchiveOutsideTheVault(t *testing.T) {
	a, info, root := newTestApp(t)
	if err := os.WriteFile(filepath.Join(root, "Home.md"), []byte("# Home"), 0o644); err != nil {
		t.Fatal(err)
	}
	dest := filepath.Join(t.TempDir(), "backup") // no extension: ".zip" is added
	res, err := a.exportZip(info.ID, dest)
	if err != nil {
		t.Fatal(err)
	}
	if res.Path != dest+".zip" || res.Files < 1 {
		t.Fatalf("result: %+v", res)
	}
	zr, err := zip.OpenReader(res.Path)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = zr.Close() }()
	found := false
	for _, f := range zr.File {
		found = found || f.Name == "Home.md"
	}
	if !found {
		t.Fatal("Home.md is not in the archive")
	}
	entries, _ := os.ReadDir(filepath.Dir(dest))
	if len(entries) != 1 {
		t.Fatalf("leftover files next to the archive: %v", entries)
	}
	// Inside the vault: refused.
	if _, err := a.exportZip(info.ID, filepath.Join(root, "self.zip")); err == nil {
		t.Fatal("exporting into the vault itself must fail")
	}
}

func TestExportFilename(t *testing.T) {
	now := time.Date(2026, 10, 24, 9, 0, 0, 0, time.UTC)
	for in, want := range map[string]string{
		"My Vault":   "My_Vault-20261024.zip",
		"../../etc":  "etc-20261024.zip",
		"???":        "vault-20261024.zip",
		"Archivio é": "Archivio_é-20261024.zip",
	} {
		if got := exportFilename(in, now); got != want {
			t.Errorf("exportFilename(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestExportTarget(t *testing.T) {
	for _, c := range []struct {
		path, variant, format, want string
		ok                          bool
	}{
		{"Board.excalidraw", "", "png", "Board.excalidraw.png", true},
		{"a/b/Board.excalidraw", "dark", "svg", "a/b/Board.excalidraw.dark.svg", true},
		{"Board.EXCALIDRAW", "light", "png", "Board.EXCALIDRAW.light.png", true},
		{"note.md", "", "png", "", false},
		{"Board.excalidraw", "sepia", "png", "", false},
		{"Board.excalidraw", "", "gif", "", false},
		{"Board.excalidraw", "../x", "png", "", false},
	} {
		got, err := exportTarget(c.path, c.variant, c.format)
		if (err == nil) != c.ok || got != c.want {
			t.Errorf("exportTarget(%q,%q,%q) = %q, %v", c.path, c.variant, c.format, got, err)
		}
	}
}

// The compressed block is what the Obsidian plugin writes by default (lz-string, base64).
func TestImportLegacyDrawingCompressedAndImageCap(t *testing.T) {
	a, info, root := newTestApp(t)
	d := NewDrawingAPI(a)
	compressed := "N4IgLgngDgpiBcIYA8DGBDANgSwCYCd0B3EAGhADcZ8BnbAewDsEAmcm+gV31TkQAswYKDXgB6MSgw4CxAHSp6AWzJJMMJTEZgaCANqg8CEOgCMqyLGP4YqMOkYBzdauQIADOQgfyRPGH4EU08QfhhsR0EgkLAUMGN+AEvMTHoAAkBgMjTAFg3APF2QAF8AXXJ0KCgAZXtYhFAKbBgiACF0VABrR3wuRlwAYXpU/GMAYgAzccLyUex1XXhgAoKgA"
	md := "## Embedded Files\nbig1: [[a.png]]\nbig2: [[b.png]]\n\n## Drawing\n```compressed-json\n" + compressed + "\n```\n"
	// Two images of 25 MB: only the first fits the 40 MB cap.
	files := map[string][]byte{"n.excalidraw.md": []byte(md), "a.png": make([]byte, 25<<20), "b.png": make([]byte, 25<<20)}
	for p, data := range files {
		if err := os.WriteFile(filepath.Join(root, p), data, 0o644); err != nil {
			t.Fatal(err)
		}
	}
	got, err := d.ImportLegacy(info.ID, "n.excalidraw.md")
	if err != nil {
		t.Fatal(err)
	}
	out, err := os.ReadFile(filepath.Join(root, got))
	if err != nil {
		t.Fatal(err)
	}
	var s struct {
		Elements []json.RawMessage          `json:"elements"`
		Files    map[string]json.RawMessage `json:"files"`
	}
	if err := json.Unmarshal(out, &s); err != nil {
		t.Fatal(err)
	}
	if len(s.Elements) == 0 || !strings.Contains(string(out), "héllo") {
		t.Errorf("compressed scene not decoded: %.200s", out)
	}
	if len(s.Files) != 1 {
		t.Errorf("the image cap must keep %d of 2 images, got %d", 1, len(s.Files))
	}
}

func TestSettingsInfoReportsThePlatform(t *testing.T) {
	a := New(Options{Version: "1.2.3"})
	info := NewSettingsAPI(a).Info()
	want := "desktop"
	if isWeb {
		want = "web"
	}
	if info["platform"] != want || info["version"] != "1.2.3" {
		t.Fatalf("Info() = %v, want platform %q", info, want)
	}
}
