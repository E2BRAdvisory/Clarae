package indexer

import (
	"context"
	"database/sql"
	"fmt"
	"math/rand/v2"
	"os"
	"path"
	"path/filepath"
	"sort"
	"strings"
	"testing"

	"github.com/rs/zerolog"

	"memobrain/apps/desktop/internal/links"
	"memobrain/apps/desktop/internal/store"
	"memobrain/apps/desktop/internal/vault"
)

// The names and targets below collide on purpose: the same base name in
// several folders, names differing only in case, aliases equal to other
// notes' names, relative and path-qualified targets, Markdown links with
// escaped spaces, attachments, ghost targets and odd extensions.
var (
	incFolders = []string{"", "A", "A/B", "C", "Café"}
	incNames   = []string{"Alpha", "alpha", "Beta", "Gamma", "My Note", "My%20Note", "Odd.md", "Index", "Café"}
	incAliases = []string{"Alpha", "beta", "Shared", "My Note", "A/Alpha", "gamma", "Zeta"}
	incTargets = []string{
		"Alpha", "alpha", "ALPHA", "Beta", "Gamma", "Zeta", "Shared", "My Note", "Index", "Café", "café",
		"Alpha.md", "ALPHA.MD", "Odd.md", "Odd.md.md", "A/Alpha", "A/B/Beta", "B/Beta", "C/Gamma", "/Alpha",
		"./Alpha", "../Alpha", "../A/Beta", "./B/Gamma", "img.png", "A/img.png", "Ghost", "A/Ghost", "x/", "",
	}
)

type incVault struct {
	t    *testing.T
	ctx  context.Context
	fsys *vault.FS
	db   *sql.DB
	ix   *Indexer
	rng  *rand.Rand
}

