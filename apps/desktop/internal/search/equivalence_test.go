package search

import (
	"context"
	"database/sql"
	"fmt"
	"math/rand/v2"
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	"github.com/rs/zerolog"

	"memobrain/apps/desktop/internal/indexer"
	"memobrain/apps/desktop/internal/store"
	"memobrain/apps/desktop/internal/vault"
)

// legacyQuery is the pre-M7 evaluation strategy, kept as the reference for the
// equivalence test: candidates listed with `path IN (FTS)`, then one statement
// per file for the body, tags and so on, each on a fresh connection acquisition.
func legacyQuery(ctx context.Context, db *sql.DB, q string, opts Options) (Results, error) {
	node, err := Parse(q)
	if err != nil {
		return Results{}, err
	}
	if opts.Limit <= 0 {
		opts.Limit = 100
	}
	res := Results{Hits: []Hit{}, Explain: []string{node.String()}}
	if and, ok := node.(And); ok && len(and.Items) == 0 {
		return res, nil
	}
	query := `SELECT path, title, kind, mtime_ns FROM files`
	var args []any
	if req := requiredTerms(node); len(req) > 0 {
		clauses := make([]string, len(req))
		for i, t := range req {
			clauses[i] = `path IN (SELECT path FROM fts_content WHERE fts_content MATCH ?)`
			args = append(args, `"`+strings.ReplaceAll(t, `"`, `""`)+`"`)
		}
		query += ` WHERE ` + strings.Join(clauses, " AND ") //nolint:gosec // constant fragments, as in the engine
	}
	query += ` ORDER BY path`
	rows, err := db.QueryContext(ctx, query, args...)
	if err != nil {
		return Results{}, err
	}
	var cands []fileMeta
	for rows.Next() {
		var m fileMeta
		if err := rows.Scan(&m.path, &m.title, &m.kind, &m.mtime); err != nil {
			return Results{}, err
		}
		cands = append(cands, m)
	}
	_ = rows.Close()
	var hits []found
	for _, c := range cands {
		f := &fileCtx{db: db, meta: c}
		ok, err := eval(ctx, node, f)
		if err != nil {
			return Results{}, err
		}
		if !ok {
			continue
		}
		hits = append(hits, f.result())
	}
	// Ranking, sorting and highlighting are shared: this reference covers the evaluation strategy.
	return New(db).finish(ctx, node, hits, opts, res)
}

