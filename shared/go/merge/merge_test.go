package merge_test

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"memobrain/shared/merge"
	"memobrain/shared/syncproto"
)

type meta struct {
	Kind      string `json:"kind"`
	Clean     bool   `json:"clean"`
	CopyOf    string `json:"copyOf"`
	OursNewer bool   `json:"oursNewer"`
	Ext       string `json:"ext"`
}

func read(t *testing.T, path string) []byte {
	t.Helper()
	b, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	return b
}

func sameJSON(a, b []byte) bool {
	var x, y any
	if json.Unmarshal(a, &x) != nil || json.Unmarshal(b, &y) != nil {
		return false
	}
	xa, _ := json.Marshal(x)
	ya, _ := json.Marshal(y)
	return string(xa) == string(ya)
}

// TestConformance runs every case of shared/conformance/merge.
func TestConformance(t *testing.T) {
	root := filepath.Join("..", "..", "conformance", "merge")
	dirs, err := os.ReadDir(root)
	if err != nil {
		t.Fatal(err)
	}
	for _, d := range dirs {
		if !d.IsDir() {
			continue
		}
		t.Run(d.Name(), func(t *testing.T) {
			dir := filepath.Join(root, d.Name())
			var m meta
			if err := json.Unmarshal(read(t, filepath.Join(dir, "meta.json")), &m); err != nil {
				t.Fatal(err)
			}
			base := read(t, filepath.Join(dir, "base."+m.Ext))
			ours := read(t, filepath.Join(dir, "ours."+m.Ext))
			theirs := read(t, filepath.Join(dir, "theirs."+m.Ext))
			want := read(t, filepath.Join(dir, "expected."+m.Ext))
			opt := merge.Options{TheirsTime: time.Unix(1000, 0)}
			if m.OursNewer {
				opt.OursTime = time.Unix(2000, 0)
			} else {
				opt.OursTime = time.Unix(500, 0)
			}
			var res merge.Result
			switch m.Kind {
			case "md":
				res = merge.Markdown(base, ours, theirs)
			case "excalidraw":
				res, err = merge.Excalidraw(base, ours, theirs)
			case "canvas":
				res, err = merge.Canvas(base, ours, theirs, opt)
			case "config":
				res, err = merge.ConfigLWW(base, ours, theirs, opt)
			default:
				t.Fatalf("unknown kind %q", m.Kind)
			}
			if err != nil {
				t.Fatal(err)
			}
			if res.Clean != m.Clean {
				t.Errorf("clean = %v, want %v (conflicts %+v)", res.Clean, m.Clean, res.Conflicts)
			}
			if string(res.CopyOf) != m.CopyOf {
				t.Errorf("copyOf = %q, want %q", res.CopyOf, m.CopyOf)
			}
			if m.Kind == "md" {
				checkNoSilentLoss(t, string(base), string(ours), string(theirs), res)
				if string(res.Merged) != string(want) {
					t.Errorf("merged:\n%q\nwant:\n%q", res.Merged, want)
				}
			} else if !sameJSON(res.Merged, want) {
				t.Errorf("merged:\n%s\nwant:\n%s", res.Merged, want)
			}
		})
	}
}

func TestMarkdownConflictsAreDescribed(t *testing.T) {
	base := []byte("a\nb\nc\n")
	res := merge.Markdown(base, []byte("a\nB1\nc\n"), []byte("a\nB2\nc\n"))
	if res.Clean || len(res.Conflicts) != 1 {
		t.Fatalf("want one conflict, got %+v", res)
	}
	h := res.Conflicts[0]
	if h.Ours != "B1\n" || h.Theirs != "B2\n" || h.Where != "lines 2-2" {
		t.Errorf("hunk = %+v", h)
	}
}

// The "lines X-Y" of a body conflict count from the top of the file kept at
// the path (merged frontmatter, then theirs' body), and follow the lines
// theirs inserted above the region.
func TestMarkdownConflictLinesAreFileRelative(t *testing.T) {
	fm := "---\ntitle: T\ntags:\n  - a\n  - b\nstatus: draft\n---\n" // 7 lines
	base := []byte(fm + "one\ntwo\nthree\nfour\n")
	ours := []byte(fm + "one\ntwo\nTHREE ours\nfour\n")
	theirs := []byte(fm + "zero\nzero bis\none\ntwo\nTHREE theirs\nfour\n")
	res := merge.Markdown(base, ours, theirs)
	if res.Clean || len(res.Conflicts) != 1 {
		t.Fatalf("want one conflict, got %+v", res)
	}
	h := res.Conflicts[0]
	lines := strings.Split(string(res.Merged), "\n")
	if h.Where != "lines 12-12" || lines[11] != "THREE theirs" {
		t.Fatalf("hunk %q, line 12 of the file is %q", h.Where, lines[11])
	}

	// A frontmatter that grows in the merge shifts the body lines too.
	base = []byte("---\nk: 1\n---\nx\n")
	ours = []byte("---\nk: 1\na: 2\n---\nX ours\n")
	theirs = []byte("---\nk: 1\nb: 3\n---\nX theirs\n")
	res = merge.Markdown(base, ours, theirs)
	lines = strings.Split(string(res.Merged), "\n")
	if len(res.Conflicts) != 1 || res.Conflicts[0].Where != "lines 6-6" || lines[5] != "X theirs" {
		t.Fatalf("conflicts %+v in\n%s", res.Conflicts, res.Merged)
	}
}

