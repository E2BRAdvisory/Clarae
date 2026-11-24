//go:build integration

package sync_test

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// M31 (ADR-0068): the templates of a vault are notes, drawings and presentations kept in the
// templates folder of its configuration folder. They sync with the settings, but the files are not
// JSON settings: two devices that edit one are merged by what the file holds, with no conflict copy.

// templateFiles lists what the templates folder of a device holds (paths relative to it).
func templateFiles(t *testing.T, d *device) []string {
	t.Helper()
	root := filepath.Join(d.dir, ".clarae", "templates")
	var out []string
	err := filepath.WalkDir(root, func(p string, de os.DirEntry, err error) error {
		if err != nil || de.IsDir() {
			return err
		}
		rel, _ := filepath.Rel(root, p)
		out = append(out, filepath.ToSlash(rel))
		return nil
	})
	if err != nil {
		t.Fatalf("%s: %v", d.name, err)
	}
	return out
}

func TestTemplatesMergeByContent(t *testing.T) {
	v := createVault(t, "ada", "templates")
	a := newDevice(t, "ada", "laptop", v, nil)
	b := newDevice(t, "ada", "desktop", v, nil)
	const (
		note  = ".clarae/templates/Daily.md"
		deck  = ".clarae/templates/Talk.marp"
		board = ".clarae/templates/Work/Board.excalidraw"
	)
	text := "line 1\nline 2\nline 3\nline 4\nline 5\n"
	a.write(note, text)
	a.write(deck, text)
	a.write(board, drawing(el("e1", 1, 0), el("e2", 1, 100)))
	a.sync()
	b.sync()
	for _, p := range []string{note, deck, board} {
		if !b.exists(p) {
			t.Fatalf("%s did not sync", p)
		}
	}

	// Each device edits another part of each template.
	for _, p := range []string{note, deck} {
		a.write(p, strings.Replace(text, "line 1", "line 1 on the laptop", 1))
		b.write(p, strings.Replace(text, "line 5", "line 5 on the desktop", 1))
	}
	a.write(board, drawing(el("e1", 2, 10), el("e2", 1, 100)))
	b.write(board, drawing(el("e1", 1, 0), el("e2", 1, 100), el("e3", 1, 200)))
	a.sync()
	b.sync() // pulls the laptop's versions, merges, pushes the results
	a.sync()

	merged := "line 1 on the laptop\nline 2\nline 3\nline 4\nline 5 on the desktop\n"
	wantEls := map[string]int{"e1": 2, "e2": 1, "e3": 1}
	for _, d := range []*device{a, b} {
		for _, p := range []string{note, deck} {
			if got := d.read(p); got != merged {
				t.Errorf("%s: %s = %q", d.name, p, got)
			}
		}
		if got := elementsOf(t, d.read(board)); fmt.Sprint(got) != fmt.Sprint(wantEls) {
			t.Errorf("%s: elements %v, want %v", d.name, got, wantEls)
		}
		if got := strings.Join(templateFiles(t, d), ","); got != "Daily.md,Talk.marp,Work/Board.excalidraw" {
			t.Errorf("%s: a merge by content leaves no conflict copy: %s", d.name, got)
		}
	}
	if len(a.conflicts)+len(b.conflicts) != 0 {
		t.Errorf("no conflict expected: %v %v", a.conflicts, b.conflicts)
	}
}

// Moving a template from the folder of the vault it was in up to 1.8 into the templates folder is a
// move of the same file: its id, and so its history on the server, stay.
func TestTemplateMovedIntoTheTemplatesFolderIsTheSameFile(t *testing.T) {
	v := createVault(t, "ada", "templates-move")
	a := newDevice(t, "ada", "laptop", v, nil)
	b := newDevice(t, "ada", "desktop", v, nil)
	const from, to = "Templates/Daily.md", ".clarae/templates/Daily.md"
	a.write(from, "# {{title}}\n")
	a.write("Templates/logo.png", "png")
	a.sync()
	b.sync()
	id := a.fileID(from)
	if b.fileID(from) != id {
		t.Fatal("the two devices disagree on the file")
	}

	a.rename(from, to)
	a.sync()
	b.sync()
	for _, d := range []*device{a, b} {
		if d.exists(from) || !d.exists(to) {
			t.Fatalf("%s: old %v, new %v", d.name, d.exists(from), d.exists(to))
		}
		if got := d.fileID(to); got != id {
			t.Errorf("%s: the template became another file: %s, was %s", d.name, got, id)
		}
		if got := d.read(to); got != "# {{title}}\n" {
			t.Errorf("%s: content %q", d.name, got)
		}
		if !d.exists("Templates/logo.png") {
			t.Errorf("%s: a file that did not move is gone", d.name)
		}
	}
	// It is a template for the merge from now on, on both devices.
	a.write(to, "# {{title}}\n\nby the laptop\n")
	a.sync()
	b.sync()
	if got := b.read(to); got != "# {{title}}\n\nby the laptop\n" {
		t.Errorf("an edit after the move did not sync: %q", got)
	}
}

// The configuration folder of a mount is a folder of the share: the sync addresses every path of a
// mount relative to the root of the share, so what an editor writes there reaches the owner (and
// every other recipient) as ordinary content of the shared folder, a note where it is a note. This
// is why TemplatesAPI.Create and the migration refuse a mount (internal/app/bindings_templates.go):
// a template created there would not be the user's own. A test that fails here means the mounts
// keep their settings to themselves now, and that refusal can be reconsidered.
func TestSettingsFolderOfAMountIsContentOfTheShare(t *testing.T) {
	vaultID := createVault(t, "ada", "mount-templates")
	owner := newDevice(t, "ada", "ada-laptop", vaultID, nil)
	owner.write("Docs/plan.md", "plan")
	owner.sync()
	share := shareFolder(t, "ada", vaultID, "Docs", userGrant(t, "bob", "editor"))
	bob := mountDevice(t, "bob", "bob-laptop", mountOf(t, "bob", share))
	bob.sync()
	if !bob.exists("plan.md") {
		t.Fatal("the mount did not sync")
	}

	bob.write(".clarae/templates/Mine.md", "a template of bob")
	bob.sync()
	owner.sync()
	const leaked = "Docs/.clarae/templates/Mine.md"
	if !owner.exists(leaked) {
		t.Fatalf("the template of a mount did not reach the owner's shared folder: the mounts keep their settings to themselves, see the comment")
	}
	if got := owner.read(leaked); got != "a template of bob" {
		t.Errorf("content %q", got)
	}
}
