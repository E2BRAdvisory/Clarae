package bases

import (
	"context"
	"fmt"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"clarae/apps/desktop/internal/store"
)

var testNow = time.Date(2026, 3, 15, 10, 30, 0, 0, time.Local)

func mkNote(path string, props map[string]any, tags ...string) *Note {
	n := &Note{Path: path, Hash: "h-" + path, Size: int64(len(path)) * 100, MTime: testNow.Add(-48 * time.Hour), CTime: testNow.Add(-72 * time.Hour)}
	for _, t := range tags {
		n.Tags = append(n.Tags, "#"+t)
	}
	for _, k := range sortedKeys(props) {
		v := FromJSON(props[k], "")
		n.Props = append(n.Props, PropEntry{Key: k, Kind: KindOf(v), Value: v})
	}
	n.Prepare()
	return n
}

func evalOn(t *testing.T, n *Note, src string) any {
	t.Helper()
	e, err := ParseExpr(src)
	if err != nil {
		t.Fatalf("parse %q: %v", src, err)
	}
	v, err := NewEnv(n, nil, testNow, nil).Eval(e)
	if err != nil {
		t.Fatalf("eval %q: %v", src, err)
	}
	return v
}

func TestExpressions(t *testing.T) {
	n := mkNote("Projects/Alpha.md", map[string]any{
		"price": 10.0, "qty": 3.0, "status": "Open", "due": "2026-03-20",
		"tags2": []any{"a", "b", "a"}, "nums": []any{1.0, 2.0, 3.0}, "done": false,
	}, "work", "work/deep")
	cases := []struct {
		src  string
		want any
	}{
		{"price * qty + 1", 31.0},
		{"(price + 2) / 4", 3.0},
		{"10 % 4", 2.0},
		{"-price", -10.0},
		{"price > 5 && qty < 5", true},
		{"price > 50 || done", false},
		{"!done", true},
		{`status == "Open"`, true},
		{`status != 'Open'`, false},
		{`concat(status, "-", qty)`, "Open-3"},
		{`status + " item"`, "Open item"},
		{`status.lower()`, "open"},
		{`status.upper().length`, 4.0},
		{`status.contains("pe")`, true},
		{`status.startsWith("Op") && status.endsWith("en")`, true},
		{`"a,b,c".split(",").join("|")`, "a|b|c"},
		{`"hello".replace("l", "L")`, "heLLo"},
		{`if(price > 5, "big", "small")`, "big"},
		{`if(false, 1)`, nil},
		{`nums.sum()`, 6.0},
		{`nums.map(value * 2).sum()`, 12.0},
		{`nums.filter(value > 1).length`, 2.0},
		{`tags2.unique().length`, 2.0},
		{`tags2.contains("b")`, true},
		{`tags2.join("+")`, "a+b+a"},
		{`nums[1]`, 2.0},
		{`file.name`, "Alpha.md"},
		{`file.basename`, "Alpha"},
		{`file.folder`, "Projects"},
		{`file.ext`, "md"},
		{`file.hasTag("work")`, true},
		{`file.hasTag("#work/deep")`, true},
		{`file.hasTag("nope")`, false},
		{`file.inFolder("Projects")`, true},
		{`file.inFolder("Proj")`, false},
		{`note.price + price`, 20.0},
		{`missing.length`, nil},
		{`missing + 1`, nil},
		{`due.format("DD/MM/YYYY")`, "20/03/2026"},
		{`(due - today()).days`, 5.0},
		{`(today() + "1d").format("YYYY-MM-DD")`, "2026-03-16"},
		{`(now() - "2h").hour`, 8.0},
		{`due > today()`, true},
		{`date("2026-01-01").year`, 2026.0},
		{`price.round(1)`, 10.0},
		{`min(3, 1, 2)`, 1.0},
		{`(2.567).round(2)`, 2.57},
		{`status.isEmpty()`, false},
		{`missing.isEmpty()`, true},
	}
	for _, c := range cases {
		got := evalOn(t, n, c.src)
		if gf, ok := got.(float64); ok {
			if wf, ok := c.want.(float64); !ok || (gf-wf > 1e-9 || wf-gf > 1e-9) {
				t.Errorf("%s = %v, want %v", c.src, got, c.want)
			}
			continue
		}
		if fmt.Sprint(got) != fmt.Sprint(c.want) {
			t.Errorf("%s = %v, want %v", c.src, got, c.want)
		}
	}
}

