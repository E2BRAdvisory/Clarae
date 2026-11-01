package merge_test

import (
	"math/rand/v2"
	"strings"
	"testing"

	"memobrain/shared/merge"
)

// lineSet returns the non-blank lines of s with trailing whitespace and
// terminators removed: the frontmatter merge compares entries ignoring
// trailing whitespace, so blank lines are not content for this check.
func lineSet(s string) map[string]bool {
	m := map[string]bool{}
	if s == "" {
		return m
	}
	for _, l := range strings.Split(strings.TrimSuffix(s, "\n"), "\n") {
		if l = strings.TrimRight(l, " \t\r"); l != "" {
			m[l] = true
		}
	}
	return m
}

// checkNoSilentLoss enforces D-04: a clean merge keeps every line that either
// side added with respect to base. A result that drops one must be a conflict.
func checkNoSilentLoss(t *testing.T, base, ours, theirs string, res merge.Result) {
	t.Helper()
	if !res.Clean {
		if res.CopyOf != merge.Ours {
			t.Errorf("conflict without a conflict copy of ours: %+v", res)
		}
		return
	}
	b, m := lineSet(base), lineSet(string(res.Merged))
	for name, side := range map[string]string{"ours": ours, "theirs": theirs} {
		for l := range lineSet(side) {
			if !b[l] && !m[l] {
				t.Errorf("clean merge dropped %s line %q\nbase:   %q\nours:   %q\ntheirs: %q\nmerged: %q",
					name, l, base, ours, theirs, res.Merged)
			}
		}
	}
}

func mergeMD(t *testing.T, base, ours, theirs string) merge.Result {
	t.Helper()
	res := merge.Markdown([]byte(base), []byte(ours), []byte(theirs))
	checkNoSilentLoss(t, base, ours, theirs, res)
	return res
}

// A frontmatter with a repeated key used to be indexed by key, so the first
// occurrence vanished from a "clean" merge.
func TestMarkdownFrontmatterDuplicateKeyKeepsBothLines(t *testing.T) {
	base := "---\nNote: one\nNote: two\n---\nbody\n"
	ours := "---\nNote: one\nNote: two\ntags: a\n---\nbody\n"
	theirs := "---\ny: 2\nNote: one\nNote: two\n---\nbody\n"
	res := mergeMD(t, base, ours, theirs)
	want := "---\ny: 2\nNote: one\nNote: two\ntags: a\n---\nbody\n"
	if !res.Clean || string(res.Merged) != want {
		t.Errorf("got clean=%v %q, want clean %q", res.Clean, res.Merged, want)
	}
}

func TestMarkdownFrontmatterDuplicateKeyOverlapConflicts(t *testing.T) {
	base := "---\nNote: one\nNote: two\n---\nbody\n"
	ours := "---\nNote: uno\nNote: two\n---\nbody\n"
	theirs := "---\nNote: eins\nNote: two\n---\nbody\n"
	res := mergeMD(t, base, ours, theirs)
	if res.Clean || len(res.Conflicts) != 1 || !strings.HasPrefix(res.Conflicts[0].Where, "frontmatter lines ") {
		t.Fatalf("want one frontmatter line conflict, got %+v", res)
	}
	if string(res.Merged) != theirs {
		t.Errorf("merged = %q, want theirs", res.Merged)
	}
}

// An empty block must close at its own second fence: the body below (with a
// thematic break further down) is not frontmatter.
func TestMarkdownEmptyFrontmatterLeavesBodyAlone(t *testing.T) {
	base := "---\n---\nA: 1\nA: 2\n\n---\nend\n"
	ours := "---\n---\nA: 1\nA: 2\nB: 1\n\n---\nend\n"
	theirs := "---\n---\nC: 1\nA: 1\nA: 2\n\n---\nend\n"
	res := mergeMD(t, base, ours, theirs)
	want := "---\n---\nC: 1\nA: 1\nA: 2\nB: 1\n\n---\nend\n"
	if !res.Clean || string(res.Merged) != want {
		t.Errorf("got clean=%v %q, want clean %q", res.Clean, res.Merged, want)
	}
}

func TestMarkdownEmptyFrontmatterCRLF(t *testing.T) {
	base := "---\r\n---\r\nA: 1\r\nA: 2\r\n\r\n---\r\nx\r\n"
	ours := "---\r\ntags: a\r\n---\r\nA: 1\r\nA: 2\r\nB: 1\r\n\r\n---\r\nx\r\n"
	theirs := "---\r\n---\r\nC: 1\r\nA: 1\r\nA: 2\r\n\r\n---\r\nx\r\n"
	res := mergeMD(t, base, ours, theirs)
	want := "---\r\ntags: a\r\n---\r\nC: 1\r\nA: 1\r\nA: 2\r\nB: 1\r\n\r\n---\r\nx\r\n"
	if !res.Clean || string(res.Merged) != want {
		t.Errorf("got clean=%v %q, want clean %q", res.Clean, res.Merged, want)
	}
}

