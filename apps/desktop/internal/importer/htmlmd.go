package importer

import (
	"regexp"
	"strconv"
	"strings"

	"golang.org/x/net/html"
	"golang.org/x/net/html/atom"
)

// htmlHooks lets a source customise the conversion (Evernote's en-media, en-crypt).
type htmlHooks struct {
	// Media renders an <en-media> element (returns "" to drop it).
	Media func(n *html.Node) string
	// Crypt is called for <en-crypt>; its result replaces the element.
	Crypt func() string
}

// htmlResult is the outcome of a conversion.
type htmlResult struct {
	Markdown string
	Title    string   // <title> of a full HTML page
	Dropped  []string // what was removed for safety: "script", "style", "iframe", "data-image", ...
}

const (
	maxHTMLBytes = 64 << 20
	maxHTMLDepth = 400
)

var selfClosingEN = regexp.MustCompile(`(?i)<(en-[a-z]+)([^<>]*?)/>`)

// htmlToMarkdown converts untrusted HTML to Markdown text. Nothing of the markup survives
// except what Markdown can express: scripts, styles, frames, objects, forms, event handlers
// and inline styles are dropped, javascript:/data: links are reduced to their text.
func htmlToMarkdown(src string, hooks htmlHooks) (htmlResult, error) {
	if len(src) > maxHTMLBytes {
		return htmlResult{}, ErrTooLarge
	}
	src = selfClosingEN.ReplaceAllString(src, "<$1$2></$1>")
	doc, err := html.Parse(strings.NewReader(src))
	if err != nil {
		return htmlResult{}, err
	}
	c := &conv{hooks: hooks}
	var body *html.Node
	var find func(n *html.Node)
	find = func(n *html.Node) {
		if n.Type == html.ElementNode {
			switch n.DataAtom {
			case atom.Title:
				if c.title == "" && n.FirstChild != nil {
					c.title = strings.TrimSpace(textOf(n))
				}
			case atom.Body:
				body = n
			}
		}
		for ch := n.FirstChild; ch != nil; ch = ch.NextSibling {
			find(ch)
		}
	}
	find(doc)
	if body == nil {
		body = doc
	}
	md := c.render(body, 0)
	return htmlResult{Markdown: tidy(md), Title: c.title, Dropped: c.dropped}, nil
}

type conv struct {
	hooks   htmlHooks
	title   string
	dropped []string
	inPre   bool
}

func (c *conv) drop(what string) { c.dropped = append(c.dropped, what) }

func attr(n *html.Node, key string) string {
	for _, a := range n.Attr {
		if strings.EqualFold(a.Key, key) {
			return a.Val
		}
	}
	return ""
}

func textOf(n *html.Node) string {
	var b strings.Builder
	var walk func(n *html.Node)
	walk = func(n *html.Node) {
		if n.Type == html.TextNode {
			b.WriteString(n.Data)
		}
		for ch := n.FirstChild; ch != nil; ch = ch.NextSibling {
			walk(ch)
		}
	}
	walk(n)
	return b.String()
}

var wsRun = regexp.MustCompile(`[ \t\r\n\f\x{a0}]+`)

func escapeInline(s string) string {
	r := strings.NewReplacer("\\", "\\\\", "*", "\\*", "[", "\\[", "]", "\\]", "`", "\\`", "<", "\\<")
	return r.Replace(s)
}

func (c *conv) children(n *html.Node, depth int) string {
	var b strings.Builder
	for ch := n.FirstChild; ch != nil; ch = ch.NextSibling {
		b.WriteString(c.render(ch, depth+1))
	}
	return b.String()
}

// wrap puts a marker around inline content, keeping surrounding spaces outside it.
func wrap(content, mark string) string {
	t := strings.TrimSpace(content)
	if t == "" || strings.Contains(t, "\n\n") {
		return content
	}
	lead := content[:len(content)-len(strings.TrimLeft(content, " \t"))]
	trail := content[len(strings.TrimRight(content, " \t")):]
	return lead + mark + t + mark + trail
}

func safeHref(h string) string {
	h = strings.TrimSpace(h)
	l := strings.ToLower(h)
	for _, bad := range []string{"javascript:", "vbscript:", "data:", "file:"} {
		if strings.HasPrefix(strings.Map(func(r rune) rune {
			if r < 0x20 {
				return -1
			}
			return r
		}, l), bad) {
			return ""
		}
	}
	return h
}

func linkDest(h string) string {
	h = strings.ReplaceAll(h, " ", "%20")
	h = strings.ReplaceAll(h, "(", "%28")
	h = strings.ReplaceAll(h, ")", "%29")
	return strings.ReplaceAll(strings.ReplaceAll(h, "<", "%3C"), ">", "%3E")
}