func TestExpressionErrors(t *testing.T) {
	for _, src := range []string{"price +", "(1", `"abc`, "1 $ 2", ""} {
		if _, err := ParseExpr(src); err == nil {
			t.Errorf("%q should not parse", src)
		}
	}
	n := mkNote("a.md", map[string]any{"s": "x"})
	for _, src := range []string{"1 / 0", "s - 1", "nope()", "s.nomethod()", "-s"} {
		e, err := ParseExpr(src)
		if err != nil {
			t.Fatalf("%q: %v", src, err)
		}
		if _, err := NewEnv(n, nil, testNow, nil).Eval(e); err == nil {
			t.Errorf("%q should fail at runtime", src)
		}
	}
}

const sampleBase = `# my bases
filters:
  and:
    - file.ext == "md"
    - 'file.inFolder("Projects")'
formulas:
  total: price * qty
  late: 'if(due < today(), "late", "ok")'
  bad: price +
  loop: formula.loop + 1
properties:
  status:
    displayName: State
  formula.total:
    displayName: Total
views:
  - type: table
    name: All
    order:
      - file.name
      - status
      - price
      - formula.total
      - formula.late
      - formula.bad
      - formula.loop
    sort:
      - property: price
        direction: DESC
    summaries:
      price: Sum
      formula.total: Average
  - type: cards
    name: By status
    groupBy:
      property: status
      direction: ASC
    order: [file.name]
    limit: 3
  - type: map
    name: Geo
  - type: table
    name: Weird
    filters:
      or:
        - status == "Open"
        - 'status ==== "x"'
`

func sampleNotes() []*Note {
	return []*Note{
		mkNote("Projects/A.md", map[string]any{"status": "Open", "price": 10.0, "qty": 2.0, "due": "2026-03-01"}),
		mkNote("Projects/B.md", map[string]any{"status": "Done", "price": 30.0, "qty": 1.0, "due": "2026-04-01"}),
		mkNote("Projects/C.md", map[string]any{"status": "Open", "price": 20.0, "qty": 4.0}),
		mkNote("Projects/D.md", map[string]any{"status": "Open"}),
		mkNote("Other/E.md", map[string]any{"status": "Open", "price": 99.0}),
		mkNote("Projects/pic.png", nil),
	}
}

