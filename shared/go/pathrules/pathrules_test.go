package pathrules

import (
	"errors"
	"strings"
	"testing"
)

func TestNormalizePortable(t *testing.T) {
	for _, bad := range []string{
		"COM0.md", "lpt0.txt", "COM\u00b9.md", "lpt\u00b2.md", "Notes/LPT\u00b3", "CONIN$.md", "conout$",
		"NUL .md", "CON  .txt", "aux.tar.gz", "Notes/com1 .md/x.md", "PRN",
	} {
		if _, err := NormalizePortable(bad); err == nil || !errors.Is(err, ErrInvalid) || !strings.Contains(err.Error(), "reserved") {
			t.Errorf("NormalizePortable(%q) = %v, want reserved", bad, err)
		}
	}
	for _, ok := range []string{"COM10.md", "CONTRACT.md", "NUL-file.md", "LPT.md", "COM\u2074.md", "Notes/console$.md", " CON.md", "CONIN.md"} {
		if got, err := NormalizePortable(ok); err != nil || got != ok {
			t.Errorf("NormalizePortable(%q) = %q, %v", ok, got, err)
		}
	}
	if _, err := NormalizePortable("a:b.md"); err == nil {
		t.Error("NormalizePortable must apply the Normalize rules too")
	}
	// Normalize keeps its original set: files already in a vault stay visible.
	for _, legacy := range []string{"COM0.md", "COM\u00b9.md", "CONIN$.md", "NUL .md"} {
		if _, err := Normalize(legacy); err != nil {
			t.Errorf("Normalize(%q) must stay accepted: %v", legacy, err)
		}
	}
}

func TestNormalize(t *testing.T) {
	long := strings.Repeat("a", 256)
	tests := []struct {
		name    string
		in      string
		want    string
		wantErr string // substring of the error reason, "" when valid
	}{
		{"simple", "Notes/today.md", "Notes/today.md", ""},
		{"root file", "README.md", "README.md", ""},
		{"nfd to nfc", "caffé.md", "caffé.md", ""},
		{"unicode ok", "Progetti/Relazione finale ✓.md", "Progetti/Relazione finale ✓.md", ""},
		{"dotfile ok", ".clarae/editor.json", ".clarae/editor.json", ""},
		{"empty", "", "", "empty"},
		{"absolute", "/Notes/a.md", "", "absolute"},
		{"trailing slash", "Notes/", "", "empty segment"},
		{"double slash", "Notes//a.md", "", "empty segment"},
		{"dot segment", "Notes/./a.md", "", "relative segment"},
		{"dotdot segment", "../a.md", "", "relative segment"},
		{"backslash", "Notes\\a.md", "", "forbidden"},
		{"colon", "a:b.md", "", "forbidden"},
		{"star", "a*.md", "", "forbidden"},
		{"question", "a?.md", "", "forbidden"},
		{"quote", "a\".md", "", "forbidden"},
		{"angle", "<a>.md", "", "forbidden"},
		{"pipe", "a|b.md", "", "forbidden"},
		{"nul", "a\x00b.md", "", "control"},
		{"control", "a\tb.md", "", "control"},
		{"trailing dot", "Notes/a.", "", "ends with"},
		{"trailing space", "Notes/a ", "", "ends with"},
		{"reserved con", "CON", "", "reserved"},
		{"reserved con ext", "Notes/con.md", "", "reserved"},
		{"reserved lpt1", "lpt1.txt", "", "reserved"},
		{"not reserved", "CONTRACT.md", "CONTRACT.md", ""},
		{"not reserved com10", "COM10.md", "COM10.md", ""},
		{"segment too long", long + ".md", "", "segment longer"},
		{"path too long", strings.Repeat("abcdefghi/", 103), "", "longer than 1024"},
		{"invalid utf8", "a\xffb.md", "", "UTF-8"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, err := Normalize(tt.in)
			if tt.wantErr == "" {
				if err != nil {
					t.Fatalf("unexpected error: %v", err)
				}
				if got != tt.want {
					t.Fatalf("got %q, want %q", got, tt.want)
				}
				return
			}
			if err == nil {
				t.Fatalf("expected error containing %q, got path %q", tt.wantErr, got)
			}
			if !errors.Is(err, ErrInvalid) {
				t.Fatalf("error does not wrap ErrInvalid: %v", err)
			}
			if !strings.Contains(err.Error(), tt.wantErr) {
				t.Fatalf("error %q does not contain %q", err.Error(), tt.wantErr)
			}
		})
	}
}

func TestKey(t *testing.T) {
	tests := []struct {
		a, b string
		same bool
	}{
		{"Notes/Today.md", "notes/today.md", true},
		{"Straße.md", "STRASSE.md", true},
		{"caffé.md", "CAFFÉ.md", true},
		{"Notes/a.md", "Notes/b.md", false},
	}
	for _, tt := range tests {
		if got := Key(tt.a) == Key(tt.b); got != tt.same {
			t.Errorf("Key(%q)==Key(%q): got %v, want %v", tt.a, tt.b, got, tt.same)
		}
	}
}

