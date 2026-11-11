package properties

import "testing"

// A note with a leading BOM is edited in place: the BOM stays the first bytes of the file and the block is
// rewritten, never duplicated in front of it (the frontmatter of such a note is visible to the panel since the
// parser skips the BOM, so the writer has to agree).
func TestSetAndDeleteKeepTheBOM(t *testing.T) {
	const bom = "\xef\xbb\xbf"
	for _, nl := range []string{"\n", "\r\n"} {
		name := map[string]string{"\n": "LF", "\r\n": "CRLF"}[nl]
		t.Run(name, func(t *testing.T) {
			src := bom + "---" + nl + "a: 1" + nl + "b: 2" + nl + "---" + nl + "# H" + nl

			out, err := Set([]byte(src), "a", 5)
			if want := bom + "---" + nl + "a: 5" + nl + "b: 2" + nl + "---" + nl + "# H" + nl; err != nil || string(out) != want {
				t.Fatalf("set existing: %v\n got %q\nwant %q", err, out, want)
			}
			out, err = Set([]byte(src), "c", "x")
			if want := bom + "---" + nl + "a: 1" + nl + "b: 2" + nl + "c: x" + nl + "---" + nl + "# H" + nl; err != nil || string(out) != want {
				t.Fatalf("set new: %v\n got %q\nwant %q", err, out, want)
			}
			out, err = Delete([]byte(src), "a")
			if want := bom + "---" + nl + "b: 2" + nl + "---" + nl + "# H" + nl; err != nil || string(out) != want {
				t.Fatalf("delete: %v\n got %q\nwant %q", err, out, want)
			}
			// Missing key: the file is returned as it is, BOM included.
			out, err = Delete([]byte(src), "zzz")
			if want := bom + "---" + nl + "a: 1" + nl + "b: 2" + nl + "---" + nl + "# H" + nl; err != nil || string(out) != want {
				t.Fatalf("delete absent: %v\n got %q\nwant %q", err, out, want)
			}
			// The last key goes: the block disappears, the BOM stays.
			one := bom + "---" + nl + "a: 1" + nl + "---" + nl + "# H" + nl
			out, err = Delete([]byte(one), "a")
			if want := bom + "# H" + nl; err != nil || string(out) != want {
				t.Fatalf("delete last: %v\n got %q\nwant %q", err, out, want)
			}
			// No frontmatter: the block is created after the BOM.
			out, err = Set([]byte(bom+"# H"+nl), "a", 1)
			if want := bom + "---" + nl + "a: 1" + nl + "---" + nl + "# H" + nl; err != nil || string(out) != want {
				t.Fatalf("create block: %v\n got %q\nwant %q", err, out, want)
			}
			out, err = Delete([]byte(bom+"# H"+nl), "a")
			if want := bom + "# H" + nl; err != nil || string(out) != want {
				t.Fatalf("delete without block: %v\n got %q\nwant %q", err, out, want)
			}
		})
	}
	if _, err := Set([]byte(bom+"---\na: [unclosed\n---\nx\n"), "b", 1); err == nil {
		t.Error("invalid YAML behind a BOM must be refused")
	}
}
