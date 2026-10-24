package search_test

import (
	"context"
	"path/filepath"
	"reflect"
	"sort"
	"testing"

	"github.com/rs/zerolog"

	"nodus/apps/desktop/internal/indexer"
	"nodus/apps/desktop/internal/search"
	"nodus/apps/desktop/internal/store"
	"nodus/apps/desktop/internal/vault"
)

func newEngine(t *testing.T, files map[string]string) *search.Engine {
	t.Helper()
	ctx := context.Background()
	root := t.TempDir()
	fsys, _ := vault.NewFS(root)
	db, err := store.Open(ctx, filepath.Join(root, ".nodus", "index.db"), store.KindIndex)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = db.Close() })
	for p, c := range files {
		if _, err := fsys.WriteFile(p, []byte(c), "", false); err != nil {
			t.Fatal(err)
		}
	}
	if err := indexer.New(fsys, db, zerolog.Nop(), nil).Full(ctx); err != nil {
		t.Fatal(err)
	}
	return search.New(db)
}

func paths(t *testing.T, e *search.Engine, q string) []string {
	t.Helper()
	res, err := e.Query(context.Background(), q, search.Options{Sort: "name"})
	if err != nil {
		t.Fatalf("%q: %v", q, err)
	}
	out := []string{}
	for _, h := range res.Hits {
		out = append(out, h.Path)
	}
	sort.Strings(out) // order is covered by TestSnippetAndSort
	return out
}

func TestQueryLanguage(t *testing.T) {
	e := newEngine(t, map[string]string{
		"Projects/Budget.md": "---\nstatus: active\ndue: 2026-12-01\namount: 1200\ntags: [finance]\n---\n# Budget\n\nQuarterly budget review.\n- [ ] call the bank\n- [x] send invoice\n\n## Risks\nThe rate may change.\n",
		"Projects/Plan.md":   "---\nstatus: done\ndue: 2026-03-01\namount: 90\n---\n# Plan\n\nBudget is in [[Budget]]. #planning/q4\nTODO: write the plan.\n",
		"Journal/Day1.md":    "Met Alice about the budget.\nCoffee with Bob.\n\nSeparate paragraph about plan and Alice.\n",
		"Journal/Day2.md":    "Nothing about money. Café time.\n",
		"img/logo.png":       "PNG",
	})
	tests := []struct {
		q    string
		want []string
	}{
		{"budget", []string{"Journal/Day1.md", "Projects/Budget.md", "Projects/Plan.md"}},
		{"BUDGET review", []string{"Projects/Budget.md"}},
		{`"quarterly budget"`, []string{"Projects/Budget.md"}},
		{"budget -alice", []string{"Projects/Budget.md", "Projects/Plan.md"}},
		{"alice OR bob", []string{"Journal/Day1.md"}},
		{"(plan OR review) -path:journal", []string{"Projects/Budget.md", "Projects/Plan.md"}},
		{"file:day", []string{"Journal/Day1.md", "Journal/Day2.md"}},
		{"file:.png", []string{"img/logo.png"}},
		{"path:projects", []string{"Projects/Budget.md", "Projects/Plan.md"}},
		{`path:"Projects/Plan"`, []string{"Projects/Plan.md"}},
		{"content:budget path:journal", []string{"Journal/Day1.md"}},
		{"tag:#finance", []string{"Projects/Budget.md"}},
		{"tag:planning", []string{"Projects/Plan.md"}}, // hierarchical: planning/q4
		{"line:(alice budget)", []string{"Journal/Day1.md"}},
		{"line:(alice plan)", []string{"Journal/Day1.md"}},
		{"block:(coffee bob)", []string{"Journal/Day1.md"}},
		{"block:(alice coffee)", []string{"Journal/Day1.md"}}, // consecutive lines = one block
		{"block:(bob separate)", []string{}},                  // different paragraphs
		{"section:(rate change)", []string{"Projects/Budget.md"}},
		{"section:(budget change)", []string{}}, // different sections
		{"task:bank", []string{"Projects/Budget.md"}},
		{"task-todo:bank", []string{"Projects/Budget.md"}},
		{"task-done:bank", []string{}},
		{"task-done:invoice", []string{"Projects/Budget.md"}},
		{"[status:active]", []string{"Projects/Budget.md"}},
		{"[status]", []string{"Projects/Budget.md", "Projects/Plan.md"}},
		{"[due:<2026-06-01]", []string{"Projects/Plan.md"}},
		{"[amount:>=1000]", []string{"Projects/Budget.md"}},
		{"[amount:<1000] tag:planning", []string{"Projects/Plan.md"}},
		{"/b[ou]dget/", []string{"Journal/Day1.md", "Projects/Budget.md", "Projects/Plan.md"}},
		{`/\d{4}-\d{2}/`, []string{"Projects/Budget.md", "Projects/Plan.md"}},
		{"match-case:Budget", []string{"Projects/Budget.md", "Projects/Plan.md"}}, // title "Budget" or "# Budget"/"[[Budget]]"
		{"match-case:BUDGET", []string{}},
		{"ignore-case:BUDGET path:journal", []string{"Journal/Day1.md"}},
		{"ca", []string{"Journal/Day2.md", "Projects/Budget.md"}}, // under 3 characters: scan, no FTS
		{"café", []string{"Journal/Day2.md"}},
		{"", []string{}},
	}
	for _, tt := range tests {
		got := paths(t, e, tt.q)
		if len(got) == 0 && len(tt.want) == 0 {
			continue
		}
		if !reflect.DeepEqual(got, tt.want) {
			t.Errorf("%q\n got  %v\n want %v", tt.q, got, tt.want)
		}
	}
}

func TestParseErrorsAndExplain(t *testing.T) {
	for _, bad := range []string{"(unclosed", `"unterminated`, "[prop", "file:", "/(/"} {
		if _, err := search.Parse(bad); err == nil {
			t.Errorf("%q should be a parse error", bad)
		}
	}
	ex, err := search.Explain(`(a OR b) -c tag:#x [k:v]`)
	if err != nil || len(ex) != 1 {
		t.Fatalf("explain: %v %v", ex, err)
	}
	t.Log(ex[0])
}

func TestSnippetAndSort(t *testing.T) {
	e := newEngine(t, map[string]string{
		"a.md": "nothing here\nthe quick fox\n",
		"b.md": "fox fox fox\n",
	})
	res, err := e.Query(context.Background(), "fox", search.Options{})
	if err != nil {
		t.Fatal(err)
	}
	if len(res.Hits) != 2 || res.Hits[0].Path != "b.md" || res.Hits[0].Matches < res.Hits[1].Matches {
		t.Fatalf("relevance order: %+v", res.Hits)
	}
	if res.Hits[1].Snippet != "the quick fox" || res.Hits[1].Line != 2 {
		t.Fatalf("snippet: %+v", res.Hits[1])
	}
	res, _ = e.Query(context.Background(), "fox", search.Options{Limit: 1})
	if len(res.Hits) != 1 || res.Total != 2 {
		t.Fatalf("limit: %+v", res)
	}
}