func TestSplitExt(t *testing.T) {
	tests := []struct{ in, dir, base, ext string }{
		{"a.md", "", "a.md", ".md"},
		{"Notes/a.MD", "Notes", "a.MD", ".md"},
		{"Notes/sub/drawing.excalidraw", "Notes/sub", "drawing.excalidraw", ".excalidraw"},
		{".gitignore", "", ".gitignore", ""},
		{"Notes/archive.tar.gz", "Notes", "archive.tar.gz", ".gz"},
		{"Notes/noext", "Notes", "noext", ""},
	}
	for _, tt := range tests {
		dir, base := Split(tt.in)
		if dir != tt.dir || base != tt.base {
			t.Errorf("Split(%q) = %q,%q want %q,%q", tt.in, dir, base, tt.dir, tt.base)
		}
		if ext := Ext(tt.in); ext != tt.ext {
			t.Errorf("Ext(%q) = %q want %q", tt.in, ext, tt.ext)
		}
	}
}

func TestHasPrefixRebase(t *testing.T) {
	if !HasPrefix("Progetti/Alfa/a.md", "Progetti/Alfa") {
		t.Error("expected prefix match")
	}
	if !HasPrefix("Progetti/Alfa", "Progetti/Alfa") {
		t.Error("expected equal path to match")
	}
	if HasPrefix("Progetti/Alfa2/a.md", "Progetti/Alfa") {
		t.Error("sibling folder must not match")
	}
	if !HasPrefix("anything", "") {
		t.Error("empty prefix is the root")
	}

	tests := []struct {
		path, from, to string
		want           string
		ok             bool
	}{
		{"Progetti/Alfa/a.md", "Progetti/Alfa", "Archivio/Alfa", "Archivio/Alfa/a.md", true},
		{"Progetti/Alfa", "Progetti/Alfa", "Archivio/Alfa", "Archivio/Alfa", true},
		{"Progetti/Alfa/sub/a.md", "Progetti/Alfa", "", "sub/a.md", true},
		{"Progetti/Alfa", "Progetti/Alfa", "", "", true},
		{"a.md", "", "Mount", "Mount/a.md", true},
		{"Altro/a.md", "Progetti/Alfa", "X", "", false},
	}
	for _, tt := range tests {
		got, ok := Rebase(tt.path, tt.from, tt.to)
		if ok != tt.ok || got != tt.want {
			t.Errorf("Rebase(%q,%q,%q) = %q,%v want %q,%v", tt.path, tt.from, tt.to, got, ok, tt.want, tt.ok)
		}
	}
}

func TestIsExcluded(t *testing.T) {
	tests := []struct {
		path  string
		trash bool
		want  bool
	}{
		{"Notes/a.md", false, false},
		{".DS_Store", false, true},
		{"Notes/.DS_Store", false, true},
		{"Notes/Thumbs.db", false, true},
		{"Notes/draft.TMP", false, true},
		{".trash/a.md", false, false},
		{".trash/a.md", true, true},
		{".trash", true, true},
		{".clarae/editor.json", false, false},
		{".clarae/appearance.json", false, false},
		{".clarae/hotkeys.json", false, false},
		{".clarae/types.json", false, false},
		{".clarae/excalidraw-library.json", false, false},
		{".clarae/templates/daily.md", false, false},
		{".clarae/workspace.json", false, true},
		{".clarae/workspaces.json", false, true},
		{".clarae/workspace-mobile.json", false, true},
		{".clarae/index.db", false, true},
		{".clarae/sync.db", false, true},
		{".clarae/sync.db-wal", false, true},
		{".clarae/cache/drawings/abc.svg", false, true},
		{".clarae/snapshots/2026/a.md", false, true},
		{".clarae/cache", false, true},
		{"Notes/.clarae/cache/x", false, false}, // only the vault-root .clarae is special
	}
	for _, tt := range tests {
		if got := IsExcluded(tt.path, tt.trash); got != tt.want {
			t.Errorf("IsExcluded(%q, trash=%v) = %v want %v", tt.path, tt.trash, got, tt.want)
		}
	}
}

func TestIsExecutable(t *testing.T) {
	for path, want := range map[string]bool{
		"setup.exe":          true,
		"Tools/run.SH":       true,
		"x/Deploy.command":   true,
		"a/Link.lnk":         true,
		"report.pdf":         false,
		"archive.zip":        false,
		"deck.pptx":          false,
		"Makefile":           false,
		".bashrc":            false,
		"notes/exe":          false,
		"notes/setup.exe.md": false,
	} {
		if got := IsExecutable(path); got != want {
			t.Errorf("IsExecutable(%q) = %v want %v", path, got, want)
		}
	}
}
