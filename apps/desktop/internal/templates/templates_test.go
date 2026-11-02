package templates

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"memobrain/apps/desktop/internal/vault"
)

var now = time.Date(2026, time.March, 5, 14, 7, 9, 0, time.UTC)

func TestFormatDate(t *testing.T) {
	cases := map[string]string{
		"YYYY-MM-DD":         "2026-03-05",
		"YYYYMMDDHHmm":       "202603051407",
		"dddd, MMMM Do YYYY": "Thursday, March 5th 2026",
		"ddd D/M/YY":         "Thu 5/3/26",
		"hh:mm A":            "02:07 PM",
		"h:m:s a":            "2:7:9 pm",
		"[Week] Q — [YYYY]":  "Week 1 — YYYY",
		"YYYY/MM/YYYY-MM-DD": "2026/03/2026-03-05",
		"Z ZZ":               "+00:00 +0000",
		"è YYYY":             "è 2026",
	}
	for layout, want := range cases {
		if got := FormatDate(now, layout, "en"); got != want {
			t.Errorf("FormatDate(%q) = %q, want %q", layout, got, want)
		}
	}
	if got := FormatDate(now, "dddd D MMMM", "it"); got != "giovedì 5 marzo" {
		t.Errorf("italian = %q", got)
	}
	if got := FormatDate(now, "MMMM", "xx"); got != "March" {
		t.Errorf("unknown language should fall back to English, got %q", got)
	}
	if got := FormatDate(now.Add(-14*time.Hour), "hh a", "en"); got != "12 am" {
		t.Errorf("midnight in 12h = %q", got)
	}
	for layout, want := range map[string]string{
		"[YYYY":        "[2026",
		"[[x] [YYYY":   "[x [2026",
		"é\xffYYYY":    "é�2026",
		"YYYY\xe2\x82": "2026��",
	} {
		if got := FormatDate(now, layout, "en"); got != want {
			t.Errorf("FormatDate(%q) = %q, want %q", layout, got, want)
		}
	}
}

// tokenize is linear: a long literal layout (a template of a shared library can carry one) costs
// no allocation per character, and an unclosed '[' does not rescan the rest of the layout.
func TestTokenizeIsLinear(t *testing.T) {
	literal := strings.Repeat("é", 20000)
	allocs := testing.AllocsPerRun(5, func() { _ = tokenize(literal) })
	if allocs > 100 {
		t.Fatalf("tokenize allocated %.0f times for a %d-rune literal", allocs, 20000)
	}
	if parts := tokenize(literal); len(parts) != 1 || parts[0].literal != literal {
		t.Fatalf("literal not kept: %d parts", len(parts))
	}
	brackets := strings.Repeat("[", 1<<20)
	done := make(chan []part, 1)
	go func() { done <- tokenize(brackets) }()
	select {
	case parts := <-done:
		if len(parts) != 1 || parts[0].literal != brackets {
			t.Fatalf("unclosed brackets not kept: %d parts", len(parts))
		}
	case <-time.After(10 * time.Second):
		t.Fatal("tokenize is quadratic on unclosed '['")
	}
}

