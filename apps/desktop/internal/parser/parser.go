// Package parser extracts the structure the indexer needs from a Markdown
// note: frontmatter, headings, links and embeds, tags, block ids, tasks,
// footnotes and word count (§2.4, §2.2.2 Obsidian Flavored Markdown).
//
// M0 ships a first version driven by the shared conformance fixtures
// (shared/conformance/markdown): goldmark builds the block structure
// (headings, code blocks, which lines are code) and a line scanner extracts
// the inline OFM elements outside code. M1 replaces the scanner with
// goldmark inline extensions as the fixture set grows; the contract of this
// package (Document) stays.
package parser

import (
	"bytes"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"

	"github.com/yuin/goldmark"
	"github.com/yuin/goldmark/ast"
	"github.com/yuin/goldmark/extension"
	"github.com/yuin/goldmark/text"
	"gopkg.in/yaml.v3"
)

// Document is what the parser extracts from one note.
type Document struct {
	Title      string
	Aliases    []string
	Properties map[string]any
	Headings   []Heading
	Links      []Link
	Tags       []Tag
	BlockIDs   []BlockID
	Tasks      []Task
	Footnotes  []string
	WordCount  int
}

// Heading is one ATX or setext heading.
type Heading struct {
	Level int
	Text  string
	Line  int
}

// LinkKind distinguishes link syntaxes.
type LinkKind string

// Link kinds.
const (
	LinkWikilink LinkKind = "wikilink"
	LinkMarkdown LinkKind = "markdown"
	LinkExternal LinkKind = "external"
)

// Link is one link or embed occurrence.
type Link struct {
	Line    int
	Kind    LinkKind
	Target  string
	Heading string
	Block   string
	Alias   string
	Embed   bool
	// Byte offsets in the whole source: the full link token (including a
	// leading '!') and just the target path (before any '#' fragment). Used
	// to rewrite links when files are renamed.
	Start, End, TargetStart, TargetEnd int
}

// Tag is one #tag occurrence (name without '#').
type Tag struct {
	Line int
	Name string
}

// BlockID is one "^id" block identifier definition.
type BlockID struct {
	Line int
	ID   string
}

// Task is one task list item; State is the character between the brackets.
type Task struct {
	Line  int
	State string
	Text  string
}

var md = goldmark.New(goldmark.WithExtensions(extension.GFM, extension.Footnote))

// Parse extracts the structure of a note. title is the file name without
// extension (Obsidian semantics: the H1 is not the title).
func Parse(title string, src []byte) Document {
	doc := Document{Title: title, Aliases: []string{}, Properties: map[string]any{}, Headings: []Heading{}, Links: []Link{}, Tags: []Tag{}, BlockIDs: []BlockID{}, Tasks: []Task{}, Footnotes: []string{}}
	body, bodyLineOffset, fm := splitFrontmatter(src)
	parseFrontmatter(&doc, fm)

	lines := bytes.Split(body, []byte("\n"))
	codeLines := make([]bool, len(lines))

	reader := text.NewReader(body)
	root := md.Parser().Parse(reader)
	_ = ast.Walk(root, func(n ast.Node, entering bool) (ast.WalkStatus, error) {
		if !entering {
			return ast.WalkContinue, nil
		}
		switch v := n.(type) {
		case *ast.Heading:
			if v.Lines().Len() == 0 {
				break // empty heading ("#"): nothing to report
			}
			line := lineOf(body, v.Lines().At(0).Start)
			doc.Headings = append(doc.Headings, Heading{Level: v.Level, Text: string(headingText(v, body)), Line: line + bodyLineOffset})
		case *ast.FencedCodeBlock, *ast.CodeBlock:
			markCodeLines(v, body, codeLines)
		}
		return ast.WalkContinue, nil
	})
	// Fence delimiter lines are not part of Lines() for fenced blocks: mark
	// them explicitly by scanning for fences.
	markFenceDelimiters(lines, codeLines)

	// Block-level states that span lines: %%comments%% and $$display math$$.
	inMath, inComment := false, false
	lineStart := len(src) - len(body)
	for i, raw := range lines {
		base := lineStart
		lineStart += len(raw) + 1
		lineNo := i + 1 + bodyLineOffset
		if codeLines[i] {
			continue
		}
		line := string(raw)
		hidden := inMath || inComment // the line starts inside a comment or math block
		visible := maskBlocks(stripInlineCode(line), &inMath, &inComment)
		scanLine(&doc, line, visible, lineNo, base, hidden)
	}
	doc.WordCount = countWords(body)
	return doc
}

func lineOf(src []byte, offset int) int {
	return bytes.Count(src[:offset], []byte("\n")) + 1
}