// TestQueryEquivalentToLegacy compares the streaming engine with the reference
// strategy on random queries over a random vault: identical hits, order,
// snippets, scores and totals, for every sort and a small limit.
func TestQueryEquivalentToLegacy(t *testing.T) {
	ctx := context.Background()
	root := t.TempDir()
	fsys, _ := vault.NewFS(root)
	db, err := store.Open(ctx, filepath.Join(root, ".memobrain", "index.db"), store.KindIndex)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = db.Close() }()
	rng := rand.New(rand.NewPCG(11, 13)) //nolint:gosec // deterministic test data
	words := strings.Fields("alpha beta gamma Delta epsilon project Budget review meeting notes plan risk task idea journal café Ünïcode ÇA")
	tags := []string{"t1", "t2", "finance", "plan/q4"}
	const n = 100
	for i := 0; i < n; i++ {
		var sb strings.Builder
		fmt.Fprintf(&sb, "---\nstatus: %s\namount: %d\ntags: [%s]\n---\n# Note %d\n\n", []string{"active", "done"}[rng.IntN(2)], rng.IntN(300), tags[rng.IntN(len(tags))], i)
		for l := 0; l < 3+rng.IntN(9); l++ {
			for w := 0; w < 3+rng.IntN(10); w++ {
				sb.WriteString(words[rng.IntN(len(words))])
				sb.WriteByte(' ')
			}
			switch rng.IntN(6) {
			case 0:
				sb.WriteString("- [ ] " + words[rng.IntN(len(words))])
			case 1:
				fmt.Fprintf(&sb, "[[Note %d]] #%s", rng.IntN(n), tags[rng.IntN(len(tags))])
			}
			sb.WriteByte('\n')
			if rng.IntN(4) == 0 {
				sb.WriteByte('\n')
			}
		}
		title := fmt.Sprintf("%s note %d", words[rng.IntN(len(words))], i)
		if _, err := fsys.WriteFile(fmt.Sprintf("f%d/%s.md", i%5, title), []byte(sb.String()), "", false); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := fsys.WriteFile("img/logo.png", []byte("PNG"), "", false); err != nil {
		t.Fatal(err)
	}
	if err := indexer.New(fsys, db, zerolog.Nop(), nil).Full(ctx); err != nil {
		t.Fatal(err)
	}

	atoms := []string{"budget", "review", "ALPHA", "café", "ünïcode", "ça", "zzz", `"project plan"`, "pla", "tag:finance", "tag:plan", "[status:active]", "[amount:<100]",
		"file:note", "path:f1", "line:(risk task)", "task:idea", "task-todo:plan", "block:(alpha beta)", "section:(meeting)", `/\bnote \d+7\b/`, `match-case:Delta`, "-idea", "-tag:t1"}
	rnd := func() string {
		k := 1 + rng.IntN(3)
		parts := make([]string, k)
		for i := range parts {
			parts[i] = atoms[rng.IntN(len(atoms))]
		}
		switch rng.IntN(4) {
		case 0:
			return strings.Join(parts, " OR ")
		case 1:
			return "(" + strings.Join(parts, " OR ") + ") " + atoms[rng.IntN(len(atoms))]
		}
		return strings.Join(parts, " ")
	}
	cached, streaming := New(db), New(db)
	streaming.c = &cache{} // a private cache that is switched off: the SQL streaming path
	streaming.c.budget.Store(0)
	compared := 0
	compare := func(rounds int) {
		t.Helper()
		for i := 0; i < rounds; i++ {
			q := rnd()
			for _, opts := range []Options{{}, {Sort: "name", Limit: 7}, {Sort: "modified"}} {
				want, werr := legacyQuery(ctx, db, q, opts)
				for name, e := range map[string]*Engine{"cached": cached, "streaming": streaming} {
					got, gerr := e.Query(ctx, q, opts)
					if (werr == nil) != (gerr == nil) {
						t.Fatalf("%s %q: error mismatch: legacy %v, new %v", name, q, werr, gerr)
					}
					if werr != nil {
						continue
					}
					w := want
					if w.Hits == nil {
						w.Hits = []Hit{} // the old code returned a nil slice for "no hits", the new one an empty one
					}
					if !reflect.DeepEqual(w, got) {
						t.Fatalf("%s %q (%+v): results differ\nlegacy: %+v\nnew:    %+v", name, q, opts, w, got)
					}
					compared += got.Total
				}
			}
		}
	}
	compare(40)

	// The cache refreshes incrementally: edit, add and delete notes, then compare again.
	ix := indexer.New(fsys, db, zerolog.Nop(), nil)
	for i := 0; i < 6; i++ {
		p := fmt.Sprintf("f%d/mutated %d.md", i%5, i)
		if _, err := fsys.WriteFile(p, []byte(fmt.Sprintf("---\ntags: [t1]\n---\nbudget review ALPHA %d #finance\n", i)), "", false); err != nil {
			t.Fatal(err)
		}
	}
	if err := ix.Update(ctx, []string{"f0/mutated 0.md", "f1/mutated 1.md", "f2/mutated 2.md", "f3/mutated 3.md", "f4/mutated 4.md", "f0/mutated 5.md"}); err != nil {
		t.Fatal(err)
	}
	if err := fsys.Delete("f0/mutated 5.md"); err != nil {
		t.Fatal(err)
	}
	if err := ix.Update(ctx, []string{"f0/mutated 5.md"}); err != nil {
		t.Fatal(err)
	}
	compare(20)
	if compared == 0 {
		t.Fatal("random queries matched nothing: the test is vacuous")
	}
}
