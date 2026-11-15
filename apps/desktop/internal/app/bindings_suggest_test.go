//go:build !js

package app

import (
	"context"
	"os"
	"path/filepath"
	"testing"
)

// The quick switcher (kind "all") finds the applications and the other files the app opens in a tab,
// and says what each one is; the completion of a wikilink (kind "notes") stays on notes.
func TestSuggestAllFindsApplicationsButNotesDoNot(t *testing.T) {
	a, info, root := newWVApp(t)
	for p, c := range map[string]string{
		"Road trip.md":             "# Trip\n",
		"Apps/Road status.webapp":  `{"version":1,"url":"https://status.example.com/"}`,
		"Boards/Road board.canvas": `{"nodes":[],"edges":[]}`,
		"Road.txt":                 "plain",
	} {
		abs := filepath.Join(root, filepath.FromSlash(p))
		if err := os.MkdirAll(filepath.Dir(abs), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(abs, []byte(c), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	ov, err := a.vault(info.ID)
	if err != nil {
		t.Fatal(err)
	}
	if err := ov.Indexer.Full(context.Background()); err != nil {
		t.Fatal(err)
	}
	api := NewLinksAPI(a)

	all, err := api.Suggest(info.ID, "all", "road", "", 30)
	if err != nil {
		t.Fatal(err)
	}
	got := map[string]string{}
	for _, s := range all {
		got[s.Path] = s.Kind + "|" + s.Label
	}
	want := map[string]string{
		"Road trip.md":             "note|Road trip",
		"Apps/Road status.webapp":  "webapp|Road status",
		"Boards/Road board.canvas": "canvas|Road board",
	}
	if len(got) != len(want) {
		t.Fatalf("all: %v, want %v", got, want)
	}
	for p, w := range want {
		if got[p] != w {
			t.Errorf("all %s: %q, want %q", p, got[p], w)
		}
	}

	notes, err := api.Suggest(info.ID, "notes", "road", "", 30)
	if err != nil || len(notes) != 1 || notes[0].Path != "Road trip.md" {
		t.Fatalf("notes: %+v %v", notes, err)
	}
}