func headingText(h *ast.Heading, src []byte) []byte {
	var buf bytes.Buffer
	for i := 0; i < h.Lines().Len(); i++ {
		seg := h.Lines().At(i)
		buf.Write(seg.Value(src))
	}
	return bytes.TrimSpace(buf.Bytes())
}

func markCodeLines(n ast.Node, src []byte, codeLines []bool) {
	lines := n.Lines()
	for i := 0; i < lines.Len(); i++ {
		seg := lines.At(i)
		l := lineOf(src, seg.Start) - 1
		if l >= 0 && l < len(codeLines) {
			codeLines[l] = true
		}
	}
}

var fenceRe = regexp.MustCompile("^\\s{0,3}(`{3,}|~{3,})")

func markFenceDelimiters(lines [][]byte, codeLines []bool) {
	inFence := false
	var fence string
	for i, l := range lines {
		m := fenceRe.FindSubmatch(l)
		if m == nil {
			continue
		}
		delim := string(m[1])
		switch {
		case !inFence:
			inFence, fence = true, delim
			codeLines[i] = true
		case strings.HasPrefix(delim, fence[:1]) && len(delim) >= len(fence):
			inFence = false
			codeLines[i] = true
		}
	}
}

// --- frontmatter ----------------------------------------------------------

// SplitFrontmatter is the exported form of splitFrontmatter for packages that
// edit the block (properties).
func SplitFrontmatter(src []byte) (body []byte, bodyLineOffset int, fm []byte) {
	return splitFrontmatter(src)
}

// splitFrontmatter separates a leading YAML block delimited by "---" lines.
// bodyLineOffset is the number of file lines the block occupies (so body
// line n is file line n+offset); fm is the YAML between the delimiters.
func splitFrontmatter(src []byte) (body []byte, bodyLineOffset int, fm []byte) {
	first := bytes.IndexByte(src, '\n')
	if first < 0 || strings.TrimRight(string(src[:first]), "\r") != "---" {
		return src, 0, nil
	}
	pos := first + 1
	lineNo := 1
	for pos <= len(src) {
		end := bytes.IndexByte(src[pos:], '\n')
		line := src[pos:]
		next := len(src)
		if end >= 0 {
			line = src[pos : pos+end]
			next = pos + end + 1
		}
		lineNo++
		if t := strings.TrimRight(string(line), "\r"); t == "---" || t == "..." {
			return src[next:], lineNo, src[first+1 : pos]
		}
		if end < 0 {
			break
		}
		pos = next
	}
	return src, 0, nil
}

func parseFrontmatter(doc *Document, fm []byte) {
	if fm == nil {
		return
	}
	var m map[string]any
	if err := yaml.Unmarshal(fm, &m); err != nil || m == nil {
		return
	}
	for k, v := range m {
		switch k {
		case "tags":
			for _, tag := range stringList(v) {
				name := strings.TrimPrefix(tag, "#")
				if isValidTag(name) {
					doc.Tags = append(doc.Tags, Tag{Line: frontmatterKeyLine(fm, "tags"), Name: name})
				}
			}
		case "aliases":
			doc.Aliases = append(doc.Aliases, stringList(v)...)
		case "cssclasses", "cssclass":
			// Ignored by design (D-01: no custom CSS).
		default:
			doc.Properties[k] = normalizeYAML(v)
		}
	}
}

// normalizeYAML maps YAML timestamps to the strings the TypeScript side sees:
// "2006-01-02" for plain dates, RFC 3339 when a time of day is present.
func normalizeYAML(v any) any {
	switch t := v.(type) {
	case time.Time:
		if t.Hour() == 0 && t.Minute() == 0 && t.Second() == 0 && t.Nanosecond() == 0 {
			return t.Format("2006-01-02")
		}
		return t.UTC().Format(time.RFC3339)
	case []any:
		out := make([]any, len(t))
		for i, e := range t {
			out[i] = normalizeYAML(e)
		}
		return out
	case map[string]any:
		out := make(map[string]any, len(t))
		for k, e := range t {
			out[k] = normalizeYAML(e)
		}
		return out
	}
	return v
}

func frontmatterKeyLine(fm []byte, key string) int {
	for i, l := range bytes.Split(fm, []byte("\n")) {
		if bytes.HasPrefix(bytes.TrimLeft(l, " "), []byte(key+":")) {
			return i + 2 // +1 for 1-based, +1 for the opening ---
		}
	}
	return 1
}

func stringList(v any) []string {
	switch t := v.(type) {
	case string:
		return strings.FieldsFunc(t, func(r rune) bool { return r == ',' || unicode.IsSpace(r) })
	case []any:
		var out []string
		for _, e := range t {
			if s, ok := e.(string); ok {
				out = append(out, s)
			}
		}
		return out
	}
	return nil
}