func (c *conv) render(n *html.Node, depth int) string {
	if depth > maxHTMLDepth {
		return escapeInline(wsRun.ReplaceAllString(textOf(n), " "))
	}
	switch n.Type {
	case html.TextNode:
		if c.inPre {
			return n.Data
		}
		return escapeInline(wsRun.ReplaceAllString(n.Data, " "))
	case html.DocumentNode:
		return c.children(n, depth)
	case html.ElementNode:
	default:
		return ""
	}

	tag := n.Data
	switch tag {
	case "script", "style", "iframe", "frame", "frameset", "object", "embed", "applet", "noscript", "template", "head", "svg", "math", "link", "meta", "base", "form", "audio", "video", "canvas":
		if tag != "head" && tag != "meta" && tag != "link" {
			c.drop(tag)
		}
		return ""
	case "h1", "h2", "h3", "h4", "h5", "h6":
		lvl := int(tag[1] - '0')
		t := strings.TrimSpace(oneLine(c.children(n, depth)))
		if t == "" {
			return ""
		}
		return "\n\n" + strings.Repeat("#", lvl) + " " + t + "\n\n"
	case "p", "div", "section", "article", "header", "footer", "main", "figure", "figcaption", "details", "summary", "address", "center", "nav", "aside", "dl", "dt", "dd", "body", "html":
		return "\n\n" + c.children(n, depth) + "\n\n"
	case "br":
		return "\\\n"
	case "hr":
		return "\n\n---\n\n"
	case "b", "strong":
		return wrap(c.children(n, depth), "**")
	case "i", "em", "cite", "dfn":
		return wrap(c.children(n, depth), "*")
	case "s", "strike", "del":
		return wrap(c.children(n, depth), "~~")
	case "mark":
		return wrap(c.children(n, depth), "==")
	case "code", "kbd", "tt", "samp":
		if c.inPre {
			return c.children(n, depth)
		}
		t := textOf(n)
		if strings.TrimSpace(t) == "" {
			return ""
		}
		t = strings.TrimSpace(wsRun.ReplaceAllString(t, " "))
		fence := "`"
		for strings.Contains(t, fence) {
			fence += "`"
		}
		if strings.HasPrefix(t, "`") || strings.HasSuffix(t, "`") {
			t = " " + t + " "
		}
		return fence + t + fence
	case "pre":
		old := c.inPre
		c.inPre = true
		code := strings.Trim(textOf(n), "\n")
		c.inPre = old
		lang := ""
		for ch := n.FirstChild; ch != nil; ch = ch.NextSibling {
			if ch.Type == html.ElementNode && ch.Data == "code" {
				for _, cls := range strings.Fields(attr(ch, "class")) {
					if strings.HasPrefix(cls, "language-") {
						lang = strings.TrimPrefix(cls, "language-")
					}
				}
			}
		}
		fence := "```"
		for strings.Contains(code, fence) {
			fence += "`"
		}
		return "\n\n" + fence + sanitizeLang(lang) + "\n" + code + "\n" + fence + "\n\n"
	case "a":
		text := strings.TrimSpace(c.children(n, depth))
		href := safeHref(attr(n, "href"))
		if href == "" {
			if h := attr(n, "href"); h != "" {
				c.drop("unsafe-link")
			}
			return text
		}
		if text == "" {
			text = escapeInline(href)
		}
		return "[" + oneLine(text) + "](" + linkDest(href) + ")"
	case "img":
		src := strings.TrimSpace(attr(n, "src"))
		if src == "" {
			return ""
		}
		if safeHref(src) == "" {
			c.drop("data-image")
			return ""
		}
		alt := strings.NewReplacer("[", "", "]", "", "\n", " ").Replace(attr(n, "alt"))
		return "![" + alt + "](" + linkDest(src) + ")"
	case "ul", "ol":
		return "\n\n" + c.list(n, depth) + "\n\n"
	case "li":
		return "\n" + c.children(n, depth) + "\n"
	case "blockquote":
		inner := strings.TrimSpace(tidy(c.children(n, depth)))
		if inner == "" {
			return ""
		}
		lines := strings.Split(inner, "\n")
		for i, l := range lines {
			lines[i] = strings.TrimRight("> "+l, " ")
		}
		return "\n\n" + strings.Join(lines, "\n") + "\n\n"
	case "table":
		return "\n\n" + c.table(n, depth) + "\n\n"
	case "input":
		if strings.EqualFold(attr(n, "type"), "checkbox") {
			if hasAttr(n, "checked") {
				return "[x] "
			}
			return "[ ] "
		}
		return ""
	case "en-todo":
		mark := "- [ ] "
		if strings.EqualFold(attr(n, "checked"), "true") {
			mark = "- [x] "
		}
		return mark + c.children(n, depth)
	case "en-media":
		if c.hooks.Media != nil {
			return c.hooks.Media(n) + c.children(n, depth)
		}
		return c.children(n, depth)
	case "en-crypt":
		if c.hooks.Crypt != nil {
			return "\n\n" + c.hooks.Crypt() + "\n\n"
		}
		return ""
	}
	return c.children(n, depth)
}

