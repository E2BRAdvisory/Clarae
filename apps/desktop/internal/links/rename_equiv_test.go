package links_test

import (
	"context"
	"fmt"
	"math/rand/v2"
	"os"
	"path"
	"path/filepath"
	"reflect"
	"sort"
	"strings"
	"testing"

	"github.com/rs/zerolog"

	"clarae/apps/desktop/internal/indexer"
	"clarae/apps/desktop/internal/links"
	"clarae/apps/desktop/internal/store"
	"clarae/apps/desktop/internal/vault"
)

// A generated vault full of ambiguity: duplicate base names, names that
// differ only in case, aliases equal to other notes' names, relative and
// path-qualified targets, escaped Markdown links, attachments, ghost links
// (some of which a rename makes resolvable), property links, drawings and
// canvases with file nodes.
var (
	eqFolders = []string{"", "A", "A/B", "C", "D/E"}
	eqNames   = []string{"Alpha", "alpha", "Beta", "Gamma", "My Note", "Index", "Delta", "Odd.md"}
	eqAliases = []string{"Alpha", "beta", "Shared", "My Note", "Zeta", "Omega"}
	eqTargets = []string{
		"Alpha", "ALPHA", "Beta", "Gamma", "Zeta", "Omega", "Shared", "My Note", "Index", "Delta", "Odd.md",
		"Alpha.md", "A/Alpha", "A/B/Beta", "B/Beta", "C/Gamma", "/Alpha", "./Alpha", "../Alpha", "../A/Beta",
		"./B/Gamma", "img.png", "A/img.png", "Ghost", "Renamed", "New Name", "A/Delta",
	}
	eqRenames = []string{"Renamed", "New Name", "Alpha", "Beta", "Ghost", "Zeta", "Delta"}
)

type eqVault struct {
	t    *testing.T
	ctx  context.Context
	fsys *vault.FS
	ix   *indexer.Indexer
	rng  *rand.Rand
}

func (v *eqVault) pick(list []string) string { return list[v.rng.IntN(len(list))] }

func (v *eqVault) files() []string {
	var out []string
	if err := v.fsys.Walk(func(e vault.Entry) error {
		if !e.IsDir {
			out = append(out, e.Path)
		}
		return nil
	}); err != nil {
		v.t.Fatal(err)
	}
	return out
}

func (v *eqVault) free(p string) bool {
	if _, err := os.Lstat(filepath.Join(v.fsys.Root(), filepath.FromSlash(p))); err == nil {
		return false
	}
	lp := strings.ToLower(p)
	for _, f := range v.files() {
		lf := strings.ToLower(f)
		if lf == lp || strings.HasPrefix(lf, lp+"/") || strings.HasPrefix(lp, lf+"/") {
			return false
		}
	}
	return true
}

func (v *eqVault) link() string {
	target := v.pick(eqTargets)
	switch v.rng.IntN(4) {
	case 0:
		return fmt.Sprintf("[text](%s)", strings.ReplaceAll(target, " ", "%20"))
	case 1:
		return fmt.Sprintf("![[%s]]", target)
	case 2:
		return fmt.Sprintf("[[%s#Part|shown]]", target)
	}
	return fmt.Sprintf("[[%s]]", target)
}

func (v *eqVault) note() string {
	var sb strings.Builder
	switch v.rng.IntN(4) {
	case 0:
		fmt.Fprintf(&sb, "---\naliases: [%q]\n---\n", v.pick(eqAliases))
	case 1: // property links: rewritten, not indexed as links
		fmt.Fprintf(&sb, "---\naliases: [%q]\nrelated: \"[[%s]]\"\nup:\n  - \"[[%s|up]]\"\n---\n", v.pick(eqAliases), v.pick(eqTargets), v.pick(eqTargets))
	}
	for i, n := 0, 1+v.rng.IntN(5); i < n; i++ {
		fmt.Fprintf(&sb, "Line %d %s.\n", i, v.link())
	}
	return sb.String()
}

func (v *eqVault) drawing() string {
	t1 := strings.Trim(v.link(), "!")
	if strings.HasPrefix(t1, "[text]") {
		t1 = "[[Alpha]]"
	}
	// The code span is not a link for the index, but the rename rewrites every
	// [[link]] of the JSON (scanDrawingLinks): drawings are always read.
	return fmt.Sprintf(`{"type":"excalidraw","elements":[{"id":"a","type":"text","text":"see %s"},{"id":"b","type":"rectangle","link":"[[%s]]"},{"id":"c","type":"text","text":"code `+"`[[%s]]`"+`"}]}`,
		t1, v.pick(eqTargets), v.pick(eqTargets))
}

// canvas shows an existing file (or a missing one) and links from a text node.
func (v *eqVault) canvas() string {
	file := "Ghost.md"
	if files := v.files(); len(files) > 0 && v.rng.IntN(4) != 0 {
		file = v.pick(files)
	}
	return fmt.Sprintf(`{"nodes":[{"id":"f","type":"file","file":%q,"x":0,"y":0,"width":10,"height":10},`+
		`{"id":"t","type":"text","text":"see [[%s]]","x":20,"y":0,"width":10,"height":10}],"edges":[]}`, file, v.pick(eqTargets))
}

