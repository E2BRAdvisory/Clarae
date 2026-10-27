package access

import (
	"testing"

	"github.com/google/uuid"

	"memobrain/services/cloud/internal/db/dbgen"
)

func folderScope(prefix string) *Scope {
	return NewScope(dbgen.Share{ID: uuid.New(), ResourceType: ResourceFolder, PathPrefix: &prefix})
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
	v := NewScope(dbgen.Share{ID: uuid.New(), ResourceType: ResourceVault})
	if !v.ContainsPath("any/where.md") || v.Rel("a/b.md") != "a/b.md" {
		t.Error("a vault share covers everything unchanged")
	}
	fid := uuid.New()
	f := NewScope(dbgen.Share{ID: uuid.New(), ResourceType: ResourceFile, FileID: &fid})
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