func TestRunTable(t *testing.T) {
	b, err := Parse([]byte(sampleBase))
	if err != nil {
		t.Fatal(err)
	}
	if len(b.Views) != 4 {
		t.Fatalf("views = %d", len(b.Views))
	}
	res, err := b.Run(sampleNotes(), 0, RunOptions{Now: testNow, Schema: map[string]string{"price": "number"}})
	if err != nil {
		t.Fatal(err)
	}
	var paths []string
	for _, r := range res.Rows {
		paths = append(paths, r.Path)
	}
	// price DESC, nulls last; Other/ and the png are filtered out.
	if got := strings.Join(paths, ","); got != "Projects/B.md,Projects/C.md,Projects/A.md,Projects/D.md" {
		t.Fatalf("rows = %s", got)
	}
	cols := map[string]Column{}
	idx := map[string]int{}
	for i, c := range res.Columns {
		cols[c.ID] = c
		idx[c.ID] = i
	}
	if cols["status"].Name != "State" || cols["formula.total"].Name != "Total" || !cols["status"].Editable || cols["formula.total"].Editable {
		t.Errorf("columns: %+v", cols)
	}
	if cols["price"].Kind != KindNumber || cols["formula.total"].Kind != KindNumber || cols["formula.late"].Kind != KindText {
		t.Errorf("kinds: %+v", cols)
	}
	a := res.Rows[2] // A
	if a.Cells[idx["formula.total"]].V != 20.0 || a.Cells[idx["formula.late"]].V != "late" {
		t.Errorf("A cells: %+v", a.Cells)
	}
	if e := a.Cells[idx["formula.bad"]]; e.K != KindError || e.E == "" {
		t.Errorf("bad formula cell: %+v", e)
	}
	if e := a.Cells[idx["formula.loop"]]; e.K != KindError || !strings.Contains(e.E, "itself") {
		t.Errorf("loop formula cell: %+v", e)
	}
	if res.Rows[0].Cells[0].K != KindLink || res.Rows[0].Cells[0].V != "[[Projects/B.md|B]]" {
		t.Errorf("name cell: %+v", res.Rows[0].Cells[0])
	}
	if res.Summaries[idx["price"]].V != 60.0 || res.Summaries[idx["formula.total"]].V != 130.0/3.0 {
		t.Errorf("summaries: %+v", res.Summaries)
	}
	if len(res.Notices) == 0 {
		t.Error("expected notices for the bad formula and the unsupported view/filter")
	}
}

func TestRunCardsGroupLimitAndUnsupported(t *testing.T) {
	b, _ := Parse([]byte(sampleBase))
	res, err := b.Run(sampleNotes(), 1, RunOptions{Now: testNow})
	if err != nil {
		t.Fatal(err)
	}
	if res.Total != 4 || len(res.Rows) != 3 {
		t.Fatalf("total %d rows %d", res.Total, len(res.Rows))
	}
	if len(res.Groups) != 2 || res.Groups[0].Key.V != "Done" || res.Groups[0].Count != 1 || res.Groups[1].Start != 1 || res.Groups[1].Count != 2 {
		t.Errorf("groups: %+v", res.Groups)
	}
	un, err := b.Run(sampleNotes(), 2, RunOptions{})
	if err != nil || len(un.Rows) != 0 || !strings.Contains(strings.Join(un.Notices, "|"), `"map"`) {
		t.Errorf("unsupported view: %+v %v", un, err)
	}
	// An or group with an unparsable member: the broken filter is neutral, never crashes.
	weird, err := b.Run(sampleNotes(), 3, RunOptions{Now: testNow})
	if err != nil {
		t.Fatal(err)
	}
	if len(weird.Rows) == 0 {
		t.Error("weird view should still list rows")
	}
	if _, err := b.Run(nil, 9, RunOptions{}); err == nil {
		t.Error("out of range view must fail")
	}
}

func TestParseTolerant(t *testing.T) {
	for _, src := range []string{"", "views: 3\nfilters: 4\nformulas: [1]", "views:\n  - 5\n  - {type: table}\nfilters: {foo: bar}"} {
		b, err := Parse([]byte(src))
		if err != nil {
			t.Fatalf("%q: %v", src, err)
		}
		for i := range b.Views {
			if _, err := b.Run(sampleNotes(), i, RunOptions{}); err != nil {
				t.Fatal(err)
			}
		}
	}
	if _, err := Parse([]byte("a: [")); err == nil {
		t.Error("invalid YAML must error")
	}
	if _, err := Parse([]byte("- a\n- b")); err == nil {
		t.Error("a sequence is not a base")
	}
}