func (v *incVault) files() []string {
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

func (v *incVault) folders() []string {
	set := map[string]bool{}
	for _, f := range v.files() {
		for d := path.Dir(f); d != "."; d = path.Dir(d) {
			set[d] = true
		}
	}
	out := make([]string, 0, len(set))
	for d := range set {
		out = append(out, d)
	}
	sort.Strings(out)
	return out
}

// free reports whether p can be created (case-insensitive file systems
// refuse names differing only in case, files and folders cannot share a name).
func (v *incVault) free(p string) bool {
	if _, err := os.Lstat(filepath.Join(v.fsys.Root(), filepath.FromSlash(p))); err == nil {
		return false // an empty folder left behind, or the same name in another case
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

func (v *incVault) pick(list []string) string { return list[v.rng.IntN(len(list))] }

func (v *incVault) noteBody() string {
	var sb strings.Builder
	if v.rng.IntN(2) == 0 {
		sb.WriteString("---\naliases: [")
		for i, n := 0, 1+v.rng.IntN(2); i < n; i++ {
			if i > 0 {
				sb.WriteString(", ")
			}
			fmt.Fprintf(&sb, "%q", v.pick(incAliases))
		}
		sb.WriteString("]\n---\n")
	}
	sb.WriteString("# Note\n\n")
	for i, n := 0, 1+v.rng.IntN(5); i < n; i++ {
		target := v.pick(incTargets)
		switch v.rng.IntN(3) {
		case 0:
			fmt.Fprintf(&sb, "See [link](%s).\n", strings.ReplaceAll(target, " ", "%20"))
		case 1:
			fmt.Fprintf(&sb, "See ![[%s]].\n", target)
		default:
			fmt.Fprintf(&sb, "See [[%s#Heading|text]].\n", target)
		}
	}
	return sb.String()
}

func (v *incVault) newPath() string {
	for {
		dir := v.pick(incFolders)
		name := v.pick(incNames) + ".md"
		if v.rng.IntN(6) == 0 {
			name = "img.png"
		}
		p := name
		if dir != "" {
			p = dir + "/" + name
		}
		if v.free(p) {
			return p
		}
	}
}

func (v *incVault) write(p, body string) {
	v.t.Helper()
	if _, err := v.fsys.WriteFile(p, []byte(body), "", false); err != nil {
		v.t.Fatal(err)
	}
}

func (v *incVault) update(paths ...string) {
	v.t.Helper()
	if err := v.ix.Update(v.ctx, paths); err != nil {
		v.t.Fatal(err)
	}
}

// step applies one random change through Update and describes it.
func (v *incVault) step() string {
	files := v.files()
	if len(files) < 4 {
		p := v.newPath()
		v.write(p, v.noteBody())
		v.update(p)
		return "create " + p
	}
	switch v.rng.IntN(7) {
	case 0, 1: // create
		p := v.newPath()
		body := v.noteBody()
		if strings.HasSuffix(p, ".png") {
			body = "PNG"
		}
		v.write(p, body)
		v.update(p)
		return "create " + p
	case 2: // delete a file
		p := v.pick(files)
		if err := v.fsys.Delete(p); err != nil {
			v.t.Fatal(err)
		}
		v.update(p)
		return "delete " + p
	case 3: // rename or move a file
		from := v.pick(files)
		to := v.newPath()
		if strings.HasSuffix(from, ".png") != strings.HasSuffix(to, ".png") {
			to = strings.TrimSuffix(strings.TrimSuffix(to, ".md"), ".png") + path.Ext(from)
			if !v.free(to) {
				return "skip"
			}
		}
		if err := v.fsys.Rename(from, to); err != nil {
			v.t.Fatal(err)
		}
		v.update(from, to)
		return "rename " + from + " -> " + to
	case 4: // rewrite a note: other aliases and links
		var notes []string
		for _, f := range files {
			if strings.HasSuffix(f, ".md") {
				notes = append(notes, f)
			}
		}
		if len(notes) == 0 {
			return "skip"
		}
		p := v.pick(notes)
		v.write(p, v.noteBody())
		v.update(p)
		return "rewrite " + p
	case 5: // delete a folder
		dirs := v.folders()
		if len(dirs) == 0 {
			return "skip"
		}
		d := v.pick(dirs)
		if err := v.fsys.Delete(d); err != nil {
			v.t.Fatal(err)
		}
		v.update(d)
		return "delete folder " + d
	default: // rename a folder
		dirs := v.folders()
		if len(dirs) == 0 {
			return "skip"
		}
		d := v.pick(dirs)
		to := v.pick([]string{"A", "C", "D", "A/B", "E/F", "Café"})
		if to == d || strings.HasPrefix(to, d+"/") || !v.free(to) {
			return "skip"
		}
		if err := v.fsys.Rename(d, to); err != nil {
			v.t.Fatal(err)
		}
		v.update(d, to)
		return "rename folder " + d + " -> " + to
	}
}

func (v *incVault) snapshot() map[int64]string {
	rows, err := v.db.QueryContext(v.ctx, `SELECT rowid, path, target_raw, COALESCE(target_resolved, '<ghost>'), COALESCE(target_key, '<null>') FROM links WHERE kind <> 'external'`)
	if err != nil {
		v.t.Fatal(err)
	}
	defer func() { _ = rows.Close() }()
	out := map[int64]string{}
	for rows.Next() {
		var id int64
		var src, raw, res, key string
		if err := rows.Scan(&id, &src, &raw, &res, &key); err != nil {
			v.t.Fatal(err)
		}
		if key == "<null>" {
			v.t.Fatalf("link %q in %s has no target_key", raw, src)
		}
		out[id] = fmt.Sprintf("%s [[%s]] -> %s (key %q)", src, raw, res, key)
	}
	return out
}

// After every random change, the incremental resolution (Update) must leave
// exactly what a from-scratch ResolveAll computes.
func TestIncrementalResolutionMatchesResolveAll(t *testing.T) {
	ctx := context.Background()
	for seed := uint64(1); seed <= 12; seed++ {
		t.Run(fmt.Sprintf("seed%d", seed), func(t *testing.T) {
			root := t.TempDir()
			fsys, err := vault.NewFS(root)
			if err != nil {
				t.Fatal(err)
			}
			db, err := store.Open(ctx, filepath.Join(root, ".memobrain", "index.db"), store.KindIndex)
			if err != nil {
				t.Fatal(err)
			}
			defer func() { _ = db.Close() }()
			v := &incVault{t: t, ctx: ctx, fsys: fsys, db: db, ix: New(fsys, db, zerolog.Nop(), nil), rng: rand.New(rand.NewPCG(seed, 99))} //nolint:gosec // deterministic test data
			for i := 0; i < 8; i++ {
				p := v.newPath()
				v.write(p, v.noteBody())
			}
			if err := v.ix.Full(ctx); err != nil {
				t.Fatal(err)
			}
			for i := 0; i < 60; i++ {
				what := v.step()
				got := v.snapshot()
				if err := links.ResolveAll(ctx, db); err != nil {
					t.Fatal(err)
				}
				want := v.snapshot()
				for id, w := range want {
					if got[id] != w {
						t.Fatalf("step %d (%s): incremental %q, ResolveAll %q", i, what, got[id], w)
					}
				}
				if len(got) != len(want) {
					t.Fatalf("step %d (%s): %d links vs %d", i, what, len(got), len(want))
				}
			}
		})
	}
}

// The keys are what the incremental resolution relies on: rows indexed before
// the target_key column existed (NULL) are re-resolved on every change and
// filled by the next ResolveAll.
func TestResolveAllFillsMissingLinkKeys(t *testing.T) {
	ctx := context.Background()
	root := t.TempDir()
	fsys, err := vault.NewFS(root)
	if err != nil {
		t.Fatal(err)
	}
	db, err := store.Open(ctx, filepath.Join(root, ".memobrain", "index.db"), store.KindIndex)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = db.Close() }()
	if _, err := fsys.WriteFile("a.md", []byte("[[b]] [[c]]\n"), "", false); err != nil {
		t.Fatal(err)
	}
	ix := New(fsys, db, zerolog.Nop(), nil)
	if err := ix.Full(ctx); err != nil {
		t.Fatal(err)
	}
	if _, err := db.ExecContext(ctx, `UPDATE links SET target_key = NULL`); err != nil {
		t.Fatal(err)
	}
	// A new note b.md: the NULL-key link to it must still resolve.
	if _, err := fsys.WriteFile("b.md", []byte("x\n"), "", false); err != nil {
		t.Fatal(err)
	}
	if err := ix.Update(ctx, []string{"b.md"}); err != nil {
		t.Fatal(err)
	}
	var resolved string
	if err := db.QueryRowContext(ctx, `SELECT COALESCE(target_resolved, '') FROM links WHERE target_raw = 'b'`).Scan(&resolved); err != nil {
		t.Fatal(err)
	}
	if resolved != "b.md" {
		t.Fatalf("[[b]] resolved to %q after b.md appeared", resolved)
	}
	if err := links.ResolveAll(ctx, db); err != nil {
		t.Fatal(err)
	}
	var missing int
	if err := db.QueryRowContext(ctx, `SELECT count(*) FROM links WHERE target_key IS NULL`).Scan(&missing); err != nil {
		t.Fatal(err)
	}
	if missing != 0 {
		t.Fatalf("%d links without key after ResolveAll", missing)
	}
}

// A bulk pass drops the target_key index while writing and builds it again;
// a later pass creates it if it went missing (a pass that died half way).
func TestFullRestoresLinkKeyIndex(t *testing.T) {
	ctx := context.Background()
	old := bulkMinFiles
	bulkMinFiles = 1
	t.Cleanup(func() { bulkMinFiles = old })
	root := t.TempDir()
	fsys, err := vault.NewFS(root)
	if err != nil {
		t.Fatal(err)
	}
	db, err := store.Open(ctx, filepath.Join(root, ".memobrain", "index.db"), store.KindIndex)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = db.Close() }()
	for _, p := range []string{"a.md", "b.md"} {
		if _, err := fsys.WriteFile(p, []byte("[[a]] [[b]] [[ghost]]\n"), "", false); err != nil {
			t.Fatal(err)
		}
	}
	hasIndex := func() bool {
		t.Helper()
		var n int
		if err := db.QueryRowContext(ctx, `SELECT count(*) FROM sqlite_master WHERE type = 'index' AND name = 'links_key_ix'`).Scan(&n); err != nil {
			t.Fatal(err)
		}
		return n == 1
	}
	ix := New(fsys, db, zerolog.Nop(), nil)
	if err := ix.Full(ctx); err != nil {
		t.Fatal(err)
	}
	if !hasIndex() {
		t.Fatal("links_key_ix missing after a bulk pass")
	}
	var keyed int
	if err := db.QueryRowContext(ctx, `SELECT count(*) FROM links WHERE target_key = 'ghost'`).Scan(&keyed); err != nil || keyed != 2 {
		t.Fatalf("%d links keyed 'ghost' (%v), want 2", keyed, err)
	}
	if _, err := db.ExecContext(ctx, `DROP INDEX links_key_ix`); err != nil {
		t.Fatal(err)
	}
	if err := ix.Full(ctx); err != nil { // nothing changed: not a bulk pass
		t.Fatal(err)
	}
	if !hasIndex() {
		t.Fatal("links_key_ix not recreated by the next pass")
	}
}