// Stray unindented lines are not a YAML mapping: merge the block by lines.
func TestMarkdownFrontmatterNotAMappingMergesByLines(t *testing.T) {
	base := "---\n\ntext\n\n---\nbody\n"
	ours := "---\n\ntext\nmine\n\n---\nbody\n"
	theirs := "---\nfirst\n\ntext\n\n---\nbody\n"
	res := mergeMD(t, base, ours, theirs)
	want := "---\nfirst\n\ntext\nmine\n\n---\nbody\n"
	if !res.Clean || string(res.Merged) != want {
		t.Errorf("got clean=%v %q, want clean %q", res.Clean, res.Merged, want)
	}
}

// A closing fence at EOF on one side must not be glued to the merged body.
func TestMarkdownFrontmatterAtEOFKeepsLineBreak(t *testing.T) {
	base := "---\na: 1\n---"
	ours := "---\na: 1\n---\nx\n"
	theirs := "---\na: 2\n---"
	res := mergeMD(t, base, ours, theirs)
	want := "---\na: 2\n---\nx\n"
	if !res.Clean || string(res.Merged) != want {
		t.Errorf("got clean=%v %q, want clean %q", res.Clean, res.Merged, want)
	}
}

// FuzzMergeMarkdown checks that the merge never panics and never drops a
// line silently. `go test` runs only the seed corpus.
func FuzzMergeMarkdown(f *testing.F) {
	seeds := [][3]string{
		{"---\nNote: one\nNote: two\n---\nbody\n", "---\nNote: one\nNote: two\ntags: a\n---\nbody\n", "---\ny: 2\nNote: one\nNote: two\n---\nbody\n"},
		{"---\n---\nA: 1\nA: 2\n\n---\n", "---\n---\nA: 1\nA: 2\nB\n\n---\n", "---\n---\nA: 1\nA: 2\n\n---\nC\n"},
		{"---\nk: 1\n---\nx\nm\ny\n", "---\nk: 2\n---\nX\nm\ny\n", "---\nk: 1\nz: 3\n---\nx\nm\nY\n"},
		{"---\ntags:\n  - a\ntitle: X\n---\nb", "---\ntags:\n  - a\n  - c\ntitle: X\n---\nb", "---\ntags:\n  - a\ntitle: Y\n---\nb"},
		{"---\r\na: 1\r\n---\r\nx\r\n", "---\r\na: 1\r\nb: 2\r\n---\r\nx\r\n", "---\r\na: 1\r\n---\r\nx\r\ny\r\n"},
		{"---\na: 1\n---", "---\na: 1\n---\nx\n", "---\na: 2\n---"},
		{"a\nb\nc\n", "a\nB1\nc\n", "a\nB2\nc\n"},
		{"", "---\n# c\n---\n", "x"},
		{"a\nb\nc\n", "a\r\nb\r\nc\r\nd\r\n", "A\nb\nc\n"},
		{"---\r\nk: 1\r\n---\r\nx\r\n", "---\r\nk: 2\r\n---\r\nx\r\n", "---\nk: 1\n---\nx\ny\n"},
	}
	for _, s := range seeds {
		f.Add(s[0], s[1], s[2])
	}
	f.Fuzz(func(t *testing.T, base, ours, theirs string) {
		if len(base)+len(ours)+len(theirs) > 4096 {
			t.Skip()
		}
		res := merge.Markdown([]byte(base), []byte(ours), []byte(theirs))
		checkNoSilentLoss(t, base, ours, theirs, res)
	})
}

// TestMarkdownNoSilentLossRandom merges random documents built from
// frontmatter-like lines (fences, duplicate keys, list items, thematic breaks)
// and checks the D-04 invariant on each result. The seed is fixed.
func TestMarkdownNoSilentLossRandom(t *testing.T) {
	vocab := []string{"---", "---", "a: 1", "a: 2", "b: x", "Note: one", "Note: two", "- i", "  - j", "# c", "", "text", "----", "c:"}
	rng := rand.New(rand.NewPCG(1, 2)) //nolint:gosec // reproducible test data, not security
	doc := func(n int) []string {
		ls := make([]string, n)
		for i := range ls {
			ls[i] = vocab[rng.IntN(len(vocab))]
		}
		return ls
	}
	edit := func(ls []string) []string {
		out := append([]string(nil), ls...)
		for range 1 + rng.IntN(3) {
			p := rng.IntN(len(out) + 1)
			switch rng.IntN(3) {
			case 0: // insert
				out = append(out[:p], append([]string{vocab[rng.IntN(len(vocab))]}, out[p:]...)...)
			case 1: // delete
				if p < len(out) {
					out = append(out[:p], out[p+1:]...)
				}
			default: // replace
				if p < len(out) {
					out[p] = vocab[rng.IntN(len(vocab))]
				}
			}
		}
		return out
	}
	join := func(ls []string) string {
		if len(ls) == 0 {
			return ""
		}
		return strings.Join(ls, "\n") + "\n"
	}
	for range 20000 {
		b := doc(rng.IntN(10))
		if rng.IntN(2) == 0 {
			b = append([]string{"---"}, b...)
		}
		base, ours, theirs := join(b), join(edit(b)), join(edit(b))
		mergeMD(t, base, ours, theirs)
		if t.Failed() {
			return
		}
	}
}