func TestRoundTripPreservesUnknown(t *testing.T) {
	src := `# keep this comment
unknownTop:
  nested: [1, 2]   # trailing
filters:
  and:
    - 'file.ext == "md"'
formulas:
  f: price * 2
views:
  - type: table
    name: T   # name comment
    order:
      - file.name
    customKey: {a: 1}
    sort:
      - property: file.name
        direction: ASC
  - type: map
    name: Other
    lat: x
`
	zero, limit := 0, 5
	// The view has no "filters" of its own: AddFilter creates them, RemoveFilter(0) then removes that one.
	out, err := ApplyViewPatch([]byte(src), 0, ViewPatch{
		Order:     &[]string{"file.name", "status"},
		Sort:      &[]SortSpec{{Property: "status", Direction: "desc"}},
		GroupBy:   &SortSpec{Property: "status", Direction: "ASC"},
		Limit:     &limit,
		AddFilter: `status != "done"`,
	})
	if err != nil {
		t.Fatal(err)
	}
	s := string(out)
	for _, must := range []string{"# keep this comment", "unknownTop:", "# trailing", "customKey:", "# name comment", "type: map", "lat: x", "f: price * 2", "limit: 5", `file.ext == "md"`} {
		if !strings.Contains(s, must) {
			t.Errorf("lost %q in:\n%s", must, s)
		}
	}
	b, err := Parse(out)
	if err != nil {
		t.Fatalf("reparse: %v\n%s", err, s)
	}
	v := b.Views[0]
	if len(v.Order) != 2 || v.Sort[0].Direction != "DESC" || v.GroupBy.Property != "status" || v.Limit != 5 || len(v.Filters.Chips()) != 1 {
		t.Errorf("view after patch: %+v", v)
	}
	out, err = ApplyViewPatch(out, 0, ViewPatch{RemoveFilter: &zero, ClearGroupBy: true, Sort: &[]SortSpec{}})
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(out), "groupBy") || strings.Contains(string(out), "filters:\n      and") {
		t.Errorf("clear failed:\n%s", out)
	}
	// Non-"and" roots are wrapped, never rewritten.
	out2, err := ApplyViewPatch([]byte("views:\n  - type: table\n    filters: 'a == 1'\n"), 0, ViewPatch{AddFilter: "b == 2"})
	if err != nil {
		t.Fatal(err)
	}
	b2, _ := Parse(out2)
	if c := b2.Views[0].Filters.Chips(); len(c) != 2 || c[0].Text != "a == 1" {
		t.Errorf("wrapped filters: %+v\n%s", c, out2)
	}
	if _, err := ApplyViewPatch(out2, 0, ViewPatch{AddFilter: "bad +"}); err == nil {
		t.Error("an invalid filter must be refused")
	}
	if _, err := ApplyViewPatch(out2, 5, ViewPatch{}); err == nil {
		t.Error("missing view must error")
	}
}

func TestNewBase(t *testing.T) {
	for _, folder := range []string{"", "Projects/It's \"x\""} {
		b, err := Parse(NewBase(folder))
		if err != nil || len(b.Views) != 1 || !b.Views[0].Supported {
			t.Fatalf("%q: %v %+v", folder, err, b)
		}
		res, _ := b.Run([]*Note{mkNote("Projects/It's \"x\"/n.md", nil), mkNote("z.md", nil)}, 0, RunOptions{})
		want := 2
		if folder != "" {
			want = 1
		}
		if len(res.Rows) != want {
			t.Errorf("folder %q: %d rows", folder, len(res.Rows))
		}
	}
}