func hasAttr(n *html.Node, key string) bool {
	for _, a := range n.Attr {
		if strings.EqualFold(a.Key, key) {
			return true
		}
	}
	return false
}

var langRe = regexp.MustCompile(`^[A-Za-z0-9_+#.-]{1,30}$`)

func sanitizeLang(l string) string {
	if langRe.MatchString(l) {
		return l
	}
	return ""
}

func (c *conv) list(n *html.Node, depth int) string {
	ordered := n.Data == "ol"
	idx := 1
	var out []string
	for li := n.FirstChild; li != nil; li = li.NextSibling {
		if li.Type != html.ElementNode || li.Data != "li" {
			continue
		}
		content := strings.TrimSpace(tidy(c.children(li, depth)))
		marker := "- "
		if ordered {
			marker = strconv.Itoa(idx) + ". "
			idx++
		}
		if strings.HasPrefix(content, "- [ ] ") || strings.HasPrefix(content, "- [x] ") {
			content = content[2:] // a checkbox item: "- [ ] text"
		}
		lines := strings.Split(content, "\n")
		pad := strings.Repeat(" ", len(marker))
		for i := 1; i < len(lines); i++ {
			if lines[i] != "" {
				lines[i] = pad + lines[i]
			}
		}
		out = append(out, marker+strings.Join(lines, "\n"))
	}
	return strings.Join(out, "\n")
}

func oneLine(s string) string {
	return strings.ReplaceAll(strings.ReplaceAll(s, "\\\n", " "), "\n", " ")
}

func (c *conv) table(n *html.Node, depth int) string {
	var rows [][]string
	var walk func(n *html.Node)
	walk = func(n *html.Node) {
		for ch := n.FirstChild; ch != nil; ch = ch.NextSibling {
			if ch.Type != html.ElementNode {
				continue
			}
			switch ch.Data {
			case "tr":
				var cells []string
				for td := ch.FirstChild; td != nil; td = td.NextSibling {
					if td.Type == html.ElementNode && (td.Data == "td" || td.Data == "th") {
						t := strings.TrimSpace(tidy(c.children(td, depth)))
						t = strings.ReplaceAll(oneLine(t), "|", "\\|")
						cells = append(cells, t)
					}
				}
				if len(cells) > 0 {
					rows = append(rows, cells)
				}
			case "thead", "tbody", "tfoot":
				walk(ch)
			}
		}
	}
	walk(n)
	if len(rows) == 0 {
		return ""
	}
	cols := 0
	for _, r := range rows {
		cols = max(cols, len(r))
	}
	line := func(r []string) string {
		for len(r) < cols {
			r = append(r, "")
		}
		return "| " + strings.Join(r, " | ") + " |"
	}
	var b strings.Builder
	b.WriteString(line(rows[0]) + "\n")
	b.WriteString("|" + strings.Repeat(" --- |", cols) + "\n")
	for _, r := range rows[1:] {
		b.WriteString(line(r) + "\n")
	}
	return strings.TrimRight(b.String(), "\n")
}

var (
	multiBlank = regexp.MustCompile(`\n{3,}`)
	trailBreak = regexp.MustCompile(`([^\\])\\(\n\n|$)`)
	taskGap    = regexp.MustCompile(`(?m)^(- \[[ x]\] [^\n]*)\n\n(- \[[ x]\] )`)
)

// tidy normalises the blank lines and trailing spaces of generated Markdown.
func tidy(md string) string {
	lines := strings.Split(md, "\n")
	inFence := false
	fence := ""
	for i, l := range lines {
		l = strings.TrimRight(l, " \t")
		if l == "" {
			lines[i] = ""
			continue
		}
		if inFence {
			if strings.HasPrefix(l, fence) && strings.Trim(l, "`") == "" {
				inFence = false
			}
			lines[i] = l
			continue
		}
		if t := strings.TrimLeft(l, " "); strings.HasPrefix(t, "```") {
			inFence = true
			fence = t[:len(t)-len(strings.TrimLeft(t, "`"))]
			lines[i] = l
			continue
		}
		lines[i] = l
	}
	out := strings.Join(lines, "\n")
	out = multiBlank.ReplaceAllString(out, "\n\n")
	out = trailBreak.ReplaceAllString(out, "$1$2")
	for taskGap.MatchString(out) {
		out = taskGap.ReplaceAllString(out, "$1\n$2")
	}
	return strings.Trim(out, "\n")
}
