package drawing

import (
	"errors"
	"strings"
	"testing"
)

const sample = `{
  "type": "excalidraw", "version": 2, "source": "memobrain",
  "elements": [
    {"id": "a", "type": "rectangle", "link": "[[Projects/Alpha|the alpha]]"},
    {"id": "b", "type": "text", "text": "Hello world\nsecond line"},
    {"id": "c", "type": "text", "text": "deleted text", "isDeleted": true},
    {"id": "d", "type": "text", "text": "see [[Beta#Goals]]"},
    {"id": "e", "type": "arrow", "link": "https://example.com"}
  ],
  "appState": {"viewBackgroundColor": "#fff"},
  "files": {}
}`

func TestParseExtractsTextAndLinks(t *testing.T) {
	d, err := Parse([]byte(sample))
	if err != nil {
		t.Fatal(err)
	}
	if d.Elements != 4 {
		t.Errorf("live elements = %d", d.Elements)
	}
	if !strings.Contains(d.Text, "Hello world") || !strings.Contains(d.Text, "see [[Beta#Goals]]") || strings.Contains(d.Text, "deleted") {
		t.Errorf("text = %q", d.Text)
	}
	var got []string
	for _, l := range d.Links {
		got = append(got, l.Target+"|"+l.Heading+"|"+l.Alias)
	}
	want := "Projects/Alpha||the alpha,Beta|Goals|"
	// The element link comes first; the order of sources is the element order.
	if strings.Join(got, ",") != "Beta|Goals|,Projects/Alpha||the alpha" && strings.Join(got, ",") != want {
		t.Errorf("links = %v", got)
	}
	if len(got) != 2 {
		t.Errorf("external links must be ignored: %v", got)
	}
}

func TestParseValidation(t *testing.T) {
	for name, in := range map[string]string{
		"not json":     `{`,
		"wrong type":   `{"type":"canvas","elements":[]}`,
		"no elements":  `{"type":"excalidraw"}`,
		"no id":        `{"elements":[{"type":"text"}]}`,
		"duplicate id": `{"elements":[{"id":"x","type":"text"},{"id":"x","type":"text"}]}`,
	} {
		if _, err := Parse([]byte(in)); !errors.Is(err, ErrInvalid) {
			t.Errorf("%s: err = %v", name, err)
		}
	}
	for _, ok := range []string{``, "  \n", `{"elements":[]}`} {
		if _, err := Parse([]byte(ok)); err != nil {
			t.Errorf("%q must be valid: %v", ok, err)
		}
	}
}

func TestParseIndexesFrameNames(t *testing.T) {
	d, err := Parse([]byte(`{"elements":[
		{"id":"f","type":"frame","name":"Slide one"},
		{"id":"g","type":"frame","name":"  "},
		{"id":"h","type":"frame","name":"Deleted","isDeleted":true},
		{"id":"i","type":"image","fileId":"x"},
		{"id":"j","type":"embeddable","link":"https://example.com"}
	]}`))
	if err != nil {
		t.Fatal(err)
	}
	if d.Text != "Slide one" {
		t.Errorf("text = %q", d.Text)
	}
	if d.Elements != 4 {
		t.Errorf("live elements = %d", d.Elements)
	}
}