func TestLoadNotesFromIndex(t *testing.T) {
	ctx := context.Background()
	db, err := store.Open(ctx, filepath.Join(t.TempDir(), "index.db"), store.KindIndex)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = db.Close() }()
	mustExec := func(q string, a ...any) {
		if _, err := db.ExecContext(ctx, q, a...); err != nil {
			t.Fatal(err)
		}
	}
	mustExec(`INSERT INTO files (path, kind, mtime_ns, size, hash, title, indexed_at) VALUES ('A/x.md','md',1000000000,5,'hh','x','now'),('.clarae/c.json','config',1,1,'h','c','now')`)
	mustExec(`INSERT INTO properties (path,key,kind,value) VALUES ('A/x.md','due','date','"2026-01-02"'),('A/x.md','n','number','4'),('A/x.md','l','list','["a","[[B]]"]')`)
	mustExec(`INSERT INTO tags (path,line,name) VALUES ('A/x.md',1,'t1'),('A/x.md',2,'t1')`)
	mustExec(`INSERT INTO links (path,line,kind,target_raw,target_resolved) VALUES ('A/x.md',1,'wikilink','B','B.md'),('A/x.md',2,'external','http://x',NULL)`)
	notes, err := LoadNotes(ctx, db)
	if err != nil || len(notes) != 1 {
		t.Fatalf("%v %d", err, len(notes))
	}
	n := notes[0]
	if len(n.Tags) != 1 || n.Tags[0] != "#t1" || len(n.Links) != 1 || n.Links[0] != "B.md" || len(n.Props) != 3 {
		t.Errorf("%+v", n)
	}
	if d, ok := n.Props[0].Value.(Date); !ok || d.HasTime {
		t.Errorf("due should be a date: %#v", n.Props[0].Value)
	}
}

func synthetic(n int) []*Note {
	statuses := []string{"Open", "Done", "Blocked", "Review"}
	notes := make([]*Note, n)
	for i := range notes {
		notes[i] = mkNote(fmt.Sprintf("Folder%d/note-%05d.md", i%50, i), map[string]any{
			"status": statuses[i%4], "priority": float64(i % 7), "due": fmt.Sprintf("2026-%02d-%02d", 1+i%12, 1+i%28),
			"rating": float64(i % 10), "owner": fmt.Sprintf("user%d", i%30),
		}, fmt.Sprintf("t%d", i%20))
	}
	return notes
}

func BenchmarkRun10kFilterSort(b *testing.B) {
	notes := synthetic(10_000)
	base, err := Parse([]byte(`views:
  - type: table
    name: T
    filters:
      and:
        - 'status == "Open" || priority > 4'
    order: [file.name, status, priority, due, rating]
    sort:
      - property: due
        direction: DESC
`))
	if err != nil {
		b.Fatal(err)
	}
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		res, err := base.Run(notes, 0, RunOptions{Now: testNow})
		if err != nil || len(res.Rows) == 0 {
			b.Fatal(err)
		}
	}
}

func BenchmarkLoadAndRun10k(b *testing.B) {
	ctx := context.Background()
	db, err := store.Open(ctx, filepath.Join(b.TempDir(), "index.db"), store.KindIndex)
	if err != nil {
		b.Fatal(err)
	}
	defer func() { _ = db.Close() }()
	tx, _ := db.BeginTx(ctx, nil)
	for i, n := range synthetic(10_000) {
		_, _ = tx.ExecContext(ctx, `INSERT INTO files (path, kind, mtime_ns, size, hash, title, indexed_at) VALUES (?,'md',?,1,'h','t','now')`, n.Path, int64(i))
		for _, p := range n.Props {
			_, _ = tx.ExecContext(ctx, `INSERT INTO properties (path,key,kind,value) VALUES (?,?,?,?)`, n.Path, p.Key, p.Kind, fmt.Sprintf("%q", Str(p.Value)))
		}
		_, _ = tx.ExecContext(ctx, `INSERT INTO tags (path,line,name) VALUES (?,1,?)`, n.Path, "t")
	}
	if err := tx.Commit(); err != nil {
		b.Fatal(err)
	}
	base, _ := Parse([]byte("views:\n  - type: table\n    name: T\n    filters:\n      and:\n        - 'status == \"Open\"'\n    order: [file.name, status, priority]\n    sort:\n      - property: priority\n        direction: DESC\n"))
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		notes, err := LoadNotes(ctx, db)
		if err != nil {
			b.Fatal(err)
		}
		if _, err := base.Run(notes, 0, RunOptions{Now: testNow}); err != nil {
			b.Fatal(err)
		}
	}
}
