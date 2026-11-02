package access

import (
	"testing"

	"github.com/google/uuid"
)

func folderScope(prefix string) *Scope {
	return NewScope(uuid.New(), ResourceFolder, &prefix, nil)
}

func TestPermissionOrderAndParsing(t *testing.T) {
	if None >= Viewer || Viewer >= Editor || Editor >= Manager || Manager >= Owner {
		t.Fatal("levels must be ordered")
	}
	for _, s := range []string{"viewer", "editor", "manager", "owner"} {
		if ParsePermission(s).String() != s {
			t.Errorf("round trip %s", s)
		}
	}
	if ParsePermission("root") != None || Viewer.CanWrite() || !Editor.CanWrite() {
		t.Error("unknown levels grant nothing; only editor and above write")
	}
}

func TestParseScope(t *testing.T) {
	id := uuid.New()
	if got, ok := ParseScope("share:" + id.String()); !ok || got != id {
		t.Fatal("valid scope")
	}
	for _, bad := range []string{"", "share:", "share:xyz", "vault:" + id.String(), id.String()} {
		if _, ok := ParseScope(bad); ok {
			t.Errorf("%q must not parse", bad)
		}
	}
}

func TestFolderScopeContainsAndTranslatesPaths(t *testing.T) {
	s := folderScope("Progetti/Alfa")
	for p, want := range map[string]bool{
		"Progetti/Alfa/a.md":       true,
		"progetti/alfa/Sub/b.md":   true,  // case-insensitive like path_key
		"Progetti/Alfa":            false, // the folder itself is not a file
		"Progetti/Alfabeto/a.md":   false, // a sibling with the same leading letters
		"Progetti/Beta/a.md":       false,
		"Altro/Progetti/Alfa/a.md": false,
	} {
		if got := s.ContainsPath(p); got != want {
			t.Errorf("ContainsPath(%q) = %v", p, got)
		}
	}
	if got := s.Rel("Progetti/Alfa/Sub/b.md"); got != "Sub/b.md" {
		t.Errorf("Rel = %q", got)
	}
	if got := s.Rel("progetti/alfa/b.md"); got != "b.md" {
		t.Errorf("Rel (case) = %q", got)
	}
	abs, err := s.Abs("Sub/b.md")
	if err != nil || abs != "Progetti/Alfa/Sub/b.md" {
		t.Errorf("Abs = %q, %v", abs, err)
	}
	for _, bad := range []string{"../x.md", "/etc/passwd", "a/../../b.md", ""} {
		if got, err := s.Abs(bad); err == nil && !s.ContainsPath(got) {
			t.Errorf("Abs(%q) escaped the share: %q", bad, got)
		} else if err == nil && bad != "/etc/passwd" && bad != "" {
			t.Errorf("Abs(%q) should be refused, got %q", bad, got)
		}
	}
}

func TestVaultAndFileScopes(t *testing.T) {
	v := NewScope(uuid.New(), ResourceVault, nil, nil)
	if !v.ContainsPath("any/where.md") || v.Rel("a/b.md") != "a/b.md" {
		t.Error("a vault share covers everything unchanged")
	}
	fid := uuid.New()
	f := NewScope(uuid.New(), ResourceFile, nil, &fid)
	if !f.ContainsFile(fid, "Docs/Plan.md") || f.ContainsFile(uuid.New(), "Docs/Plan.md") {
		t.Error("a document share matches by file id")
	}
	if f.ContainsPath("Docs/Plan.md") || f.Rel("Docs/Plan.md") != "Plan.md" {
		t.Error("a document share exposes its base name and no folder")
	}
	if _, err := f.Abs("x.md"); err == nil {
		t.Error("a document share has no paths to address")
	}
}

