package parser

import (
	"bytes"
	"fmt"
	"strings"
	"testing"
	"time"
)

// lineOf must agree with counting the newlines before the offset, at every offset.
func TestLineOfMatchesNewlineCount(t *testing.T) {
	for _, src := range []string{"", "\n", "a", "a\nb", "\n\nab\n\ncd\n", "x\r\ny\n\n"} {
		body := []byte(src)
		starts := lineStarts(bytes.Split(body, []byte("\n")))
		for off := 0; off <= len(body); off++ {
			if got, want := lineOf(starts, off), bytes.Count(body[:off], []byte("\n"))+1; got != want {
				t.Fatalf("%q at %d: line %d, want %d", src, off, got, want)
			}
		}
	}
}

// Headings and code lines keep their line numbers (after a frontmatter too).
func TestLinesOfHeadingsAndCode(t *testing.T) {
	src := "---\na: 1\n---\n# One\n```\n#notatag [[nolink]]\n```\ntext #tag\n\n## Two\n    indented [[x]]\n\n[[y]]\n"
	doc := Parse("n", []byte(src))
	if len(doc.Headings) != 2 || doc.Headings[0].Line != 4 || doc.Headings[1].Line != 10 {
		t.Fatalf("headings: %+v", doc.Headings)
	}
	if len(doc.Tags) != 1 || doc.Tags[0].Name != "tag" || doc.Tags[0].Line != 8 {
		t.Fatalf("tags: %+v", doc.Tags)
	}
	if len(doc.Links) != 1 || doc.Links[0].Target != "y" || doc.Links[0].Line != 13 {
		t.Fatalf("links: %+v", doc.Links)
	}
}

// A pasted log of a few MB in a code block parses in linear time: counting the newlines from
// the start for each of its lines took minutes.
func TestParseLongCodeBlockIsLinear(t *testing.T) {
	if testing.Short() {
		t.Skip("parses a large note")
	}
	var b strings.Builder
	b.WriteString("# Log\n```\n")
	for i := 0; i < 200_000; i++ {
		fmt.Fprintf(&b, "line %07d [[x]]\n", i)
	}
	b.WriteString("```\n[[after]]\n")
	start := time.Now()
	doc := Parse("log", []byte(b.String()))
	if took := time.Since(start); took > 20*time.Second {
		t.Fatalf("parse took %v", took)
	}
	if len(doc.Links) != 1 || doc.Links[0].Line != 200_004 {
		t.Fatalf("links: %+v", doc.Links)
	}
}

func BenchmarkParseLongCodeBlock(b *testing.B) {
	var sb strings.Builder
	sb.WriteString("```\n")
	for i := 0; i < 20_000; i++ {
		fmt.Fprintf(&sb, "line %07d\n", i)
	}
	sb.WriteString("```\n")
	src := []byte(sb.String())
	b.ResetTimer()
	for b.Loop() {
		Parse("log", src)
	}
}