// A frontmatter merged by lines (duplicate keys) reports its conflicts in
// the lines of the merged block, which opens the file.
func TestFrontmatterLineConflictsAreFileRelative(t *testing.T) {
	base := []byte("---\nk: 1\nk: 2\nx: 0\n---\nbody\n")
	ours := []byte("---\na: 1\nk: 1\nk: 2\nx: ours\n---\nbody\n")
	theirs := []byte("---\nk: 1\nk: 2\nx: theirs\n---\nbody\n")
	res := merge.Markdown(base, ours, theirs)
	lines := strings.Split(string(res.Merged), "\n")
	if len(res.Conflicts) != 1 || res.Conflicts[0].Where != "frontmatter lines 5-5" || lines[4] != "x: theirs" {
		t.Fatalf("conflicts %+v in\n%s", res.Conflicts, res.Merged)
	}
}

func TestMarkdownIsDeterministicAndIdempotent(t *testing.T) {
	base := []byte("---\nk: 1\n---\nx\nm\ny\n")
	ours := []byte("---\nk: 2\n---\nX\nm\ny\n")
	theirs := []byte("---\nk: 1\nz: 3\n---\nx\nm\nY\n")
	a := merge.Markdown(base, ours, theirs)
	b := merge.Markdown(base, ours, theirs)
	if string(a.Merged) != string(b.Merged) || !a.Clean {
		t.Fatalf("not deterministic/clean: %q", a.Merged)
	}
	// Merging the result again with the same inputs on the other side changes nothing.
	again := merge.Markdown(theirs, a.Merged, theirs)
	if string(again.Merged) != string(a.Merged) {
		t.Errorf("re-merge changed content: %q", again.Merged)
	}
}

func TestDecide(t *testing.T) {
	cases := []struct {
		name       string
		kind       syncproto.FileKind
		same       bool
		ours, thrs merge.Change
		want       merge.Strategy
	}{
		{"md same author", syncproto.KindMarkdown, true, merge.ChangeModify, merge.ChangeModify, merge.StrategyMarkdown3Way},
		{"md other author", syncproto.KindMarkdown, false, merge.ChangeModify, merge.ChangeModify, merge.StrategyMarkdown3Way},
		{"marp other author", syncproto.KindOf("Talks/Deck.marp"), false, merge.ChangeModify, merge.ChangeModify, merge.StrategyMarkdown3Way},
		{"base same", syncproto.KindBase, true, merge.ChangeModify, merge.ChangeModify, merge.StrategyMarkdown3Way},
		{"base other", syncproto.KindBase, false, merge.ChangeModify, merge.ChangeModify, merge.StrategyConflictCopy},
		{"excalidraw same", syncproto.KindExcalidraw, true, merge.ChangeModify, merge.ChangeModify, merge.StrategyExcalidrawID},
		{"excalidraw other", syncproto.KindExcalidraw, false, merge.ChangeModify, merge.ChangeModify, merge.StrategyConflictCopy},
		{"canvas same", syncproto.KindCanvas, true, merge.ChangeModify, merge.ChangeModify, merge.StrategyCanvasID},
		{"canvas other", syncproto.KindCanvas, false, merge.ChangeModify, merge.ChangeModify, merge.StrategyConflictCopy},
		{"config", syncproto.KindConfig, true, merge.ChangeModify, merge.ChangeModify, merge.StrategyConfigLWW},
		{"attachment same", syncproto.KindAttachment, true, merge.ChangeModify, merge.ChangeModify, merge.StrategyLastWriteWins},
		{"attachment other", syncproto.KindAttachment, false, merge.ChangeModify, merge.ChangeModify, merge.StrategyConflictCopy},
		{"delete vs modify", syncproto.KindMarkdown, true, merge.ChangeDelete, merge.ChangeModify, merge.StrategyKeepModification},
		{"modify vs delete", syncproto.KindAttachment, false, merge.ChangeModify, merge.ChangeDelete, merge.StrategyKeepModification},
		{"rename vs modify", syncproto.KindMarkdown, true, merge.ChangeMove, merge.ChangeModify, merge.StrategyApplyBoth},
		{"rename vs rename", syncproto.KindMarkdown, true, merge.ChangeMove, merge.ChangeMove, merge.StrategyFirstWinsRemap},
		{"create vs create", syncproto.KindMarkdown, false, merge.ChangeCreate, merge.ChangeCreate, merge.StrategyRenameSecond},
		{"delete vs delete", syncproto.KindMarkdown, true, merge.ChangeDelete, merge.ChangeDelete, merge.StrategyApplyBoth},
	}
	for _, c := range cases {
		if got := merge.Decide(c.kind, c.same, c.ours, c.thrs); got != c.want {
			t.Errorf("%s: got %s, want %s", c.name, got, c.want)
		}
	}
}

func TestJSONRejectsMalformedInput(t *testing.T) {
	if _, err := merge.Excalidraw(nil, []byte("{"), []byte("{}")); err == nil {
		t.Error("excalidraw: want error for malformed ours")
	}
	if _, err := merge.Canvas(nil, []byte("{}"), []byte(`{"nodes":[{"x":1}]}`), merge.Options{}); err == nil {
		t.Error("canvas: want error for node without id")
	}
	if _, err := merge.ConfigLWW(nil, []byte("[1]"), []byte("{}"), merge.Options{}); err == nil {
		t.Error("config: want error for non-object")
	}
}