func TestProjectRevisionsThroughAShare(t *testing.T) {
	sp := func(s string) *string { return &s }
	id := uuid.New()
	sc := folderScope("Projects/Acme")
	cases := []struct {
		name       string
		op, path   string
		prev       *string
		ok         bool
		wantOp     string
		wantPath   string
		wantPrev   *string
		wantBlobOK bool
	}{
		{"modify inside", "modify", "Projects/Acme/x.md", nil, true, "modify", "x.md", nil, true},
		{"modify outside", "modify", "HR/x.md", nil, false, "", "", nil, false},
		{"move inside", "move", "Projects/Acme/b/x.md", sp("Projects/Acme/x.md"), true, "move", "b/x.md", sp("x.md"), true},
		// Where the file came from is not shared: no prev_path.
		{"move in", "move", "Projects/Acme/x.md", sp("HR/Confidential/x.md"), true, "create", "x.md", nil, true},
		{"move out", "move", "HR/x.md", sp("Projects/Acme/x.md"), true, "delete", "x.md", nil, false},
		{"move outside", "move", "HR/y.md", sp("HR/x.md"), false, "", "", nil, false},
		{"case-folded prefix", "create", "projects/ACME/x.md", nil, true, "create", "x.md", nil, true},
	}
	for _, c := range cases {
		got, ok := sc.Project(id, c.op, c.path, c.prev)
		if ok != c.ok {
			t.Errorf("%s: visible %v, want %v", c.name, ok, c.ok)
			continue
		}
		if !ok {
			continue
		}
		if got.Op != c.wantOp || got.Path != c.wantPath || got.Content != c.wantBlobOK || (got.PrevPath == nil) != (c.wantPrev == nil) || (got.PrevPath != nil && *got.PrevPath != *c.wantPrev) {
			t.Errorf("%s: got %+v (prev %v)", c.name, got, got.PrevPath)
		}
	}

	doc := NewScope(uuid.New(), ResourceFile, nil, &id)
	if _, ok := doc.Project(id, "move", "B/Report.md", sp("A/Report.md")); ok {
		t.Error("a document moving between folders keeps its name in the mount: invisible")
	}
	if got, ok := doc.Project(id, "move", "A/Final.md", sp("A/Report.md")); !ok || got.Path != "Final.md" || *got.PrevPath != "Report.md" {
		t.Errorf("document rename: %+v %v", got, ok)
	}
	if _, ok := doc.Project(uuid.New(), "modify", "A/Report.md", nil); ok {
		t.Error("another file is outside a document share")
	}
}

func TestContainsScope(t *testing.T) {
	fid, other := uuid.New(), uuid.New()
	vault := NewScope(uuid.New(), ResourceVault, nil, nil)
	folder := folderScope("Progetti/Alfa")
	doc := NewScope(uuid.New(), ResourceFile, nil, &fid)
	cases := []struct {
		name   string
		outer  *Scope
		typ    string
		prefix string
		file   uuid.UUID
		path   string
		want   bool
	}{
		{"vault holds the vault", vault, ResourceVault, "", uuid.Nil, "", true},
		{"vault holds a folder", vault, ResourceFolder, "Any/Where", uuid.Nil, "", true},
		{"vault holds a document", vault, ResourceFile, "", fid, "x.md", true},
		{"folder holds itself", folder, ResourceFolder, "Progetti/Alfa", uuid.Nil, "", true},
		{"folder holds itself, other case", folder, ResourceFolder, "progetti/ALFA", uuid.Nil, "", true},
		{"folder holds a subfolder", folder, ResourceFolder, "Progetti/Alfa/Sub", uuid.Nil, "", true},
		{"folder holds a document below", folder, ResourceFile, "", fid, "Progetti/Alfa/Sub/x.md", true},
		{"folder refuses a sibling with the same letters", folder, ResourceFolder, "Progetti/Alfabeto", uuid.Nil, "", false},
		{"folder refuses its parent", folder, ResourceFolder, "Progetti", uuid.Nil, "", false},
		{"folder refuses the vault", folder, ResourceVault, "", uuid.Nil, "", false},
		{"folder refuses a document outside", folder, ResourceFile, "", fid, "Progetti/Beta/x.md", false},
		{"folder refuses a document without a path", folder, ResourceFile, "", fid, "", false},
		{"document holds itself", doc, ResourceFile, "", fid, "a/x.md", true},
		{"document refuses another document", doc, ResourceFile, "", other, "a/x.md", false},
		{"document refuses a folder", doc, ResourceFolder, "a", uuid.Nil, "", false},
		{"document refuses the vault", doc, ResourceVault, "", uuid.Nil, "", false},
	}
	for _, c := range cases {
		if got := c.outer.ContainsScope(c.typ, c.prefix, c.file, c.path); got != c.want {
			t.Errorf("%s: got %v", c.name, got)
		}
	}
}
