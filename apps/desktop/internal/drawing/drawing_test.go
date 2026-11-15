package drawing

import (
	"errors"
	"strings"
	"testing"
)

const sample = `{
  "type": "excalidraw", "version": 2, "source": "clarae",
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

func TestParseWarnsAboutOversizedImages(t *testing.T) {
	big := strings.Repeat("A", MaxImageSize+1)
	doc, err := Parse([]byte(`{"type":"excalidraw","elements":[],"files":{"big":{"dataURL":"` + big + `"},"ok":{"dataURL":"data:x"}}}`))
	if err != nil {
		t.Fatal(err)
	}
	if len(doc.Warnings) != 1 || !strings.Contains(doc.Warnings[0], `"big"`) {
		t.Errorf("warnings = %v", doc.Warnings)
	}
}

func TestParseIndexesTheTypedTextNotTheWrappedOne(t *testing.T) {
	d, err := Parse([]byte(`{"elements":[
		{"id":"a","type":"text","text":"anti\nconstitutional\nword","originalText":"anticonstitutional word"},
		{"id":"b","type":"text","text":"no original","originalText":""},
		{"id":"c","type":"text","text":"blank original","originalText":"  "},
		{"id":"d","type":"text","text":"see [[Target\nNote]]","originalText":"see [[Target Note]]"}
	]}`))
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{"anticonstitutional word", "no original", "blank original"} {
		if !strings.Contains(d.Text, want) {
			t.Errorf("text %q lacks %q", d.Text, want)
		}
	}
	if strings.Contains(d.Text, "anti\nconstitutional") {
		t.Errorf("the wrapped text was indexed: %q", d.Text)
	}
	// The links come from the same text: a note name wrapped over two lines is still one name.
	if len(d.Links) != 1 || d.Links[0].Target != "Target Note" {
		t.Errorf("links = %+v", d.Links)
	}
}

func TestParseIndexesFormulaTeX(t *testing.T) {
	d, err := Parse([]byte(`{"elements":[
		{"id":"a","type":"image","fileId":"f1","customData":{"clarae":{"kind":"latex","latex":"\\int_0^1 x\\,dx","w0":10}}},
		{"id":"b","type":"image","fileId":"f2","customData":{"memobrain":{"kind":"latex","latex":"E = mc^2"}}},
		{"id":"c","type":"image","fileId":"f3","customData":{"clarae":{"kind":"latex","latex":"new"},"memobrain":{"kind":"latex","latex":"old"}}},
		{"id":"d","type":"image","fileId":"f4","customData":{"clarae":{"kind":"slide"},"memobrain":{"kind":"latex","latex":"hidden by the new key"}}},
		{"id":"e","type":"image","fileId":"f5","customData":{"clarae":{"kind":"latex","latex":"deleted"}},"isDeleted":true},
		{"id":"f","type":"image","fileId":"f6","customData":{"other":{"kind":"latex","latex":"foreign key"}}},
		{"id":"g","type":"image","fileId":"f7","customData":"not an object"},
		{"id":"h","type":"image","fileId":"f8","customData":{"clarae":{"kind":"latex","latex":42}}},
		{"id":"i","type":"image","fileId":"f9","customData":{"clarae":{"kind":"latex","latex":"A_{[[1]]}"}}}
	]}`))
	if err != nil {
		t.Fatal(err)
	}
	got := strings.Split(d.Text, "\n")
	want := []string{`\int_0^1 x\,dx`, "E = mc^2", "new", "A_{[[1]]}"}
	if strings.Join(got, "|") != strings.Join(want, "|") {
		t.Errorf("text = %q, want %q", got, want)
	}
	if len(d.Links) != 0 {
		t.Errorf("a formula is not a source of links: %+v", d.Links)
	}
}