// --- inline scanner -------------------------------------------------------

var (
	wikilinkRe = regexp.MustCompile(`(!?)\[\[([^\[\]]+?)\]\]`)
	mdLinkRe   = regexp.MustCompile(`(!?)\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)`)
	tagRe      = regexp.MustCompile(`(^|[\s(\[{,;])#([\p{L}\p{N}_\-/]+)`)
	blockIDRe  = regexp.MustCompile(`\s\^([A-Za-z0-9\-]+)\s*$`)
	taskRe     = regexp.MustCompile(`^\s*(?:>\s*)*(?:[-*+]|\d+[.)])\s+\[(.)\]\s*(.*)$`)
	footnoteRe = regexp.MustCompile(`^\[\^([^\]]+)\]:`)
	urlRe      = regexp.MustCompile(`[A-Za-z][A-Za-z0-9+.\-]*://[^\s<>)]+`)
)

// scanLine extracts the inline elements of one line. clean is the line with
// code spans, comments and math blanked (same byte length); line is the raw
// text, used for list-level constructs; startedHidden marks a line that begins
// inside a comment or math block.
func scanLine(doc *Document, line, clean string, lineNo, base int, startedHidden bool) {
	type positioned struct {
		col  int
		link Link
	}
	var found []positioned
	for _, m := range wikilinkRe.FindAllStringSubmatchIndex(clean, -1) {
		if m[0] > 0 && clean[m[0]-1] == '\\' {
			continue // escaped: \[[not a link]]
		}
		l := parseWikilink(clean[m[4]:m[5]], m[3] > m[2], lineNo)
		l.Start, l.End = base+m[0], base+m[1]
		l.TargetStart, l.TargetEnd = wikiTargetSpan(clean, m[4], m[5], base)
		found = append(found, positioned{m[0], l})
	}
	// Blank out wikilinks keeping column positions, so Markdown links can be
	// located (and ordered) relative to them.
	noWiki := wikilinkRe.ReplaceAllStringFunc(clean, func(m string) string { return strings.Repeat(" ", len(m)) })
	for _, m := range mdLinkRe.FindAllStringSubmatchIndex(noWiki, -1) {
		target := noWiki[m[6]:m[7]]
		kind := LinkMarkdown
		if isExternal(target) {
			kind = LinkExternal
		}
		tEnd := m[7]
		if i := strings.IndexByte(target, '#'); i >= 0 {
			tEnd = m[6] + i
		}
		found = append(found, positioned{m[0], Link{
			Line: lineNo, Kind: kind, Target: target, Alias: noWiki[m[4]:m[5]], Embed: m[3] > m[2],
			Start: base + m[0], End: base + m[1], TargetStart: base + m[6], TargetEnd: base + tEnd,
		}})
	}
	sort.SliceStable(found, func(i, j int) bool { return found[i].col < found[j].col })
	for _, f := range found {
		doc.Links = append(doc.Links, f.link)
	}
	noURL := urlRe.ReplaceAllString(noWiki, " ")
	noURL = mdLinkRe.ReplaceAllString(noURL, " ")
	for _, m := range tagRe.FindAllStringSubmatch(noURL, -1) {
		if isValidTag(m[2]) {
			doc.Tags = append(doc.Tags, Tag{Line: lineNo, Name: m[2]})
		}
	}
	if m := blockIDRe.FindStringSubmatch(clean); m != nil {
		doc.BlockIDs = append(doc.BlockIDs, BlockID{Line: lineNo, ID: m[1]})
	}
	if startedHidden {
		return
	}
	if m := taskRe.FindStringSubmatch(line); m != nil {
		doc.Tasks = append(doc.Tasks, Task{Line: lineNo, State: m[1], Text: strings.TrimSpace(m[2])})
	}
	if m := footnoteRe.FindStringSubmatch(line); m != nil {
		doc.Footnotes = append(doc.Footnotes, m[1])
	}
	for range inlineFootnotes(clean) {
		inline := 1
		for _, f := range doc.Footnotes {
			if strings.HasPrefix(f, "^") {
				inline++
			}
		}
		doc.Footnotes = append(doc.Footnotes, "^"+strconv.Itoa(inline))
	}
}

// inlineFootnotes counts the inline footnotes ^[…] of a line whose code spans,
// comments and math are blanked. The brackets may nest (^[see [[Note]]]); an
// escaped \^[ and an unclosed one do not count. Inline footnotes have no label:
// the index names them ^1, ^2, … in document order, as they are numbered.
func inlineFootnotes(clean string) int {
	n := 0
	for i := 0; i+1 < len(clean); i++ {
		if clean[i] != '^' || clean[i+1] != '[' || (i > 0 && clean[i-1] == '\\') {
			continue
		}
		depth := 0
	scan:
		for j := i + 1; j < len(clean); j++ {
			switch clean[j] {
			case '[':
				depth++
			case ']':
				if depth--; depth == 0 {
					n++
					i = j
					break scan
				}
			}
		}
	}
	return n
}

