package canvas

import (
	"errors"
	"strings"
	"testing"
)

const sample = `{
  "nodes": [
    {"id": "n1", "type": "text", "x": 0, "y": 0, "width": 200, "height": 80, "text": "Idea about [[Alpha]]"},
    {"id": "n2", "type": "file", "x": 300, "y": 0, "width": 200, "height": 80, "file": "Notes/Plan.md", "subpath": "#Goals"},
    {"id": "n3", "type": "link", "x": 0, "y": 200, "width": 200, "height": 80, "url": "https://example.com"},
    {"id": "g1", "type": "group", "x": -10, "y": -10, "width": 600, "height": 400, "label": "Roadmap"}
  ],
  "edges": [{"id": "e1", "fromNode": "n1", "toNode": "n2", "label": "depends on"}]
}`

func TestExtract(t *testing.T) {
	d, err := Extract([]byte(sample))
	if err != nil {
		t.Fatal(err)
	}
	if d.Nodes != 4 {
		t.Errorf("nodes = %d", d.Nodes)
	}
	for _, w := range []string{"Idea about [[Alpha]]", "Roadmap", "depends on", "Notes/Plan.md"} {
		if !strings.Contains(d.Text, w) {
			t.Errorf("text misses %q: %q", w, d.Text)
		}
	}
	targets := map[string]string{}
	for _, l := range d.Links {
		targets[l.Target] = l.Heading
	}
	if len(targets) != 2 || targets["Alpha"] != "" || targets["Notes/Plan"] != "Goals" && targets["Notes/Plan.md"] != "Goals" {
		t.Errorf("links = %v", targets)
	}
}

func TestParseValidation(t *testing.T) {
	for name, in := range map[string]string{
		"not json":       `{`,
		"unknown type":   `{"nodes":[{"id":"a","type":"video"}]}`,
		"no id":          `{"nodes":[{"type":"text"}]}`,
		"duplicate":      `{"nodes":[{"id":"a","type":"text"},{"id":"a","type":"text"}]}`,
		"file w/o file":  `{"nodes":[{"id":"a","type":"file"}]}`,
		"link w/o url":   `{"nodes":[{"id":"a","type":"link"}]}`,
		"dangling edge":  `{"nodes":[{"id":"a","type":"text"}],"edges":[{"id":"e","fromNode":"a","toNode":"zz"}]}`,
		"edge reuses id": `{"nodes":[{"id":"a","type":"text"}],"edges":[{"id":"a","fromNode":"a","toNode":"a"}]}`,
	} {
		if _, err := Parse([]byte(in)); !errors.Is(err, ErrInvalid) {
			t.Errorf("%s: err = %v", name, err)
		}
	}
	for _, ok := range []string{``, `{}`, `{"nodes":[],"edges":[]}`} {
		if _, err := Parse([]byte(ok)); err != nil {
			t.Errorf("%q must be valid: %v", ok, err)
		}
	}
}
