package conformance

import "testing"

// TestConformanceFixturesWellFormed makes a malformed fixture fail here, with
// a clear message, rather than inside every parser's conformance test.
func TestConformanceFixturesWellFormed(t *testing.T) {
	dir, err := Dir("markdown")
	if err != nil {
		t.Fatal(err)
	}
	cases, err := LoadMarkdownCases(dir)
	if err != nil {
		t.Fatal(err)
	}
	if len(cases) == 0 {
		t.Fatal("no fixtures found")
	}
}

// TestSlideFixturesWellFormed does the same for shared/conformance/slides.
func TestSlideFixturesWellFormed(t *testing.T) {
	dir, err := Dir("slides")
	if err != nil {
		t.Fatal(err)
	}
	cases, err := LoadSlideCases(dir)
	if err != nil {
		t.Fatal(err)
	}
	if len(cases) == 0 {
		t.Fatal("no slide fixtures found")
	}
}
