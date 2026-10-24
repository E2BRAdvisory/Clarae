package parser

import "testing"

func TestLinkOffsets(t *testing.T) {
	src := []byte("---\na: 1\n---\nCafé `[[x]]` [[ Nota |alias]] e ![[img.png#p|3]] [t](a%20b.md#h)\n")
	doc := Parse("n", src)
	if len(doc.Links) != 3 {
		t.Fatalf("links: %+v", doc.Links)
	}
	want := []struct{ whole, target string }{
		{"[[ Nota |alias]]", "Nota"},
		{"![[img.png#p|3]]", "img.png"},
		{"[t](a%20b.md#h)", "a%20b.md"},
	}
	for i, w := range want {
		l := doc.Links[i]
		if got := string(src[l.Start:l.End]); got != w.whole {
			t.Errorf("link %d whole = %q, want %q", i, got, w.whole)
		}
		if got := string(src[l.TargetStart:l.TargetEnd]); got != w.target {
			t.Errorf("link %d target = %q, want %q", i, got, w.target)
		}
	}
}