func TestExpand(t *testing.T) {
	o := ExpandOptions{Now: now, Title: "My note", Lang: "en"}
	cases := map[string]string{
		"{{date}}":                     "2026-03-05",
		"{{date:DD/MM/YYYY}}":          "05/03/2026",
		"{{ date : YYYY }}":            "2026",
		"{{time}}":                     "14:07",
		"{{time:HH:mm:ss}}":            "14:07:09",
		"# {{title}}":                  "# My note",
		"{{unknown}} {{title:x}}":      "{{unknown}} {{title:x}}",
		"{{DATE}}":                     "{{DATE}}",
		"{{date}} and {{date:dddd}}":   "2026-03-05 and Thursday",
		"no variables {single} braces": "no variables {single} braces",
		"{{date}}{{time}}{{title}}":    "2026-03-0514:07My note",
		"{{date:[Q]Q}} {{ title }}":    "Q1 My note",
	}
	for in, want := range cases {
		if got := Expand(in, o); got != want {
			t.Errorf("Expand(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestParseDate(t *testing.T) {
	loc := time.UTC
	good := []struct{ s, layout, want string }{
		{"2026-03-05", "YYYY-MM-DD", "2026-03-05"},
		{"2026/03/2026-03-05", "YYYY/MM/YYYY-MM-DD", "2026-03-05"},
		{"Thursday, March 5th 2026", "dddd, MMMM Do YYYY", "2026-03-05"},
		{"5-3-26", "D-M-YY", "2026-03-05"},
		{"giovedì 5 marzo 2026", "dddd D MMMM YYYY", "2026-03-05"},
	}
	for _, c := range good {
		lang := "en"
		if c.s[0] == 'g' {
			lang = "it"
		}
		got, ok := ParseDate(c.s, c.layout, lang, loc)
		if !ok || got.Format("2006-01-02") != c.want {
			t.Errorf("ParseDate(%q, %q) = %v %v", c.s, c.layout, got, ok)
		}
	}
	bad := [][2]string{{"2026-02-31", "YYYY-MM-DD"}, {"hello", "YYYY-MM-DD"}, {"2026-03-05x", "YYYY-MM-DD"}, {"2026-03-05", "YYYY-MM-DD HH"}, {"2026-13-01", "YYYY-MM-DD"}}
	for _, c := range bad {
		if got, ok := ParseDate(c[0], c[1], "en", loc); ok {
			t.Errorf("ParseDate(%q, %q) = %v, want failure", c[0], c[1], got)
		}
	}
}

func TestDailyPaths(t *testing.T) {
	if got := DailyPath("Daily", "YYYY-MM-DD", "en", now); got != "Daily/2026-03-05.md" {
		t.Errorf("DailyPath = %q", got)
	}
	if got := DailyPath("", "", "en", now); got != "2026-03-05.md" {
		t.Errorf("default DailyPath = %q", got)
	}
	if got := AdjacentDay("Daily/2026-03-05.md", "Daily", "YYYY-MM-DD", "en", 1, time.UTC); got != "2026-03-06" {
		t.Errorf("next = %q", got)
	}
	if got := AdjacentDay("Daily/2026-03-01.md", "Daily", "YYYY-MM-DD", "en", -1, time.UTC); got != "2026-02-28" {
		t.Errorf("previous across month = %q", got)
	}
	if got := AdjacentDay("Other/2026-03-05.md", "Daily", "YYYY-MM-DD", "en", 1, time.UTC); got != "" {
		t.Errorf("a note outside the folder is not daily, got %q", got)
	}
	if got := AdjacentDay("Daily/readme.md", "Daily", "YYYY-MM-DD", "en", 1, time.UTC); got != "" {
		t.Errorf("a non-date note is not daily, got %q", got)
	}
}

func TestUniquePath(t *testing.T) {
	taken := map[string]bool{"Z/202603051407.md": true, "Z/202603051407 2.md": true}
	got := UniquePath("Z", "", "en", now, func(p string) bool { return taken[p] })
	if got != "Z/202603051407 3.md" {
		t.Errorf("UniquePath = %q", got)
	}
	if got := UniquePath("", "YYYY-MM-DD HHmm", "en", now, func(string) bool { return false }); got != "2026-03-05 1407.md" {
		t.Errorf("custom format = %q", got)
	}
}

func TestList(t *testing.T) {
	root := t.TempDir()
	write := func(rel string) {
		abs := filepath.Join(root, filepath.FromSlash(rel))
		if err := os.MkdirAll(filepath.Dir(abs), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(abs, []byte("x"), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	write("Templates/Meeting.md")
	write("Templates/sub/Book.md")
	write("Templates/image.png")
	write("Other/Note.md")
	fsys, err := vault.NewFS(root)
	if err != nil {
		t.Fatal(err)
	}
	got, err := List(fsys, "", SourceVault, false)
	if err != nil || len(got) != 2 || got[0].Path != "Templates/Meeting.md" || got[1].Name != "Book" && got[1].Path != "Templates/sub/Book.md" {
		t.Fatalf("List = %+v, %v", got, err)
	}
	if got[0].Ref != "Templates/Meeting.md" {
		t.Errorf("vault ref = %q", got[0].Ref)
	}
	all, _ := List(fsys, "", SourceLibrary, true)
	if len(all) != 3 || all[0].Ref != "library:Other/Note.md" {
		t.Fatalf("library list = %+v", all)
	}
	none, err := List(fsys, "Missing", SourceVault, false)
	if err != nil || len(none) != 0 {
		t.Fatalf("missing folder = %+v, %v", none, err)
	}
	if s, p := ParseRef("library:A/B.md"); s != SourceLibrary || p != "A/B.md" {
		t.Errorf("ParseRef = %q %q", s, p)
	}
}
