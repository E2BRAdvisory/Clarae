package parser

import (
	"reflect"
	"testing"

	"clarae/shared/conformance"
)

// TestSlidesConformance runs every shared slides fixture through the parser; the TypeScript
// parser satisfies the same expectations (packages/markdown/src/slides.test.ts).
func TestSlidesConformance(t *testing.T) {
	dir, err := conformance.Dir("slides")
	if err != nil {
		t.Fatal(err)
	}
	cases, err := conformance.LoadSlideCases(dir)
	if err != nil {
		t.Fatal(err)
	}
	if len(cases) < 6 {
		t.Fatalf("expected the slides fixtures, found %d", len(cases))
	}
	for _, c := range cases {
		t.Run(c.Name, func(t *testing.T) {
			d := ParseSlides(c.Source)
			got := conformance.ExpectedSlides{
				Config: conformance.ExpectedSlideConfig{
					Transition: d.Config.Transition,
					Theme:      d.Config.Theme,
					Progress:   d.Config.Progress,
					Numbers:    d.Config.Numbers,
					Notes:      d.Config.Notes,
				},
				Slides: []conformance.ExpectedSlide{},
			}
			for _, s := range d.Slides {
				got.Slides = append(got.Slides, conformance.ExpectedSlide{Line: s.Line, Content: s.Content, Notes: s.Notes})
			}
			if !reflect.DeepEqual(got, c.Expected) {
				t.Fatalf("mismatch\n got: %+v\nwant: %+v", got, c.Expected)
			}
		})
	}
}

func TestSlidesBOMAndCRLF(t *testing.T) {
	lf := "# A\n\nNote: n\n\n---\n\n# B\n"
	crlf := "\xef\xbb\xbf# A\r\n\r\nNote: n\r\n\r\n---\r\n\r\n# B\r\n"
	if a, b := ParseSlides([]byte(lf)), ParseSlides([]byte(crlf)); !reflect.DeepEqual(a, b) {
		t.Fatalf("BOM and CRLF changed the result:\n%+v\n%+v", a, b)
	}
}
