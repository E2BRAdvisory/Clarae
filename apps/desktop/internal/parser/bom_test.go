package parser

import (
	"testing"
)

// A leading BOM is not content: the index reads a note with a BOM like the same note without it
// (the TypeScript extractor holds itself to the same rule; see the bom-* conformance fixtures).
// Only the byte offsets change, because they point into the file as it is on disk.
func TestParseSkipsLeadingBOM(t *testing.T) {
	bom := "\xef\xbb\xbf"
	for name, body := range map[string]string{
		"heading":     "# H #\nSee [[a|b]] and [t](x.md)\n",
		"frontmatter": "---\ntags: [t]\n---\n# H\n[[a]]\n",
		"crlf":        "---\r\ntags: [t]\r\n---\r\n# H\r\n[[a]]\r\n",
	} {
		t.Run(name, func(t *testing.T) {
			with := Parse("n", []byte(bom+body))
			without := Parse("n", []byte(body))
			if len(with.Headings) == 0 || with.Headings[0].Text != "H" {
				t.Fatalf("heading lost behind the BOM: %+v", with.Headings)
			}
			if len(with.Links) != len(without.Links) {
				t.Fatalf("links differ: %+v vs %+v", with.Links, without.Links)
			}
			for i, l := range with.Links {
				w := without.Links[i]
				if l.Start != w.Start+len(bom) || l.End != w.End+len(bom) || l.TargetStart != w.TargetStart+len(bom) || l.TargetEnd != w.TargetEnd+len(bom) {
					t.Fatalf("offsets must point into the file as it is on disk: %+v vs %+v", l, w)
				}
				if got := (bom + body)[l.Start:l.End]; got != body[w.Start:w.End] {
					t.Fatalf("span %q does not match %q", got, body[w.Start:w.End])
				}
			}
			l, w := with, without
			l.Links, w.Links = nil, nil
			if toExpected(l).Title != toExpected(w).Title || len(l.Headings) != len(w.Headings) || len(l.Tags) != len(w.Tags) || l.WordCount != w.WordCount || len(l.Properties) != len(w.Properties) {
				t.Fatalf("BOM changes the structure: %+v vs %+v", l, w)
			}
		})
	}
	if props := ParseProperties([]byte(bom + "---\nk: v\n---\n")); props["k"] != "v" {
		t.Fatalf("ParseProperties behind a BOM: %v", props)
	}
}
