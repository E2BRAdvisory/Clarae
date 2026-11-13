package links

import (
	"regexp"
	"strings"

	"clarae/apps/desktop/internal/parser"
)

// drawingLink matches a wikilink as it appears inside the JSON text of a drawing (the `link` of
// an element, the text of a label). Links that contain JSON escapes (quotes, backslashes) are not
// matched: they cannot be rewritten in place and are left alone.
var drawingLink = regexp.MustCompile(`(!?)\[\[([^\[\]|#"\\]+)(#[^\[\]|"\\]*)?(\|[^\[\]"\\]*)?\]\]`)

// scanDrawingLinks finds the wikilinks of an .excalidraw file with byte offsets into the raw
// JSON, so a rename can rewrite them without re-serialising the drawing (which would reorder
// keys and rewrite the whole file).
func scanDrawingLinks(data []byte) []parser.Link {
	var out []parser.Link
	line := 1
	last := 0
	for _, m := range drawingLink.FindAllSubmatchIndex(data, -1) {
		if inURLString(data, m[0]) {
			continue
		}
		line += strings.Count(string(data[last:m[0]]), "\n")
		last = m[0]
		l := parser.Link{
			Line:        line,
			Kind:        parser.LinkWikilink,
			Target:      strings.TrimSpace(string(data[m[4]:m[5]])),
			Embed:       m[3] > m[2],
			Start:       m[0],
			End:         m[1],
			TargetStart: m[4],
			TargetEnd:   m[5],
		}
		out = append(out, l)
	}
	return out
}

// jsonSafe reports whether text can be written inside a JSON string as it is.
func jsonSafe(text string) bool {
	for _, r := range text {
		if r == '"' || r == '\\' || r < 0x20 {
			return false
		}
	}
	return true
}

var urlString = regexp.MustCompile(`(?i)^(https?|ftp|file|mailto|obsidian):`)

// inURLString reports whether pos lies inside a JSON string that is a URL (the link of an
// element pointing at the web): "[[x]]" there is part of the address, not a wikilink.
func inURLString(data []byte, pos int) bool {
	for i := pos - 1; i >= 0; i-- {
		if data[i] != '"' {
			continue
		}
		backslashes := 0
		for j := i - 1; j >= 0 && data[j] == '\\'; j-- {
			backslashes++
		}
		if backslashes%2 == 0 { // an unescaped quote: the string starts here
			return urlString.Match(data[i+1 : pos])
		}
	}
	return false
}
