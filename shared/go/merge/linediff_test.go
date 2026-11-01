package merge

import (
	"errors"
	"fmt"
	"math/rand/v2"
	"strings"
	"testing"
)

// lcsLen is the textbook O(N·M) longest common subsequence length.
func lcsLen(a, b []int32) int {
	prev := make([]int, len(b)+1)
	cur := make([]int, len(b)+1)
	for i := 1; i <= len(a); i++ {
		for j := 1; j <= len(b); j++ {
			switch {
			case a[i-1] == b[j-1]:
				cur[j] = prev[j-1] + 1
			case prev[j] >= cur[j-1]:
				cur[j] = prev[j]
			default:
				cur[j] = cur[j-1]
			}
		}
		prev, cur = cur, prev
	}
	return prev[len(b)]
}

// TestDiffIDsIsValidAndMinimal checks on random inputs that the spans turn a
// into b, are ordered and disjoint, and keep a longest common subsequence.
func TestDiffIDsIsValidAndMinimal(t *testing.T) {
	rng := rand.New(rand.NewPCG(3, 4)) //nolint:gosec // reproducible test data
	gen := func(n, alphabet int) []int32 {
		s := make([]int32, n)
		for i := range s {
			s[i] = int32(rng.IntN(alphabet)) //nolint:gosec // small
		}
		return s
	}
	for iter := range 20000 {
		alphabet := 1 + rng.IntN(6)
		a, b := gen(rng.IntN(14), alphabet), gen(rng.IntN(14), alphabet)
		spans, err := diffIDs(a, b)
		if err != nil {
			t.Fatal(err)
		}
		var out []int32
		pos, kept := 0, 0
		for _, s := range spans {
			if s.aStart < pos || s.aEnd < s.aStart || s.bEnd < s.bStart {
				t.Fatalf("iter %d: bad span %+v in %+v", iter, s, spans)
			}
			out = append(out, a[pos:s.aStart]...)
			kept += s.aStart - pos
			out = append(out, b[s.bStart:s.bEnd]...)
			pos = s.aEnd
		}
		out = append(out, a[pos:]...)
		kept += len(a) - pos
		if fmt.Sprint(out) != fmt.Sprint(b) {
			t.Fatalf("iter %d: a=%v b=%v spans=%+v gives %v", iter, a, b, spans, out)
		}
		if want := lcsLen(a, b); kept != want {
			t.Fatalf("iter %d: a=%v b=%v keeps %d lines, LCS is %d", iter, a, b, kept, want)
		}
	}
}

func numbered(prefix string, n int) []string {
	ls := make([]string, n)
	for i := range ls {
		ls[i] = fmt.Sprintf("%s line %d\n", prefix, i)
	}
	return ls
}

// A large file with scattered edits on both sides merges cleanly and
// identically every time: no clock-dependent timeout can turn it into a
// conflict on a slow machine.
func TestMarkdownLargeFileScatteredEdits(t *testing.T) {
	base := numbered("base", 60000)
	ours := append([]string(nil), base...)
	theirs := append([]string(nil), base...)
	for i := 100; i+500 < len(base); i += 997 {
		ours[i] = fmt.Sprintf("ours %d\n", i)
		theirs[i+500] = fmt.Sprintf("theirs %d\n", i)
	}
	b, o, th := strings.Join(base, ""), strings.Join(ours, ""), strings.Join(theirs, "")
	res := Markdown([]byte(b), []byte(o), []byte(th))
	if !res.Clean {
		t.Fatalf("want clean, got conflicts %v", res.Conflicts[:min(3, len(res.Conflicts))])
	}
	for i := 100; i+500 < len(base); i += 997 {
		if !strings.Contains(string(res.Merged), fmt.Sprintf("ours %d\n", i)) || !strings.Contains(string(res.Merged), fmt.Sprintf("theirs %d\n", i)) {
			t.Fatalf("edit %d missing", i)
		}
	}
}

// More distinct lines than runes exist (go-diff's encoding overflowed and
// panicked past ~1.1M): the merge still works.
func TestMarkdownManyDistinctLines(t *testing.T) {
	if testing.Short() {
		t.Skip("large input")
	}
	base := numbered("l", 1_200_000)
	ours := append([]string{"ours\n"}, base...)
	theirs := append(append([]string(nil), base...), "theirs\n")
	res := Markdown([]byte(strings.Join(base, "")), []byte(strings.Join(ours, "")), []byte(strings.Join(theirs, "")))
	if !res.Clean || !strings.HasPrefix(string(res.Merged), "ours\n") || !strings.HasSuffix(string(res.Merged), "theirs\n") {
		t.Fatalf("clean=%v conflicts=%v", res.Clean, res.Conflicts)
	}
}

// TestDiffWork pins the work estimates diffBudget is documented with.
func TestDiffWork(t *testing.T) {
	ids := lineIDs{}
	work := func(a, b []string) (int, error) {
		x, _ := ids.of(a)
		y, _ := ids.of(b)
		d := &lineDiffer{a: x, b: y}
		err := d.diff(0, len(x), 0, len(y))
		return d.work, err
	}
	if w, err := work(numbered("a", 6000), numbered("b", 6000)); err != nil || w > 40_000_000 {
		t.Errorf("6,000-line rewrite: work %d, err %v", w, err)
	}
	if _, err := work(numbered("a", 12000), numbered("b", 12000)); !errors.Is(err, errTooLarge) {
		t.Errorf("12,000-line rewrite: err %v, want errTooLarge", err)
	}
	base := numbered("base", 60000)
	other := append([]string(nil), base...)
	for i := 0; i < len(other); i += 20 {
		other[i] = "edit\n"
	}
	if w, err := work(base, other); err != nil || w > 25_000_000 {
		t.Errorf("60,000 lines, 3,000 edits: work %d, err %v", w, err)
	}
}

