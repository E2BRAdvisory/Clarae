package app

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"nodus/apps/desktop/internal/sync/transport"
)

func TestDailyAndUniqueNotes(t *testing.T) {
	a, info, root := newTestApp(t)
	tpl := NewTemplatesAPI(a)
	v := NewVaultAPI(a)
	if _, err := v.WriteNote(info.ID, "Templates/Daily.md", "# {{title}}\n{{date:dddd}} {{date}}\n{{nope}}\n", ""); err != nil {
		t.Fatal(err)
	}
	opts := DailyOptions{Date: "2026-03-05", Folder: "Journal", Format: "YYYY-MM-DD", Template: "Templates/Daily.md", Lang: "en"}
	res, err := tpl.OpenDaily(info.ID, opts)
	if err != nil || !res.Created || res.Path != "Journal/2026-03-05.md" {
		t.Fatalf("OpenDaily = %+v, %v", res, err)
	}
	data, _ := os.ReadFile(filepath.Join(root, "Journal", "2026-03-05.md"))
	if string(data) != "# 2026-03-05\nThursday 2026-03-05\n{{nope}}\n" {
		t.Errorf("daily content = %q", data)
	}
	// Opening again must not recreate or overwrite it.
	if err := os.WriteFile(filepath.Join(root, "Journal", "2026-03-05.md"), []byte("edited"), 0o644); err != nil {
		t.Fatal(err)
	}
	res, err = tpl.OpenDaily(info.ID, opts)
	if err != nil || res.Created {
		t.Fatalf("second OpenDaily = %+v, %v", res, err)
	}
	if got := tpl.DailyAdjacent("Journal/2026-03-05.md", "Journal", "YYYY-MM-DD", "en", -1); got != "2026-03-04" {
		t.Errorf("DailyAdjacent = %q", got)
	}
	if _, err := tpl.OpenDaily(info.ID, DailyOptions{Date: "5 March"}); err == nil {
		t.Error("a malformed date must fail")
	}
	// A missing template still creates the (empty) note.
	res, err = tpl.OpenDaily(info.ID, DailyOptions{Date: "2026-03-06", Template: "Templates/Missing.md"})
	if err != nil || !res.Created {
		t.Fatalf("OpenDaily without template = %+v, %v", res, err)
	}

	u1, err := tpl.NewUnique(info.ID, UniqueOptions{Folder: "Zettel", Format: "YYYYMMDDHHmmss"})
	if err != nil || !strings.HasPrefix(u1.Path, "Zettel/") {
		t.Fatalf("NewUnique = %+v, %v", u1, err)
	}
	u2, err := tpl.NewUnique(info.ID, UniqueOptions{Folder: "Zettel", Format: "[fixed]"})
	if err != nil {
		t.Fatal(err)
	}
	u3, err := tpl.NewUnique(info.ID, UniqueOptions{Folder: "Zettel", Format: "[fixed]"})
	if err != nil || u3.Path == u2.Path {
		t.Fatalf("clashing unique notes: %+v %+v %v", u2, u3, err)
	}
}

func TestTemplateLibraryFromMount(t *testing.T) {
	a, info, _ := newTestApp(t)
	tpl := NewTemplatesAPI(a)
	if _, err := NewVaultAPI(a).WriteNote(info.ID, "Templates/Mine.md", "x", ""); err != nil {
		t.Fatal(err)
	}
	got, err := tpl.List(info.ID, "")
	if err != nil || len(got) != 1 || got[0].Source != "vault" {
		t.Fatalf("List without library = %+v, %v", got, err)
	}

	const share = "0a1b2c3d-0000-4000-8000-000000000001"
	cfg := transport.EffectiveConfig{Config: map[string]any{"templates": map[string]any{"library_share_id": share}}}
	_, err = a.config.Refresh(context.Background(), "https://cloud.example", func(context.Context, string) (transport.EffectiveConfig, string, bool, error) {
		return cfg, "e1", true, nil
	})
	if err != nil {
		t.Fatal(err)
	}
	// Configured but not mounted: nothing happens.
	if got, _ := tpl.List(info.ID, ""); len(got) != 1 {
		t.Fatalf("unmounted library must add nothing: %+v", got)
	}
	dir := filepath.Join(a.mountsDir(), share)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "Shared.md"), []byte("Hello {{title}}"), 0o644); err != nil {
		t.Fatal(err)
	}
	got, err = tpl.List(info.ID, "")
	if err != nil || len(got) != 2 || got[1].Source != "library" || got[1].Ref != "library:Shared.md" {
		t.Fatalf("List with library = %+v, %v", got, err)
	}
	text, err := tpl.Expand(info.ID, "library:Shared.md", "T", "en")
	if err != nil || text != "Hello T" {
		t.Fatalf("Expand library = %q, %v", text, err)
	}
	if _, err := tpl.Expand(info.ID, "library:../../escape.md", "T", "en"); err == nil {
		t.Error("a path escaping the library must be refused")
	}
	p, err := tpl.CreateFromTemplate(info.ID, "Notes", "From lib", "library:Shared.md", "en")
	if err != nil || p != "Notes/From lib.md" {
		t.Fatalf("CreateFromTemplate = %q, %v", p, err)
	}
}
