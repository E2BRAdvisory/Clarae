package properties

import (
	"strings"
	"testing"
)

func TestInferAndCoerce(t *testing.T) {
	infer := map[string]struct {
		in   any
		want Kind
	}{
		"bool": {true, Checkbox}, "num": {3, Number}, "float": {1.5, Number}, "list": {[]any{"a"}, List},
		"date": {"2026-12-01", Date}, "datetime": {"2026-12-01T10:30:00Z", DateTime}, "text": {"hello", Text}, "nil": {nil, Text},
	}
	for name, c := range infer {
		if got := Infer(c.in); got != c.want {
			t.Errorf("%s: Infer = %s want %s", name, got, c.want)
		}
	}
	good := []struct {
		k   Kind
		in  any
		out any
	}{
		{Number, "42", 42.0}, {Checkbox, "true", true}, {Date, "2026-01-31", "2026-01-31"},
		{DateTime, "2026-01-31T09:00", "2026-01-31T09:00"}, {Text, 12.5, "12.5"},
	}
	for _, c := range good {
		got, err := Coerce(c.k, c.in)
		if err != nil || got != c.out {
			t.Errorf("Coerce(%s,%v) = %v,%v want %v", c.k, c.in, got, err, c.out)
		}
	}
	if l, err := Coerce(List, "a, b ,,c"); err != nil || len(l.([]any)) != 3 {
		t.Errorf("list: %v %v", l, err)
	}
	for _, c := range []struct {
		k  Kind
		in any
	}{{Number, "abc"}, {Checkbox, "maybe"}, {Date, "01/02/2026"}, {DateTime, "tomorrow"}, {Number, true}} {
		if _, err := Coerce(c.k, c.in); err == nil {
			t.Errorf("Coerce(%s,%v) should fail", c.k, c.in)
		}
	}
}

func TestSchema(t *testing.T) {
	s, err := ParseSchema([]byte(`{"due":"date","Done":"checkbox"}`))
	if err != nil || s.KindFor("due", "x") != Date || s.KindFor("done", "x") != Checkbox || s.KindFor("other", 3) != Number {
		t.Fatalf("schema: %v %v", s, err)
	}
	if _, err := ParseSchema([]byte(`{"a":"bogus"}`)); err == nil {
		t.Error("unknown type must be rejected")
	}
	if s, err := ParseSchema(nil); err != nil || len(s) != 0 {
		t.Error("empty input is an empty schema")
	}
}

func TestSetPreservesOrderAndComments(t *testing.T) {
	src := "---\n# status of the note\nstatus: active   # inline\ndue: 2026-12-01\ntags: [a, b]\n---\n# Title\n\nBody [[x]]\n"
	out, err := Set([]byte(src), "due", "2027-01-15")
	if err != nil {
		t.Fatal(err)
	}
	got := string(out)
	for _, want := range []string{"# status of the note", "status: active", "# inline", "due: 2027-01-15", "tags: [a, b]", "---\n# Title\n\nBody [[x]]\n"} {
		if !strings.Contains(got, want) {
			t.Errorf("missing %q in:\n%s", want, got)
		}
	}
	if strings.Index(got, "status:") > strings.Index(got, "due:") || strings.Index(got, "due:") > strings.Index(got, "tags:") {
		t.Errorf("key order changed:\n%s", got)
	}

	// New key appended; list rendered in flow style.
	out, err = Set(out, "authors", []any{"Ann", "Bob"})
	if err != nil || !strings.Contains(string(out), "authors: [Ann, Bob]") {
		t.Fatalf("append: %v\n%s", err, out)
	}
	// Block created when missing.
	out, err = Set([]byte("# Plain\n"), "status", "new")
	if err != nil || string(out) != "---\nstatus: new\n---\n# Plain\n" {
		t.Fatalf("create block: %v %q", err, out)
	}
	// Delete the last key removes the block.
	out, err = Delete(out, "status")
	if err != nil || string(out) != "# Plain\n" {
		t.Fatalf("delete: %v %q", err, out)
	}
	// Invalid frontmatter is refused rather than rewritten.
	if _, err := Set([]byte("---\na: [unclosed\n---\nx\n"), "b", 1); err == nil {
		t.Error("invalid YAML must be refused")
	}
	// CRLF files stay CRLF.
	out, err = Set([]byte("---\r\na: 1\r\n---\r\nBody\r\n"), "a", 2)
	if err != nil || string(out) != "---\r\na: 2\r\n---\r\nBody\r\n" {
		t.Fatalf("crlf: %v %q", err, out)
	}
}