func (v *eqVault) create() {
	for {
		dir := v.pick(eqFolders)
		name := v.pick(eqNames) + ".md"
		body := v.note()
		switch v.rng.IntN(8) {
		case 0:
			name, body = "img.png", "PNG"
		case 1:
			name, body = v.pick(eqNames)+".excalidraw", v.drawing()
		case 2:
			name, body = v.pick(eqNames)+".canvas", v.canvas()
		}
		p := path.Join(dir, name)
		if !v.free(p) {
			continue
		}
		if _, err := v.fsys.WriteFile(p, []byte(body), "", false); err != nil {
			v.t.Fatal(err)
		}
		return
	}
}

// rename picks a random file or folder and a free destination.
func (v *eqVault) rename() (string, string, bool) {
	files := v.files()
	if v.rng.IntN(3) == 0 {
		dirs := map[string]bool{}
		for _, f := range files {
			for d := path.Dir(f); d != "."; d = path.Dir(d) {
				dirs[d] = true
			}
		}
		var list []string
		for d := range dirs {
			list = append(list, d)
		}
		sort.Strings(list)
		if len(list) == 0 {
			return "", "", false
		}
		from := v.pick(list)
		to := path.Join(v.pick(eqFolders), v.pick(eqRenames))
		if to == from || strings.HasPrefix(to, from+"/") || !v.free(to) {
			return "", "", false
		}
		return from, to, true
	}
	from := v.pick(files)
	to := path.Join(v.pick(eqFolders), v.pick(eqRenames)+path.Ext(from))
	if to == from || !v.free(to) {
		return "", "", false
	}
	return from, to, true
}

// The candidate-based PlanRename must produce exactly the plan of the
// whole-vault scan, for many random renames of files and folders. Each plan is
// applied so the vault keeps changing.
func TestPlanRenameCandidatesMatchFullScan(t *testing.T) {
	ctx := context.Background()
	compared, edits := 0, 0
	for seed := uint64(1); seed <= 8; seed++ {
		root := t.TempDir()
		fsys, err := vault.NewFS(root)
		if err != nil {
			t.Fatal(err)
		}
		db, err := store.Open(ctx, filepath.Join(root, ".clarae", "index.db"), store.KindIndex)
		if err != nil {
			t.Fatal(err)
		}
		v := &eqVault{t: t, ctx: ctx, fsys: fsys, ix: indexer.New(fsys, db, zerolog.Nop(), nil), rng: rand.New(rand.NewPCG(seed, 7))} //nolint:gosec // deterministic test data
		for i := 0; i < 30; i++ {
			v.create()
		}
		if err := v.ix.Full(ctx); err != nil {
			t.Fatal(err)
		}
		for i := 0; i < 40; i++ {
			from, to, ok := v.rename()
			if !ok {
				continue
			}
			got, err := links.PlanRename(ctx, db, fsys, from, to)
			if err != nil {
				t.Fatal(err)
			}
			want, err := links.PlanRenameFull(ctx, db, fsys, from, to)
			if err != nil {
				t.Fatal(err)
			}
			if !reflect.DeepEqual(got, want) {
				t.Fatalf("seed %d, rename %s -> %s:\ncandidates %+v\nfull scan  %+v", seed, from, to, got, want)
			}
			compared++
			edits += len(want.Files)
			if err := links.ApplyRename(fsys, got); err != nil {
				t.Fatal(err)
			}
			touched := []string{got.From, got.To}
			for _, f := range got.Files {
				touched = append(touched, f.Path)
			}
			if err := v.ix.Update(ctx, touched); err != nil {
				t.Fatal(err)
			}
			if v.rng.IntN(4) == 0 {
				v.create() // indexed only by the next Update: stale for the planner meanwhile
			}
		}
		_ = db.Close()
	}
	if compared < 150 || edits < 100 {
		t.Fatalf("only %d renames compared (%d file edits): the generator is too weak", compared, edits)
	}
	t.Logf("%d renames compared, %d file edits", compared, edits)
}

// A note edited on disk after it was indexed (the watcher has not caught up)
// is still read: its new link to the renamed note is rewritten.
func TestPlanRenameReadsNotesChangedSinceIndexing(t *testing.T) {
	ctx := context.Background()
	root := t.TempDir()
	fsys, err := vault.NewFS(root)
	if err != nil {
		t.Fatal(err)
	}
	db, err := store.Open(ctx, filepath.Join(root, ".clarae", "index.db"), store.KindIndex)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = db.Close() }()
	for p, c := range map[string]string{"Target.md": "# Target\n", "Other.md": "Nothing here yet.\n"} {
		if _, err := fsys.WriteFile(p, []byte(c), "", false); err != nil {
			t.Fatal(err)
		}
	}
	if err := indexer.New(fsys, db, zerolog.Nop(), nil).Full(ctx); err != nil {
		t.Fatal(err)
	}
	if _, err := fsys.WriteFile("Other.md", []byte("Now see [[Target]] and more text.\n"), "", false); err != nil {
		t.Fatal(err)
	}
	plan, err := links.PlanRename(ctx, db, fsys, "Target.md", "Sub/Renamed.md")
	if err != nil {
		t.Fatal(err)
	}
	if len(plan.Files) != 1 || plan.Files[0].Path != "Other.md" || plan.Files[0].Edits[0].New != "Renamed" {
		t.Fatalf("plan %+v: the unindexed edit of Other.md was not rewritten", plan)
	}
}
