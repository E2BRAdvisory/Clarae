package bases

import (
	"context"
	"errors"
	"fmt"
	"runtime/debug"
	"strings"
	"testing"
	"unicode/utf8"
)

// evalErr evaluates src on n and returns the evaluation error (nil when it succeeds).
func evalErr(t *testing.T, env *Env, src string) error {
	t.Helper()
	e, err := ParseExpr(src)
	if err != nil {
		t.Fatalf("parse %q: %v", src, err)
	}
	_, err = env.Eval(e)
	return err
}

func TestParseNestingIsBounded(t *testing.T) {
	// With a small stack an unbounded recursive descent would be a fatal
	// (unrecoverable) stack overflow instead of an error.
	defer debug.SetMaxStack(debug.SetMaxStack(8 << 20))
	for _, src := range []string{
		strings.Repeat("(", 100_000) + "1",
		strings.Repeat("(", 100_000) + "1" + strings.Repeat(")", 100_000),
	} {
		if _, err := ParseExpr(src); err == nil || !strings.Contains(err.Error(), "too long") {
			t.Errorf("100k parentheses: %v", err)
		}
	}
	for name, src := range map[string]string{
		"parentheses": strings.Repeat("(", 200) + "1" + strings.Repeat(")", 200),
		"lists":       strings.Repeat("[", 200) + "1" + strings.Repeat("]", 200),
		"index":       strings.Repeat("a[", 200) + "1" + strings.Repeat("]", 200),
		"calls":       strings.Repeat("max(", 200) + "1" + strings.Repeat(")", 200),
		"unary":       strings.Repeat("!", 200) + "true",
	} {
		if _, err := ParseExpr(src); err == nil || !strings.Contains(err.Error(), "nested too deeply") {
			t.Errorf("%s: %v", name, err)
		}
	}
	if got := evalOn(t, mkNote("a.md", nil), strings.Repeat("(", 100)+"1"+strings.Repeat(")", 100)); got != 1.0 {
		t.Errorf("100 parentheses = %v", got)
	}
	// A shared .base with such a formula or filter loads with a notice.
	b, err := Parse([]byte("formulas:\n  deep: '" + strings.Repeat("(", 100_000) + "1'\nfilters: '" + strings.Repeat("(", 300) + "1'\n"))
	if err != nil {
		t.Fatal(err)
	}
	if b.Formulas["deep"].Err == "" || b.Filters.Err == "" || len(b.Notices) != 2 {
		t.Errorf("formula %+v, filter %+v, notices %v", b.Formulas["deep"], b.Filters, b.Notices)
	}
}

// explosiveBase doubles a text through cached formulas and builds large values
// out of small expressions; "many" keeps 30 copies of an 800 KB text.
var explosiveBase = fmt.Sprintf(`formulas:
  f0: '"x".repeat(100000)'
  f1: formula.f0 + formula.f0
  f2: formula.f1 + formula.f1
  f3: formula.f2 + formula.f2
  f4: formula.f3 + formula.f3
  boom: '"a".repeat(1000).replace("", "b".repeat(2000))'
  join: '"a".repeat(1000).split("").map(formula.f0).join("")'
  many: '%s'
  ok: '"fine"'
views:
  - type: table
    name: T
    order: [file.name, formula.f3, formula.f4, formula.boom, formula.join, formula.many, formula.ok]
`, "["+strings.TrimSuffix(strings.Repeat(`formula.f3 + "x", `, 30), ", ")+"].length")

