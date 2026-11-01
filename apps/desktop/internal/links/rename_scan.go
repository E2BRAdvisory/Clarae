package links

import (
	"bytes"
	"encoding/json"
	"regexp"
	"strings"

	"memobrain/apps/desktop/internal/canvas"
	"memobrain/apps/desktop/internal/parser"
)

// rewritable is a link a rename or a redirect may rewrite in place.
type rewritable struct {
	parser.Link
	// exact marks a canvas file node: its value is the vault path of the file
	// itself, not a link target to resolve.
	exact bool
	// safe, when set, tells whether a replacement can be written in place
	// (inside a JSON string, in YAML): a link that would need escaping is
	// left as it is.
	safe func(string) bool
}

// rewritableLinks returns the links of a file a rename may rewrite: those of
// a note's body and of its properties, the [[links]] in the JSON of a drawing
// or a canvas, and the file nodes of a canvas.
func rewritableLinks(f File, data []byte, title string) []rewritable {
	var out []rewritable
	switch f.Kind {
	case "md":
		for _, l := range parser.Parse(title, data).Links {
			out = append(out, rewritable{Link: l})
		}
		out = append(out, scanFrontmatterLinks(data)...)
	case "excalidraw":
		for _, l := range scanDrawingLinks(data) {
			out = append(out, rewritable{Link: l, safe: jsonSafe})
		}
	case "canvas":
		for _, l := range scanDrawingLinks(data) { // wikilinks in text nodes
			out = append(out, rewritable{Link: l, safe: jsonSafe})
		}
		for _, l := range scanCanvasFiles(data) {
			out = append(out, rewritable{Link: l, exact: true, safe: jsonSafe})
		}
	}
	return out
}

// canvasFileField matches a "file" member of a JSON object with an unescaped value.
var canvasFileField = regexp.MustCompile(`"file"\s*:\s*"([^"\\]*)"`)

// scanCanvasFiles finds the file nodes of a canvas with the byte offsets of
// their path in the raw JSON, so a rename rewrites them without
// re-serialising the canvas. Only the values that are the file of a file node
// count (a text node holding `"file": "x"` has its quotes escaped and does
// not match anyway); a path written with JSON escapes is left alone.
func scanCanvasFiles(data []byte) []parser.Link {
	c, err := canvas.Parse(data)
	if err != nil {
		return nil
	}
	nodes := map[string]bool{}
	for _, n := range c.Nodes {
		if n.Type == canvas.TypeFile && n.File != "" {
			nodes[n.File] = true
		}
	}
	if len(nodes) == 0 {
		return nil
	}
	var out []parser.Link
	for _, m := range canvasFileField.FindAllSubmatchIndex(data, -1) {
		if escapedQuote(data, m[0]) {
			continue
		}
		target := string(data[m[2]:m[3]])
		if !nodes[target] {
			continue
		}
		out = append(out, parser.Link{
			Line: 1 + bytes.Count(data[:m[0]], []byte("\n")), Kind: parser.LinkWikilink, Target: target, Embed: true,
			Start: m[0], End: m[1], TargetStart: m[2], TargetEnd: m[3],
		})
	}
	return out
}

// escapedQuote reports whether the quote at pos is escaped (odd backslashes before it).
func escapedQuote(data []byte, pos int) bool {
	n := 0
	for i := pos - 1; i >= 0 && data[i] == '\\'; i-- {
		n++
	}
	return n%2 == 1
}

// frontmatterLink is a wikilink inside a property value.
var frontmatterLink = regexp.MustCompile(`(!?)\[\[([^\[\]|#"\\\n]+)(#[^\[\]|"\\\n]*)?(\|[^\[\]"\\\n]*)?\]\]`)

// scanFrontmatterLinks finds the wikilinks in the property values of a note
// ("related: "[[Note]]"", Obsidian's property links) with byte offsets into
// the whole file. Only the properties the index stores with a "[[" in their
// value are scanned (the rename candidates are selected that way), never
// tags, aliases or cssclasses, and never past a YAML comment.
func scanFrontmatterLinks(data []byte) []rewritable {
	_, _, fm := parser.SplitFrontmatter(data)
	if len(fm) == 0 {
		return nil
	}
	props := parser.ParseProperties(data)
	linked := map[string]bool{}
	for k, v := range props {
		if raw, err := json.Marshal(v); err == nil && bytes.Contains(raw, []byte("[[")) {
			linked[k] = true
		}
	}
	if len(linked) == 0 {
		return nil
	}
	base := bytes.IndexByte(data, '\n') + 1 // the block starts after the opening "---" line
	var out []rewritable
	key := ""
	pos := 0
	for lineNo := 2; pos < len(fm); lineNo++ {
		end := bytes.IndexByte(fm[pos:], '\n')
		next := len(fm)
		if end >= 0 {
			next = pos + end + 1
		} else {
			end = len(fm) - pos
		}
		line := fm[pos : pos+end]
		if k, ok := topLevelKey(line); ok {
			key = k
		}
		if linked[key] {
			text := line[:commentStart(line)]
			for _, m := range frontmatterLink.FindAllSubmatchIndex(text, -1) {
				l := parser.Link{
					Line: lineNo, Kind: parser.LinkWikilink, Target: strings.TrimSpace(string(text[m[4]:m[5]])), Embed: m[3] > m[2],
					Start: base + pos + m[0], End: base + pos + m[1], TargetStart: base + pos + m[4], TargetEnd: base + pos + m[5],
				}
				safe := yamlSafe
				if quoteAt(text, m[0]) == '\'' {
					safe = func(s string) bool { return yamlSafe(s) && !strings.ContainsRune(s, '\'') }
				}
				out = append(out, rewritable{Link: l, safe: safe})
			}
		}
		pos = next
	}
	return out
}

// topLevelKey returns the key a YAML line at column 0 opens ("key: value").
func topLevelKey(line []byte) (string, bool) {
	if len(line) == 0 || line[0] == ' ' || line[0] == '\t' || line[0] == '#' || line[0] == '-' {
		return "", false
	}
	i := bytes.IndexByte(line, ':')
	if i <= 0 {
		return "", false
	}
	k := strings.Trim(strings.TrimSpace(string(line[:i])), `"'`)
	return k, true
}

// quoteAt is the YAML quote (' or ") open at offset pos of the line, or 0.
func quoteAt(line []byte, pos int) byte {
	var quote byte
	for _, c := range line[:pos] {
		switch {
		case quote != 0:
			if c == quote {
				quote = 0
			}
		case c == '"' || c == '\'':
			quote = c
		}
	}
	return quote
}

// commentStart is the offset of a YAML comment on the line (" #" outside
// quotes, or "#" at its start), or the line length.
func commentStart(line []byte) int {
	var quote byte
	for i, c := range line {
		switch {
		case quote != 0:
			if c == quote {
				quote = 0
			}
		case c == '"' || c == '\'':
			quote = c
		case c == '#' && (i == 0 || line[i-1] == ' ' || line[i-1] == '\t'):
			return i
		}
	}
	return len(line)
}

// yamlSafe reports whether text can replace a link target inside a property
// value, double-quoted or plain: no double quote, escape, flow or comment
// character, no ": " (a single quote is checked by the caller, where the
// value is single-quoted).
func yamlSafe(text string) bool {
	for _, r := range text {
		if r < 0x20 || strings.ContainsRune(`"\#,[]{}`, r) {
			return false
		}
	}
	return !strings.Contains(text, ": ")
}
