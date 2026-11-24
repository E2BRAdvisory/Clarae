package app

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	"clarae/apps/desktop/internal/composer"
	syncpkg "clarae/apps/desktop/internal/sync"
	"clarae/apps/desktop/internal/sync/transport"
	"clarae/shared/pathrules"
)

// tplDir is the templates folder of a vault, tplFormer the same under the former name of the
// configuration folder (a vault shared with a 1.x client, ADR-0052).
var (
	tplDir    = pathrules.ConfigDir + "/" + pathrules.TemplatesDir
	tplFormer = pathrules.LegacyConfigDirs[0] + "/" + pathrules.TemplatesDir
)

func putVaultFile(t *testing.T, root, rel, content string) {
	t.Helper()
	abs := filepath.Join(root, filepath.FromSlash(rel))
	if err := os.MkdirAll(filepath.Dir(abs), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(abs, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
}

func vaultFile(t *testing.T, root, rel string) (string, bool) {
	t.Helper()
	b, err := os.ReadFile(filepath.Join(root, filepath.FromSlash(rel)))
	if err != nil {
		if os.IsNotExist(err) {
			return "", false
		}
		t.Fatal(err)
	}
	return string(b), true
}

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
	if _, err := tpl.Create(info.ID, "Mine", "note", "x"); err != nil {
		t.Fatal(err)
	}
	got, err := tpl.List(info.ID)
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
	if got, _ := tpl.List(info.ID); len(got) != 1 {
		t.Fatalf("unmounted library must add nothing: %+v", got)
	}
	dir := filepath.Join(a.mountsDir(), share)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "Shared.md"), []byte("Hello {{title}}"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "Board.excalidraw"), []byte(`{"type":"excalidraw","elements":[]}`), 0o644); err != nil {
		t.Fatal(err)
	}
	got, err = tpl.List(info.ID)
	if err != nil || len(got) != 3 || got[1].Source != "library" || got[1].Ref != "library:Board.excalidraw" || got[1].Kind != "drawing" ||
		got[2].Ref != "library:Shared.md" || got[2].Kind != "note" || got[2].Library == "" {
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

func TestTemplatesOfTheVault(t *testing.T) {
	a, info, root := newTestApp(t)
	tpl := NewTemplatesAPI(a)
	const scene = `{"type":"excalidraw","elements":[{"id":"a","type":"text","text":"{{title}}"}]}`

	note, err := tpl.Create(info.ID, "Meeting.md", "note", "# {{title}}\n")
	if err != nil || note.Path != tplDir+"/Meeting.md" || note.Ref != tplDir+"/Meeting.md" || note.Rel != "Meeting.md" || note.Name != "Meeting" || note.Kind != "note" || note.Source != "vault" {
		t.Fatalf("Create note = %+v, %v", note, err)
	}
	draw, err := tpl.Create(info.ID, "Board", "drawing", scene)
	if err != nil || draw.Path != tplDir+"/Board.excalidraw" || draw.Kind != "drawing" {
		t.Fatalf("Create drawing = %+v, %v", draw, err)
	}
	deck, err := tpl.Create(info.ID, "Talk", "presentation", "---\nmarp: true\n---\n\n# {{title}}\n")
	if err != nil || deck.Path != tplDir+"/Talk.marp" || deck.Kind != "presentation" {
		t.Fatalf("Create presentation = %+v, %v", deck, err)
	}
	// A taken name gets a suffix, nothing is overwritten; an unusable name becomes "Untitled".
	again, err := tpl.Create(info.ID, "Meeting", "note", "other")
	if err != nil || again.Rel != "Meeting 2.md" {
		t.Fatalf("Create over a taken name = %+v, %v", again, err)
	}
	if got, _ := vaultFile(t, root, tplDir+"/Meeting.md"); got != "# {{title}}\n" {
		t.Fatalf("the first template was overwritten: %q", got)
	}
	if un, err := tpl.Create(info.ID, " / ", "note", ""); err != nil || un.Rel != "Untitled.md" {
		t.Fatalf("Create without a usable name = %+v, %v", un, err)
	}
	for name, c := range map[string][3]string{
		"an unknown kind":           {"X", "canvas", "{}"},
		"a drawing that is no JSON": {"X", "drawing", "# not a drawing"},
		"a name no Windows has":     {"CON", "note", ""},
	} {
		if got, err := tpl.Create(info.ID, c[0], c[1], c[2]); err == nil {
			t.Errorf("%s: created %+v", name, got)
		}
	}

	list, err := tpl.List(info.ID)
	if err != nil {
		t.Fatal(err)
	}
	var rels []string
	for _, x := range list {
		rels = append(rels, x.Rel+"|"+x.Kind)
	}
	if want := []string{"Board.excalidraw|drawing", "Meeting 2.md|note", "Meeting.md|note", "Talk.marp|presentation", "Untitled.md|note"}; !reflect.DeepEqual(rels, want) {
		t.Fatalf("List = %v", rels)
	}

	// Variables: expanded in a note and in a presentation, never in a drawing.
	if got, err := tpl.Expand(info.ID, note.Ref, "Kickoff", "en"); err != nil || got != "# Kickoff\n" {
		t.Fatalf("Expand note = %q, %v", got, err)
	}
	if got, err := tpl.Expand(info.ID, deck.Ref, "Kickoff", "en"); err != nil || !strings.HasSuffix(got, "# Kickoff\n") {
		t.Fatalf("Expand presentation = %q, %v", got, err)
	}
	if got, err := tpl.Expand(info.ID, draw.Ref, "Kickoff", "en"); err != nil || got != scene {
		t.Fatalf("Expand drawing = %q, %v", got, err)
	}

	// A template the vault still keeps under the former name of the configuration folder is listed
	// and read with the same reference.
	putVaultFile(t, root, tplFormer+"/Old.md", "old {{title}}")
	if got, err := tpl.Expand(info.ID, tplDir+"/Old.md", "T", "en"); err != nil || got != "old T" {
		t.Fatalf("Expand from the former folder = %q, %v", got, err)
	}
	list, _ = tpl.List(info.ID)
	found := false
	for _, x := range list {
		if x.Rel == "Old.md" {
			found = x.Ref == tplDir+"/Old.md" && x.Path == tplFormer+"/Old.md"
		}
	}
	if !found {
		t.Fatalf("the template of the former folder: %+v", list)
	}

	// What is not a template is never read as one.
	putVaultFile(t, root, pathrules.ConfigDir+"/editor.md", "a settings file")
	putVaultFile(t, root, "Notes/data.json", "{}")
	for _, ref := range []string{pathrules.ConfigDir + "/editor.md", "Notes/data.json", tplDir + "/../editor.md", "../outside.md", tplDir + "/Missing.md"} {
		if got, err := tpl.Expand(info.ID, ref, "T", "en"); err == nil {
			t.Errorf("Expand(%q) = %q, want an error", ref, got)
		}
	}

	// A note is only created from the template of a note; a daily note falls back to an empty one.
	if p, err := tpl.CreateFromTemplate(info.ID, "", "From board", draw.Ref, "en"); err == nil {
		t.Errorf("a note was created from a drawing: %q", p)
	}
	if p, err := tpl.CreateFromTemplate(info.ID, "Notes", "Kickoff", note.Ref, "en"); err != nil || p != "Notes/Kickoff.md" {
		t.Fatalf("CreateFromTemplate = %q, %v", p, err)
	} else if got, _ := vaultFile(t, root, p); got != "# Kickoff\n" {
		t.Fatalf("the note from the template = %q", got)
	}
	res, err := tpl.OpenDaily(info.ID, DailyOptions{Date: "2026-03-05", Template: draw.Ref})
	if err != nil || !res.Created {
		t.Fatalf("OpenDaily with the template of a drawing = %+v, %v", res, err)
	}
	if got, _ := vaultFile(t, root, res.Path); got != "" {
		t.Fatalf("a daily note took the content of a drawing: %q", got)
	}
}

func dailyKeys(t *testing.T, root string) map[string]any {
	t.Helper()
	text, ok := vaultFile(t, root, pathrules.ConfigDir+"/daily.json")
	if !ok {
		return nil
	}
	var m map[string]any
	if err := json.Unmarshal([]byte(text), &m); err != nil {
		t.Fatalf("daily.json: %v\n%s", err, text)
	}
	return m
}

func TestMigrateTemplates(t *testing.T) {
	a, info, root := newTestApp(t)
	tpl := NewTemplatesAPI(a)
	putVaultFile(t, root, "Models/Daily.md", "# {{title}}")
	putVaultFile(t, root, "Models/sub/Board.excalidraw", "{}")
	putVaultFile(t, root, "Models/Talk.marp", "---\nmarp: true\n---\n")
	putVaultFile(t, root, "Models/pic.png", "png")
	putVaultFile(t, root, "Templates/NotATemplateFolderAnyMore.md", "x")
	putVaultFile(t, root, pathrules.ConfigDir+"/daily.json",
		`{"templatesFolder":"Models/","dailyTemplate":"Models/Daily.md","newNoteTemplate":"Models/Daily.md","uniqueTemplate":"library:Shared.md","slashCommands":false,"somethingNewer":{"a":1}}`)

	plan, err := tpl.MigrationPlan(info.ID)
	want := []string{"Models/Daily.md", "Models/Talk.marp", "Models/sub/Board.excalidraw"}
	if err != nil || plan.Done || plan.Blocked != "" || plan.Folder != "Models" || !reflect.DeepEqual(plan.Files, want) {
		t.Fatalf("MigrationPlan = %+v, %v", plan, err)
	}
	if _, moved := vaultFile(t, root, tplDir+"/Daily.md"); moved {
		t.Fatal("the plan moved a file")
	}

	res, err := tpl.Migrate(info.ID)
	if err != nil || !res.Done || res.Moved != 3 || len(res.Skipped) != 0 {
		t.Fatalf("Migrate = %+v, %v", res, err)
	}
	for _, rel := range []string{"Daily.md", "Talk.marp", "sub/Board.excalidraw"} {
		if _, ok := vaultFile(t, root, tplDir+"/"+rel); !ok {
			t.Errorf("%s was not moved", rel)
		}
		if _, ok := vaultFile(t, root, "Models/"+rel); ok {
			t.Errorf("%s was copied, not moved", rel)
		}
	}
	// What is not a template stays, and so does its folder; the folder left empty goes.
	if _, ok := vaultFile(t, root, "Models/pic.png"); !ok {
		t.Error("a file that is not a template was moved")
	}
	if _, err := os.Stat(filepath.Join(root, "Models", "sub")); !os.IsNotExist(err) {
		t.Errorf("the folder left empty is still there: %v", err)
	}
	if _, ok := vaultFile(t, root, "Templates/NotATemplateFolderAnyMore.md"); !ok {
		t.Error("the default folder was moved although the vault names another")
	}
	keys := dailyKeys(t, root)
	wantKeys := map[string]any{
		"dailyTemplate": tplDir + "/Daily.md", "newNoteTemplate": tplDir + "/Daily.md", "uniqueTemplate": "library:Shared.md",
		"slashCommands": false, "somethingNewer": map[string]any{"a": float64(1)},
		"templatesMigrated": true, "templatesMigratedFrom": "Models",
	}
	if !reflect.DeepEqual(keys, wantKeys) {
		t.Fatalf("daily.json = %v\nwant         %v", keys, wantKeys)
	}
	if plan, err := tpl.MigrationPlan(info.ID); err != nil || !plan.Done {
		t.Fatalf("the plan of a migrated vault = %+v, %v", plan, err)
	}
	list, _ := tpl.List(info.ID)
	if len(list) != 3 {
		t.Fatalf("List after the migration = %+v", list)
	}

	// A reference nobody rewrote (the administrator's, another device's) still finds the file.
	if got, err := tpl.Expand(info.ID, "Models/Daily.md", "T", "en"); err != nil || got != "# T" {
		t.Fatalf("Expand through the old reference = %q, %v", got, err)
	}
	opened, err := tpl.OpenDaily(info.ID, DailyOptions{Date: "2026-03-05", Template: "Models/Daily.md"})
	if err != nil || !opened.Created {
		t.Fatal(err)
	}
	if got, _ := vaultFile(t, root, opened.Path); got != "# 2026-03-05" {
		t.Fatalf("the daily note of an old reference = %q", got)
	}
	if _, err := tpl.Expand(info.ID, "Other/Daily.md", "T", "en"); err == nil {
		t.Error("a reference outside the migrated folder found a template")
	}

	// The import runs again: new files move, a taken name stays where it is, with its content.
	putVaultFile(t, root, "Models/Daily.md", "a second one")
	putVaultFile(t, root, "Models/New.md", "new")
	res, err = tpl.Migrate(info.ID)
	if err != nil || res.Moved != 1 || !reflect.DeepEqual(res.Skipped, []string{"Models/Daily.md"}) {
		t.Fatalf("second Migrate = %+v, %v", res, err)
	}
	if got, _ := vaultFile(t, root, "Models/Daily.md"); got != "a second one" {
		t.Errorf("the skipped file = %q", got)
	}
	if got, _ := vaultFile(t, root, tplDir+"/Daily.md"); got != "# {{title}}" {
		t.Errorf("a template was overwritten: %q", got)
	}
	// The file that stayed is the one its old reference reads.
	if got, _ := tpl.Expand(info.ID, "Models/Daily.md", "T", "en"); got != "a second one" {
		t.Errorf("the old reference with the file back in place = %q", got)
	}
}

func TestMigrateTemplatesDefaultFolderAndDecline(t *testing.T) {
	a, info, root := newTestApp(t)
	tpl := NewTemplatesAPI(a)

	// Nothing to move: nothing is asked, and the answer is recorded by Migrate or by DeclineMigration.
	plan, err := tpl.MigrationPlan(info.ID)
	if err != nil || plan.Done || plan.Blocked != "" || len(plan.Files) != 0 || plan.Folder != "Templates" {
		t.Fatalf("MigrationPlan of an empty vault = %+v, %v", plan, err)
	}
	if keys := dailyKeys(t, root); keys != nil {
		t.Fatalf("the plan wrote daily.json: %v", keys)
	}
	putVaultFile(t, root, "Templates/Daily.md", "d")
	if plan, _ = tpl.MigrationPlan(info.ID); !reflect.DeepEqual(plan.Files, []string{"Templates/Daily.md"}) {
		t.Fatalf("the default folder = %+v", plan)
	}
	if err := tpl.DeclineMigration(info.ID); err != nil {
		t.Fatal(err)
	}
	if plan, _ = tpl.MigrationPlan(info.ID); !plan.Done {
		t.Fatalf("a declined migration is offered again: %+v", plan)
	}
	if _, ok := vaultFile(t, root, "Templates/Daily.md"); !ok {
		t.Fatal("a declined migration moved the file")
	}
	if keys := dailyKeys(t, root); !reflect.DeepEqual(keys, map[string]any{"templatesMigrated": true}) {
		t.Fatalf("daily.json after a decline = %v", keys)
	}
	// The command still imports the folder, which goes once it is empty.
	res, err := tpl.Migrate(info.ID)
	if err != nil || res.Moved != 1 || !res.Done {
		t.Fatalf("Migrate after a decline = %+v, %v", res, err)
	}
	if _, err := os.Stat(filepath.Join(root, "Templates")); !os.IsNotExist(err) {
		t.Errorf("the emptied folder is still there: %v", err)
	}
	if keys := dailyKeys(t, root); keys["templatesMigratedFrom"] != "Templates" {
		t.Fatalf("daily.json after the import = %v", keys)
	}
}

// A folder shared with the user keeps no templates of its own: its configuration folder is a folder
// of the share, and a file written there reaches the owner and the other recipients as content.
func TestTemplatesOfAMountAreNeverWritten(t *testing.T) {
	a, _, _ := newTestApp(t)
	ctx := context.Background()
	tpl := NewTemplatesAPI(a)
	dir := filepath.Join(a.mountsDir(), "share-1")
	putVaultFile(t, dir, "Templates/Daily.md", "shared template")
	putVaultFile(t, dir, tplDir+"/Theirs.md", "from the share")
	mm := syncpkg.MountMeta{ShareID: "share-1", CloudVaultID: "cloud-1", Scope: "share:share-1", Permission: syncpkg.PermEditor, Name: "Team docs", OwnerName: "ada", ResourceType: "folder"}
	if err := syncpkg.PrepareMount(ctx, dir, mm, syncpkg.SessionInfo{ServerURL: "http://cloud.test"}); err != nil {
		t.Fatal(err)
	}
	info, err := a.openVault(dir)
	if err != nil {
		t.Fatal(err)
	}
	for _, perm := range []string{syncpkg.PermEditor, syncpkg.PermViewer} {
		mm.Permission = perm
		if err := a.sync.UpdateMount(ctx, info.ID, mm); err != nil {
			t.Fatal(err)
		}
		if got, err := tpl.Create(info.ID, "Mine", "note", "x"); err == nil {
			t.Fatalf("%s: a template was created in a mount: %+v", perm, got)
		}
		plan, err := tpl.MigrationPlan(info.ID)
		if err != nil || plan.Blocked == "" || plan.Done {
			t.Fatalf("%s: MigrationPlan = %+v, %v", perm, plan, err)
		}
		if res, err := tpl.Migrate(info.ID); err != nil || res.Blocked == "" || res.Moved != 0 || res.Done {
			t.Fatalf("%s: Migrate = %+v, %v", perm, res, err)
		}
		_ = tpl.DeclineMigration(info.ID)
		if _, ok := vaultFile(t, dir, "Templates/Daily.md"); !ok {
			t.Fatalf("%s: the file of the share was moved", perm)
		}
		if _, ok := vaultFile(t, dir, pathrules.ConfigDir+"/daily.json"); ok {
			t.Fatalf("%s: a settings file was written into the share", perm)
		}
		// What the share already holds there can be listed and used.
		if list, err := tpl.List(info.ID); err != nil || len(list) != 1 || list[0].Rel != "Theirs.md" {
			t.Fatalf("%s: List = %+v, %v", perm, list, err)
		}
	}
}

// The template of a drawing, open in a tab like any drawing, gets no export file next to it: the
// picture would sync with the settings and sit among the templates.
func TestNoExportFileNextToATemplate(t *testing.T) {
	a, info, root := newTestApp(t)
	draw, err := NewTemplatesAPI(a).Create(info.ID, "Board", "drawing", `{"type":"excalidraw","elements":[]}`)
	if err != nil {
		t.Fatal(err)
	}
	svg := "PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciLz4=" // <svg xmlns="http://www.w3.org/2000/svg"/>
	if p, err := NewDrawingAPI(a).WriteExport(info.ID, draw.Path, "", "svg", svg); err == nil {
		t.Fatalf("an export was written next to a template: %q", p)
	}
	if _, ok := vaultFile(t, root, draw.Path+".svg"); ok {
		t.Fatal("the export file exists")
	}
}

// The frontend saves the settings it holds, whole. One that loaded them before the templates were
// moved (here, or on another device) must not take away what the core wrote: the references to the
// folder the templates left would stop resolving, and notes would be born empty.
func TestWriteSettingsKeepsTheOutcomeOfTheMigration(t *testing.T) {
	a, info, root := newTestApp(t)
	tpl := NewTemplatesAPI(a)
	putVaultFile(t, root, "Templates/Daily.md", "# {{title}}")
	putVaultFile(t, root, "Templates/mine/.keep", "") // not a template: the folder is the user's
	if err := os.MkdirAll(filepath.Join(root, "Templates", "empty"), 0o755); err != nil {
		t.Fatal(err)
	}
	stale := `{"dailyTemplate":"Templates/Daily.md","slashCommands":false}`
	if err := tpl.WriteSettings(info.ID, stale); err != nil {
		t.Fatal(err)
	}
	res, err := tpl.Migrate(info.ID)
	if err != nil || res.Moved != 1 || res.Paths["Templates/Daily.md"] != tplDir+"/Daily.md" {
		t.Fatalf("Migrate = %+v, %v", res, err)
	}
	// An empty folder the user made is not the migration's to remove.
	if _, err := os.Stat(filepath.Join(root, "Templates", "empty")); err != nil {
		t.Errorf("an empty folder of the user was removed: %v", err)
	}

	// The stale frontend saves: its values stand, the keys of the core stay.
	if err := tpl.WriteSettings(info.ID, stale); err != nil {
		t.Fatal(err)
	}
	keys := dailyKeys(t, root)
	if keys["templatesMigrated"] != true || keys["templatesMigratedFrom"] != "Templates" || keys["slashCommands"] != false {
		t.Fatalf("daily.json after a stale save = %v", keys)
	}
	if got, err := tpl.Expand(info.ID, "Templates/Daily.md", "T", "en"); err != nil || got != "# T" {
		t.Fatalf("the old reference after a stale save = %q, %v", got, err)
	}
	if plan, _ := tpl.MigrationPlan(info.ID); !plan.Done {
		t.Fatalf("the migration is offered again: %+v", plan)
	}
	// Nor can a frontend forge or clear them.
	if err := tpl.WriteSettings(info.ID, `{"templatesMigrated":false,"templatesMigratedFrom":"Elsewhere"}`); err != nil {
		t.Fatal(err)
	}
	if keys := dailyKeys(t, root); keys["templatesMigrated"] != true || keys["templatesMigratedFrom"] != "Templates" {
		t.Fatalf("daily.json after a forged save = %v", keys)
	}
}

// A daily.json that is not valid JSON (edited by hand) is the only copy of what the user wrote:
// the migration neither runs nor records an answer over it.
func TestMigrationLeavesAnInvalidSettingsFileAlone(t *testing.T) {
	a, info, root := newTestApp(t)
	tpl := NewTemplatesAPI(a)
	const broken = `{"dailyFolder":"Journal",}`
	putVaultFile(t, root, pathrules.ConfigDir+"/daily.json", broken)
	putVaultFile(t, root, "Templates/Daily.md", "d")
	if plan, err := tpl.MigrationPlan(info.ID); err == nil {
		t.Fatalf("MigrationPlan = %+v", plan)
	}
	if res, err := tpl.Migrate(info.ID); err == nil {
		t.Fatalf("Migrate = %+v", res)
	}
	if err := tpl.DeclineMigration(info.ID); err == nil {
		t.Fatal("DeclineMigration wrote over an invalid file")
	}
	if got, _ := vaultFile(t, root, pathrules.ConfigDir+"/daily.json"); got != broken {
		t.Fatalf("daily.json = %q", got)
	}
	if _, ok := vaultFile(t, root, "Templates/Daily.md"); !ok {
		t.Fatal("a file was moved")
	}
}

// A note extracted from a template open in a tab does not land among the templates.
func TestExtractFromATemplateGoesToTheVault(t *testing.T) {
	a, info, _ := newTestApp(t)
	tp, err := NewTemplatesAPI(a).Create(info.ID, "Meeting", "note", "# Meeting\n\nsome text\n")
	if err != nil {
		t.Fatal(err)
	}
	res, err := NewComposerAPI(a).Extract(info.ID, composer.ExtractOptions{SourcePath: tp.Path, Selection: "some text", Title: "Piece"})
	if err != nil || res.Path != "Piece.md" {
		t.Fatalf("Extract = %+v, %v", res, err)
	}
}