func TestMemoryBudgetMakesCellErrors(t *testing.T) {
	b, err := Parse([]byte(explosiveBase))
	if err != nil {
		t.Fatal(err)
	}
	res, err := b.Run([]*Note{mkNote("a.md", nil), mkNote("b.md", nil)}, 0, RunOptions{Now: testNow})
	if err != nil {
		t.Fatal(err)
	}
	for _, r := range res.Rows {
		c := r.Cells
		if c[1].K != KindText || len(c[1].V.(string)) != 800_000 {
			t.Errorf("f3 (800 KB) must be computed: %s %q", c[1].K, c[1].E)
		}
		for i, want := range map[int]string{2: "too large", 3: "too large", 4: "too large", 5: "too much memory"} {
			if c[i].K != KindError || !strings.Contains(c[i].E, want) {
				t.Errorf("%s: cell %d = %+v, want an error with %q", r.Path, i, c[i], want)
			}
		}
		if c[6].V != "fine" {
			t.Errorf("ok cell: %+v", c[6])
		}
	}

	n := mkNote("a.md", nil)
	for src, want := range map[string]string{
		`"abc".repeat(6148914691236517206)`:                                                               "out of range", // n*len(s) wraps around
		`"a".repeat(100000).split("").map(value).length`:                                                  "too long",
		`"ab".repeat(10000).split("").join("b".repeat(1000))`:                                             "too large",
		`concat("x".repeat(100000), "x".repeat(100000)).repeat(10)`:                                       "out of range",
		`[[1, 2], [3]].concat([4]).flat().length + "x".repeat(100000).replace("x", "yyyyyyyyyyy").length`: "too large",
	} {
		if err := evalErr(t, NewEnv(n, nil, testNow, nil), src); err == nil || !strings.Contains(err.Error(), want) {
			t.Errorf("%s: %v, want an error with %q", src, err, want)
		}
	}
}

func TestSharedTextsArePaidOnOutput(t *testing.T) {
	// 30,000 references to one 800 KB text cost little to build, but would be
	// 24 GB once encoded for the UI: the cell and the group key are errors.
	b, err := Parse([]byte(`formulas:
  f0: '"x".repeat(100000)'
  f1: formula.f0 + formula.f0
  f2: formula.f1 + formula.f1
  f3: formula.f2 + formula.f2
  wide: '"a".repeat(30000).split("").map(formula.f3)'
  ok: '"fine"'
views:
  - type: table
    name: T
    order: [file.name, formula.wide, formula.ok]
  - type: table
    name: G
    groupBy:
      property: formula.wide
      direction: ASC
    order: [file.name]
`))
	if err != nil {
		t.Fatal(err)
	}
	res, err := b.Run([]*Note{mkNote("a.md", nil)}, 0, RunOptions{Now: testNow})
	if err != nil {
		t.Fatal(err)
	}
	if c := res.Rows[0].Cells; c[1].K != KindError || !strings.Contains(c[1].E, "too large") || c[2].V != "fine" {
		t.Errorf("cells: %s %q, %+v", c[1].K, c[1].E, c[2])
	}
	res, err = b.Run([]*Note{mkNote("a.md", nil)}, 1, RunOptions{Now: testNow})
	if err != nil {
		t.Fatal(err)
	}
	if len(res.Groups) != 1 || res.Groups[0].Key.K != KindError {
		t.Errorf("groups: %+v", res.Groups)
	}
}

func TestErrorsDoNotQuoteLongTexts(t *testing.T) {
	n := mkNote("a.md", nil)
	for _, src := range []string{
		`date("é".repeat(50000))`,
		`duration("x".repeat(100000))`,
		`number("x".repeat(100000))`,
		`formula["x".repeat(100000)]`,
	} {
		err := evalErr(t, NewEnv(n, nil, testNow, nil), src)
		if err == nil || len(err.Error()) > maxErrorLen+len("…") || !utf8.ValidString(err.Error()) {
			t.Errorf("%.20s…: %d bytes", src, len(fmt.Sprint(err)))
		}
	}
}

