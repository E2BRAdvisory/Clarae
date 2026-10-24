package importer

import (
	"net/url"
	"path"
	"regexp"
	"strings"
)

// A resolved link target: where the file ended up in the vault.
type target struct {
	Dest       string // vault path
	Attachment bool
}

// rewriter rewrites relative Markdown links and embeds of imported notes so they point at
// the files' new locations, as [[wikilinks]] or as fixed Markdown links.
type rewriter struct {
	// lookup resolves a decoded path relative to the source tree root (already joined with the
	// directory of the linking file) to the imported file.
	lookup  func(srcPath string) (target, bool)
	useWiki bool
	// names counts imported files per lower-cased wikilink name, to decide when the short
	// name is unambiguous.
	names map[string]int

	rewritten  int
	unresolved []string
	unresCount int
}

func newRewriter(useWiki bool, lookup func(string) (target, bool)) *rewriter {
	return &rewriter{lookup: lookup, useWiki: useWiki, names: map[string]int{}}
}

// register records an imported file so short wikilink names can be checked for ambiguity.
func (rw *rewriter) register(dest string, attachment bool) {
	rw.names[strings.ToLower(wikiName(dest, attachment, false))]++
}

func wikiName(dest string, attachment, full bool) string {
	name := dest
	if !attachment {
		name = strings.TrimSuffix(dest, path.Ext(dest))
	}
	if full {
		return name
	}
	return path.Base(name)
}

var (
	linkRe   = regexp.MustCompile("(!?)\\[([^\\]\\n]*)\\]\\((<[^>\\n]*>|[^()\\s]*(?:\\([^()\\s]*\\)[^()\\s]*)*)(?:\\s+(?:\"[^\"]*\"|'[^']*'))?\\)")
	schemeRe = regexp.MustCompile(`^(?i:[a-z][a-z0-9+.-]*:|//)`)
	codeSpan = regexp.MustCompile("`{2,}[\\s\\S]*?`{2,}|`[^`\\n]+`")
)

// rewrite fixes the links of one note. fromSrc is the source path of the note (for resolving
// relative links), destNote its final vault path.
func (rw *rewriter) rewrite(md, fromSrc, destNote string) string {
	return mapOutsideCode(md, func(seg string) string {
		return linkRe.ReplaceAllStringFunc(seg, func(m string) string {
			sm := linkRe.FindStringSubmatch(m)
			bang, text, dest := sm[1], sm[2], sm[3]
			dest = strings.TrimSuffix(strings.TrimPrefix(dest, "<"), ">")
			if dest == "" || strings.HasPrefix(dest, "#") || schemeRe.MatchString(dest) {
				return m
			}
			p, anchor := dest, ""
			if i := strings.IndexByte(p, '#'); i >= 0 {
				p, anchor = p[:i], p[i+1:]
			}
			if i := strings.IndexByte(p, '?'); i >= 0 {
				p = p[:i]
			}
			if dec, err := url.PathUnescape(p); err == nil {
				p = dec
			}
			if dec, err := url.PathUnescape(anchor); err == nil {
				anchor = dec
			}
			abs := path.Clean(path.Join(path.Dir(fromSrc), p))
			if p == "" || strings.HasPrefix(abs, "../") || abs == ".." {
				return m
			}
			t, ok := rw.lookup(abs)
			if !ok {
				rw.unresCount++
				if len(rw.unresolved) < 20 {
					rw.unresolved = append(rw.unresolved, dest)
				}
				return m
			}
			rw.rewritten++
			if rw.useWiki {
				return rw.wiki(bang == "!", text, anchor, t)
			}
			rel := escapePath(relPath(path.Dir(destNote), t.Dest))
			if anchor != "" {
				rel += "#" + url.PathEscape(anchor)
			}
			return bang + "[" + text + "](" + rel + ")"
		})
	})
}

// linkTo renders a link from the note at fromDest to t, for notes the importer generates.
func (rw *rewriter) linkTo(fromDest string, t target, text string) string {
	if rw.useWiki {
		return rw.wiki(false, text, "", t)
	}
	return "[" + text + "](" + escapePath(relPath(path.Dir(fromDest), t.Dest)) + ")"
}

func (rw *rewriter) wiki(embed bool, text, anchor string, t target) string {
	name := wikiName(t.Dest, t.Attachment, false)
	if rw.names[strings.ToLower(name)] > 1 {
		name = wikiName(t.Dest, t.Attachment, true)
	}
	ref := name
	if anchor != "" && !t.Attachment {
		ref += "#" + anchor
	}
	if embed {
		return "![[" + ref + "]]"
	}
	if text != "" && text != name && text != ref {
		ref += "|" + strings.NewReplacer("[", "", "]", "", "|", "-").Replace(text)
	}
	return "[[" + ref + "]]"
}

// mapOutsideCode applies fn to the parts of md that are neither fenced code nor inline code.
func mapOutsideCode(md string, fn func(string) string) string {
	var parts, cur []string
	flush := func() {
		if len(cur) > 0 {
			parts = append(parts, mapInline(strings.Join(cur, "\n"), fn))
			cur = nil
		}
	}
	inFence := false
	fence := ""
	for _, l := range strings.Split(md, "\n") {
		t := strings.TrimLeft(l, " ")
		switch {
		case inFence:
			parts = append(parts, l)
			if strings.HasPrefix(t, fence) && strings.Trim(t, fence[:1]) == "" {
				inFence = false
			}
		case strings.HasPrefix(t, "```") || strings.HasPrefix(t, "~~~"):
			flush()
			inFence = true
			fence = t[:len(t)-len(strings.TrimLeft(t, t[:1]))]
			parts = append(parts, l)
		default:
			cur = append(cur, l)
		}
	}
	flush()
	return strings.Join(parts, "\n")
}

func mapInline(text string, fn func(string) string) string {
	var b strings.Builder
	last := 0
	for _, loc := range codeSpan.FindAllStringIndex(text, -1) {
		b.WriteString(fn(text[last:loc[0]]))
		b.WriteString(text[loc[0]:loc[1]])
		last = loc[1]
	}
	b.WriteString(fn(text[last:]))
	return b.String()
}