// Edits too dense to diff within the budget give a conflict copy of ours
// (the server version stays), never a partial merge, even when the two
// sides touched disjoint lines.
func TestMarkdownOverBudgetIsConflictCopy(t *testing.T) {
	base := numbered("base", 60000)
	ours := append([]string(nil), base...)
	theirs := append([]string(nil), base...)
	for i := 0; i+2 < len(base); i += 4 {
		ours[i] = fmt.Sprintf("ours %d\n", i)
		theirs[i+2] = fmt.Sprintf("theirs %d\n", i)
	}
	th := strings.Join(theirs, "")
	res := Markdown([]byte(strings.Join(base, "")), []byte(strings.Join(ours, "")), []byte(th))
	if res.Clean || res.CopyOf != Ours || string(res.Merged) != th {
		t.Fatalf("want conflict copy of ours with theirs kept, got clean=%v copyOf=%q", res.Clean, res.CopyOf)
	}
	if len(res.Conflicts) != 1 || !strings.HasPrefix(res.Conflicts[0].Where, "whole file") {
		t.Errorf("want one whole-file conflict, got %d (first %+v)", len(res.Conflicts), res.Conflicts[0])
	}
}

func TestEOLTarget(t *testing.T) {
	lf, crlf, mixed := "a\nb\n", "a\r\nb\r\n", "a\r\nb\n"
	cases := []struct{ base, ours, theirs, want string }{
		{lf, lf, lf, ""},
		{lf, lf, crlf, "\r\n"},
		{lf, crlf, lf, "\r\n"},
		{crlf, lf, crlf, "\n"},
		{crlf, lf, mixed, "\n"},     // theirs did not switch to a uniform convention
		{lf, crlf, crlf, "\r\n"},    // both switched: theirs
		{crlf, crlf, lf, "\n"},      // theirs switched
		{mixed, mixed, lf, "\n"},    // a mixed base normalized by theirs
		{"a", "a\r\nb", "a\nc", ""}, // base has no line ending to compare with
	}
	for _, c := range cases {
		if got := eolTarget(c.base, c.ours, c.theirs); got != c.want {
			t.Errorf("eolTarget(%q, %q, %q) = %q, want %q", c.base, c.ours, c.theirs, got, c.want)
		}
	}
}

// One side converts LF to CRLF, the other edits a line: both changes are
// kept, written with the converting side's convention.
func TestMarkdownEOLChangeKeepsEdits(t *testing.T) {
	base := "---\nk: 1\n---\na\nb\nc\n"
	ours := "---\nk: 1\n---\nA\nb\nc\n"
	theirs := "---\r\nk: 2\r\n---\r\na\r\nb\r\nc\r\nd\r\n"
	res := Markdown([]byte(base), []byte(ours), []byte(theirs))
	want := "---\r\nk: 2\r\n---\r\nA\r\nb\r\nc\r\nd\r\n"
	if !res.Clean || string(res.Merged) != want {
		t.Errorf("got clean=%v %q, want %q", res.Clean, res.Merged, want)
	}
	// Ours converts, theirs edits: ours' convention.
	res = Markdown([]byte(base), []byte(strings.ReplaceAll(ours, "\n", "\r\n")), []byte("---\nk: 1\n---\na\nb\nC\n"))
	want = "---\r\nk: 1\r\n---\r\nA\r\nb\r\nC\r\n"
	if !res.Clean || string(res.Merged) != want {
		t.Errorf("got clean=%v %q, want %q", res.Clean, res.Merged, want)
	}
	// Ours converts only: theirs' edit in ours' convention.
	res = Markdown([]byte(base), []byte(strings.ReplaceAll(base, "\n", "\r\n")), []byte("---\nk: 1\n---\na\nB\nc\n"))
	want = "---\r\nk: 1\r\n---\r\na\r\nB\r\nc\r\n"
	if !res.Clean || string(res.Merged) != want {
		t.Errorf("got clean=%v %q, want %q", res.Clean, res.Merged, want)
	}
}

// BenchmarkLineDiff measures the cases diffBudget is sized on.
func BenchmarkLineDiff(b *testing.B) {
	for _, n := range []int{1000, 2000, 3000, 4000, 6000} {
		b.Run(fmt.Sprintf("rewrite-%d", n), func(b *testing.B) {
			ids := lineIDs{}
			x, _ := ids.of(numbered("a", n))
			y, _ := ids.of(numbered("b", n))
			var err error
			for b.Loop() {
				_, err = diffIDs(x, y)
			}
			b.ReportMetric(map[bool]float64{true: 1}[err != nil], "overbudget")
		})
	}
	b.Run("scattered-60000", func(b *testing.B) {
		base := numbered("base", 60000)
		other := append([]string(nil), base...)
		for i := 0; i < len(other); i += 500 {
			other[i] = "edit\n"
		}
		ids := lineIDs{}
		x, _ := ids.of(base)
		y, _ := ids.of(other)
		for b.Loop() {
			if _, err := diffIDs(x, y); err != nil {
				b.Fatal(err)
			}
		}
	})
}