var schemeRe = regexp.MustCompile(`^[A-Za-z][A-Za-z0-9+.\-]+:`)

// isExternal reports whether a Markdown link target is a URL (https://…,
// mailto:…) rather than a vault path; one-letter schemes are drive letters.
func isExternal(target string) bool { return schemeRe.MatchString(target) }

// maskBlocks blanks (keeping byte length) everything inside %%…%% comments and
// $$…$$ math, updating the states that carry over to the next line. An unclosed
// block runs to the end of the document.
func maskBlocks(s string, inMath, inComment *bool) string {
	b := []byte(s)
	p := 0
	for p < len(b) {
		switch {
		case *inComment || *inMath:
			delim := "%%"
			if *inMath {
				delim = "$$"
			}
			end := strings.Index(string(b[p:]), delim)
			if end < 0 {
				blank(b[p:])
				return string(b)
			}
			blank(b[p : p+end+2])
			p += end + 2
			*inComment, *inMath = false, false
		default:
			rest := string(b[p:])
			c, m := strings.Index(rest, "%%"), strings.Index(rest, "$$")
			if c < 0 && m < 0 {
				return string(b)
			}
			if m < 0 || (c >= 0 && c < m) {
				*inComment = true
				blank(b[p+c : p+c+2])
				p += c + 2
			} else {
				*inMath = true
				blank(b[p+m : p+m+2])
				p += m + 2
			}
		}
	}
	return string(b)
}

func blank(b []byte) {
	for i := range b {
		b[i] = ' '
	}
}

// wikiTargetSpan returns the absolute offsets of the trimmed target path
// inside a wikilink whose inner text spans clean[from:to].
func wikiTargetSpan(clean string, from, to, base int) (int, int) {
	end := to
	if i := strings.IndexAny(clean[from:to], "|#"); i >= 0 {
		end = from + i
	}
	start := from
	for start < end && (clean[start] == ' ' || clean[start] == '\t') {
		start++
	}
	for end > start && (clean[end-1] == ' ' || clean[end-1] == '\t') {
		end--
	}
	return base + start, base + end
}

func parseWikilink(inner string, embed bool, lineNo int) Link {
	l := Link{Line: lineNo, Kind: LinkWikilink, Embed: embed}
	target, alias, hasAlias := strings.Cut(inner, "|")
	if hasAlias {
		l.Alias = alias
	}
	if i := strings.Index(target, "#"); i >= 0 {
		frag := target[i+1:]
		target = target[:i]
		if strings.HasPrefix(frag, "^") {
			l.Block = frag[1:]
		} else {
			l.Heading = frag
		}
	}
	l.Target = strings.TrimSpace(target)
	return l
}

func stripInlineCode(s string) string {
	var b strings.Builder
	inCode := false
	for _, r := range s {
		// Keep byte length identical to the input so columns stay valid.
		if r == '`' {
			inCode = !inCode
			b.WriteByte(' ')
			continue
		}
		if inCode {
			b.WriteString(strings.Repeat(" ", utf8.RuneLen(r)))
		} else {
			b.WriteRune(r)
		}
	}
	return b.String()
}

// isValidTag applies Obsidian's rule: at least one non-numeric character.
func isValidTag(name string) bool {
	if name == "" {
		return false
	}
	for _, r := range name {
		if !unicode.IsDigit(r) && r != '/' && r != '-' && r != '_' {
			return true
		}
	}
	return false
}

// countWords counts whitespace-separated tokens that contain at least one
// letter or digit, so bare Markdown punctuation ("#", "---", "*") is not a
// word. The same rule is implemented by the TypeScript side (conformance).
func countWords(body []byte) int {
	n := 0
	for _, tok := range strings.FieldsFunc(string(body), unicode.IsSpace) {
		if strings.ContainsFunc(tok, func(r rune) bool { return unicode.IsLetter(r) || unicode.IsDigit(r) }) {
			n++
		}
	}
	return n
}

// ParseProperties returns only the frontmatter properties of a note (without
// the reserved tags/aliases/cssclasses keys). It is much cheaper than Parse
// and is what property filters use.
func ParseProperties(src []byte) map[string]any {
	_, _, fm := splitFrontmatter(src)
	doc := Document{Properties: map[string]any{}}
	parseFrontmatter(&doc, fm)
	return doc.Properties
}
