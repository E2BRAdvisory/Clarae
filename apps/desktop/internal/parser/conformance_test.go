package parser

import (
	"encoding/json"
	"reflect"
	"testing"

	"clarae/shared/conformance"
)

// TestConformance runs every shared Markdown fixture through the parser and
// compares with the expectation shared with the TypeScript parsers.
func TestConformance(t *testing.T) {
	dir, err := conformance.Dir("markdown")
	if err != nil {
		t.Fatal(err)
	}
	cases, err := conformance.LoadMarkdownCases(dir)
	if err != nil {
		t.Fatal(err)
	}
	for _, c := range cases {
		t.Run(c.Name, func(t *testing.T) {
			got := toExpected(Parse(c.Name, c.Source))
			if !reflect.DeepEqual(got, c.Expected) {
				g, _ := json.MarshalIndent(got, "", "  ")
				w, _ := json.MarshalIndent(c.Expected, "", "  ")
				t.Fatalf("mismatch\n--- got ---\n%s\n--- want ---\n%s", g, w)
			}
		})
	}
}

// jsonNormalize round-trips v through JSON so Go-typed values (int) compare
// equal to what a JSON expectation decodes to (float64), as in TypeScript.
func jsonNormalize(v map[string]any) map[string]any {
	b, _ := json.Marshal(v)
	out := map[string]any{}
	_ = json.Unmarshal(b, &out)
	return out
}

func toExpected(d Document) conformance.Expected {
	e := conformance.Expected{
		Title:      d.Title,
		Aliases:    d.Aliases,
		Properties: jsonNormalize(d.Properties),
		Headings:   []conformance.ExpectedHeading{},
		Links:      []conformance.ExpectedLink{},
		Tags:       []conformance.ExpectedTag{},
		BlockIDs:   []conformance.ExpectedBlockID{},
		Tasks:      []conformance.ExpectedTask{},
		Footnotes:  d.Footnotes,
		WordCount:  d.WordCount,
	}
	for _, h := range d.Headings {
		e.Headings = append(e.Headings, conformance.ExpectedHeading{Level: h.Level, Text: h.Text, Line: h.Line})
	}
	for _, l := range d.Links {
		e.Links = append(e.Links, conformance.ExpectedLink{Line: l.Line, Kind: conformance.LinkKind(l.Kind), Target: l.Target, Heading: l.Heading, Block: l.Block, Alias: l.Alias, Embed: l.Embed})
	}
	for _, tg := range d.Tags {
		e.Tags = append(e.Tags, conformance.ExpectedTag{Line: tg.Line, Name: tg.Name})
	}
	for _, b := range d.BlockIDs {
		e.BlockIDs = append(e.BlockIDs, conformance.ExpectedBlockID{Line: b.Line, ID: b.ID})
	}
	for _, tk := range d.Tasks {
		e.Tasks = append(e.Tasks, conformance.ExpectedTask{Line: tk.Line, State: tk.State, Text: tk.Text})
	}
	return e
}