func TestRepeatCount(t *testing.T) {
	n := mkNote("a.md", nil)
	for src, want := range map[string]any{
		`"ab".repeat(2.9)`:           "abab",
		`"".repeat(number("1e300"))`: "",
		`"x".repeat(100000).length`:  100_000.0,
	} {
		if got := evalOn(t, n, src); got != want {
			t.Errorf("%s = %v, want %v", src, got, want)
		}
	}
	for _, src := range []string{`"x".repeat(100001)`, `"x".repeat(-1)`, `"x".repeat(number("1e300"))`} {
		if err := evalErr(t, NewEnv(n, nil, testNow, nil), src); err == nil || !strings.Contains(err.Error(), "out of range") {
			t.Errorf("%s: %v", src, err)
		}
	}
}

func TestStepBudget(t *testing.T) {
	n := mkNote("a.md", nil)
	// Plain values use a set: 30,000 items cost a few steps each.
	if got := evalOn(t, n, `"a".repeat(30000).split("").map(index).unique().length`); got != 30_000.0 {
		t.Errorf("unique of numbers = %v", got)
	}
	// Lists compare item by item, one step per comparison: quadratic, and charged.
	if err := evalErr(t, NewEnv(n, nil, testNow, nil), `"a".repeat(3000).split("").map([index]).unique().length`); err == nil || !strings.Contains(err.Error(), "too expensive") {
		t.Errorf("unique of 3000 lists: %v", err)
	}

	// Objects, dates and links are never deduplicated by identity alone:
	// unique keeps Equal's semantics.
	for src, want := range map[string]any{
		`[file, file].unique().length`:                                 2.0,
		`[1, 1, "1", null, null, true, true].unique().length`:          4.0,
		`["2026-01-01", date("2026-01-01"), "x", "x"].unique().length`: 2.0,
	} {
		if got := evalOn(t, n, src); got != want {
			t.Errorf("%s = %v, want %v", src, got, want)
		}
	}

	// The budget is shared by every row and formula of a Run.
	saved := maxRunSteps
	maxRunSteps = 50_000
	defer func() { maxRunSteps = saved }()
	b, err := Parse([]byte("formulas:\n  heavy: '\"a\".repeat(5000).split(\"\").map(index).length'\nviews:\n  - type: table\n    name: T\n    order: [file.name, formula.heavy]\n"))
	if err != nil {
		t.Fatal(err)
	}
	var notes []*Note
	for _, p := range []string{"a.md", "b.md", "c.md", "d.md", "e.md", "f.md", "g.md", "h.md", "i.md", "j.md", "k.md", "l.md"} {
		notes = append(notes, mkNote(p, nil))
	}
	res, err := b.Run(notes, 0, RunOptions{Now: testNow})
	if err != nil {
		t.Fatal(err)
	}
	first, last := res.Rows[0].Cells[1], res.Rows[len(res.Rows)-1].Cells[1]
	if first.V != 5000.0 || last.K != KindError || !strings.Contains(last.E, "too expensive") {
		t.Errorf("first %+v, last %+v", first, last)
	}
	if !strings.Contains(strings.Join(res.Notices, "\n"), "too expensive") {
		t.Errorf("notices: %v", res.Notices)
	}
}

