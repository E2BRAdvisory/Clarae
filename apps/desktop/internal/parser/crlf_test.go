package parser

import (
	"reflect"
	"strings"
	"testing"

	"clarae/shared/conformance"
)

// TestConformanceCRLF reads every shared fixture again with its line endings turned into CRLF: the
// index must see the same structure (the TypeScript extractor holds itself to the same rule).
// A setext heading over several lines keeps the CRLF inside its text, so those cases are skipped.
func TestConformanceCRLF(t *testing.T) {
	dir, err := conformance.Dir("markdown")
	if err != nil {
		t.Fatal(err)
	}
	cases, err := conformance.LoadMarkdownCases(dir)
	if err != nil {
		t.Fatal(err)
	}
	for _, c := range cases {
		if strings.Contains(string(c.Source), "\r") {
			continue // already CRLF (or mixed): covered by TestConformance
		}
		multiLine := false
		for _, h := range c.Expected.Headings {
			multiLine = multiLine || strings.Contains(h.Text, "\n")
		}
		if multiLine {
			continue
		}
		t.Run(c.Name, func(t *testing.T) {
			crlf := []byte(strings.ReplaceAll(string(c.Source), "\n", "\r\n"))
			got := toExpected(Parse(c.Name, crlf))
			if !reflect.DeepEqual(got, c.Expected) {
				t.Fatalf("CRLF changes what the parser extracts\n got: %+v\nwant: %+v", got, c.Expected)
			}
		})
	}
}