func TestSortingRowsIsBounded(t *testing.T) {
	mkRows := func() []*rowCtx {
		var rows []*rowCtx
		for i := 300; i > 0; i-- {
			n := mkNote(fmt.Sprintf("n%03d.md", i), map[string]any{"k": float64(i)})
			rows = append(rows, &rowCtx{note: n, env: NewEnv(n, nil, testNow, nil)})
		}
		return rows
	}
	sorted := func(rows []*rowCtx) bool {
		for i := 1; i < len(rows); i++ {
			if SortCompare(rows[i-1].keys[0], rows[i].keys[0]) > 0 {
				return false
			}
		}
		return true
	}
	v := View{Sort: []SortSpec{{Property: "k", Direction: "ASC"}}}
	b := &Base{}

	rows := mkRows()
	b.sortRows(rows, v, newRunBudget(context.Background(), nil))
	if !sorted(rows) {
		t.Fatal("rows are not sorted")
	}

	// Past the run's budget, or once cancelled, comparisons stop.
	saved := maxRunSteps
	maxRunSteps = 100
	budget := newRunBudget(context.Background(), nil)
	rows = mkRows()
	b.sortRows(rows, v, budget)
	maxRunSteps = saved
	if sorted(rows) || !budget.exhausted {
		t.Errorf("exhausted budget: sorted %v, exhausted %v", sorted(rows), budget.exhausted)
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	budget = newRunBudget(ctx, nil)
	budget.steps = ctxCheckSteps - 1
	rows = mkRows()
	b.sortRows(rows, v, budget)
	if sorted(rows) || budget.cancelled == nil {
		t.Errorf("cancelled run: sorted %v, cancelled %v", sorted(rows), budget.cancelled)
	}
}

func TestRunStopsWhenCancelled(t *testing.T) {
	b, err := Parse([]byte(sampleBase))
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := b.RunContext(ctx, sampleNotes(), 0, RunOptions{Now: testNow}); !errors.Is(err, context.Canceled) {
		t.Fatalf("cancelled run: %v", err)
	}
	// An evaluation in progress notices the cancellation too.
	env := NewEnv(mkNote("a.md", nil), nil, testNow, nil)
	env.run = newRunBudget(ctx, nil)
	if err := evalErr(t, env, `"a".repeat(10000).split("").map(index).length`); err == nil || !strings.Contains(err.Error(), "cancelled") {
		t.Errorf("evaluation: %v", err)
	}
}

func TestPanicsBecomeErrors(t *testing.T) {
	// A note without data makes file.name dereference nil: a runtime panic.
	var pe *PanicError
	if err := evalErr(t, NewEnv(nil, nil, testNow, nil), "file.name"); !errors.As(err, &pe) {
		t.Errorf("Eval: %v", err)
	}

	// In a cell: an error for that cell, reported once to the log.
	b, err := Parse([]byte("views:\n  - type: table\n    name: T\n    order: [file.name, formula.bug, formula.ok]\n"))
	if err != nil {
		t.Fatal(err)
	}
	b.Formulas["bug"] = &Formula{Name: "bug", Expr: (*member)(nil)}
	b.Formulas["ok"] = &Formula{Name: "ok", Expr: numLit(1)}
	var logged []error
	opts := RunOptions{Now: testNow, OnPanic: func(err error) { logged = append(logged, err) }}
	res, err := b.Run([]*Note{mkNote("a.md", nil), mkNote("b.md", nil)}, 0, opts)
	if err != nil {
		t.Fatal(err)
	}
	for _, r := range res.Rows {
		if r.Cells[1].K != KindError || !strings.Contains(r.Cells[1].E, "internal error") || r.Cells[2].V != 1.0 {
			t.Errorf("%s: %+v", r.Path, r.Cells)
		}
	}
	if len(logged) != 1 {
		t.Errorf("logged %d panics, want 1", len(logged))
	}

	// Outside an evaluation: the whole run fails with an error.
	logged = nil
	if _, err := b.Run([]*Note{nil}, 0, opts); !errors.As(err, &pe) || len(logged) != 1 {
		t.Errorf("Run: %v (logged %d)", err, len(logged))
	}
	// Still one report when a cell failed before the run did.
	logged = nil
	b.Views[0].Order = []string{"formula.bug", "file.name"}
	if _, err := b.Run([]*Note{nil}, 0, opts); !errors.As(err, &pe) || len(logged) != 1 {
		t.Errorf("Run after a cell: %v (logged %d)", err, len(logged))
	}
}

func TestTitleKeepsMultibyteInitials(t *testing.T) {
	n := mkNote("a.md", map[string]any{"s": "élan vital, àncora ÒMERO"})
	if got := evalOn(t, n, `"élan".title()`); got != "Élan" {
		t.Errorf("title = %q", got)
	}
	if got := evalOn(t, n, `s.title()`); got != "Élan Vital, Àncora Òmero" {
		t.Errorf("title = %q", got)
	}
}
