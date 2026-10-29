package parser

import (
	"bytes"
	"regexp"
	"strings"
)

// Slides of a note (ADR-0027). The TypeScript twin is packages/markdown/src/slides.ts; both are
// checked against the fixtures in shared/conformance/slides. Nothing in the application calls this
// yet (the presentation runs in the frontend): it keeps the two parsers aligned, like the other
// fixtures.

// SlideConfig is the presentation configuration kept in the frontmatter (flat `slide-*` keys).
type SlideConfig struct {
	Transition string // none | fade | slide | zoom
	Theme      string // auto | light | dark
	Progress   bool
	Numbers    bool
	Notes      bool // show the speaker notes in the presenter view
}

// DefaultSlideConfig is the configuration of a note that sets nothing.
func DefaultSlideConfig() SlideConfig {
	return SlideConfig{Transition: "slide", Theme: "auto", Progress: true, Notes: true}
}

// Slide is one slide of a note.
type Slide struct {
	Line    int    // 1-based line (frontmatter included) of the first non-blank line
	Content string // Markdown, without surrounding blank lines and the speaker notes
	Notes   string // speaker notes (after a `Note:` line), trimmed
}

// SlideDeck is a note read as a presentation.
type SlideDeck struct {
	Config SlideConfig
	Slides []Slide
}

func oneOf(v any, allowed []string, fallback string) string {
	if s, ok := v.(string); ok {
		for _, a := range allowed {
			if s == a {
				return s
			}
		}
	}
	return fallback
}

func boolOr(v any, fallback bool) bool {
	if b, ok := v.(bool); ok {
		return b
	}
	return fallback
}

// ParseSlideConfig reads the `slide-*` frontmatter keys; invalid values fall back to the defaults.
func ParseSlideConfig(src []byte) SlideConfig {
	p := ParseProperties(src)
	d := DefaultSlideConfig()
	return SlideConfig{
		Transition: oneOf(p["slide-transition"], []string{"none", "fade", "slide", "zoom"}, d.Transition),
		Theme:      oneOf(p["slide-theme"], []string{"auto", "light", "dark"}, d.Theme),
		Progress:   boolOr(p["slide-progress"], d.Progress),
		Numbers:    boolOr(p["slide-numbers"], d.Numbers),
		Notes:      boolOr(p["slide-notes"], d.Notes),
	}
}

var (
	slideFenceOpen = regexp.MustCompile("^ {0,3}(`{3,}|~{3,})")
	slideSeparator = regexp.MustCompile(`^---[ \t]*$`)
	slideNotes     = regexp.MustCompile(`(?i)^note:[ \t]*(.*)$`)
)

type slideLine struct {
	n    int
	text string
}

type slideDraft struct {
	lines   []slideLine
	notes   []string
	inNotes bool
}

func (d *slideDraft) finish() (Slide, bool) {
	first := -1
	for i, l := range d.lines {
		if strings.TrimSpace(l.text) != "" {
			first = i
			break
		}
	}
	if first < 0 {
		return Slide{}, false // nothing to show
	}
	last := len(d.lines) - 1
	for strings.TrimSpace(d.lines[last].text) == "" {
		last--
	}
	parts := make([]string, 0, last-first+1)
	for _, l := range d.lines[first : last+1] {
		parts = append(parts, l.text)
	}
	return Slide{
		Line:    d.lines[first].n,
		Content: strings.Join(parts, "\n"),
		Notes:   strings.TrimSpace(strings.Join(d.notes, "\n")),
	}, true
}

// ParseSlides splits a note into slides and reads its configuration.
func ParseSlides(src []byte) SlideDeck {
	src = bytes.TrimPrefix(src, []byte("\xef\xbb\xbf"))
	body, offset, _ := splitFrontmatter(src)
	lines := strings.Split(string(body), "\n")
	for i := range lines {
		lines[i] = strings.TrimSuffix(lines[i], "\r")
	}

	deck := SlideDeck{Config: ParseSlideConfig(src), Slides: []Slide{}}
	cur := &slideDraft{}
	push := func() {
		if s, ok := cur.finish(); ok {
			deck.Slides = append(deck.Slides, s)
		}
		cur = &slideDraft{}
	}

	var fenceChar byte
	fenceLen := 0
	math := false
	for i, line := range lines {
		n := offset + i + 1
		switch {
		case fenceLen > 0:
			t := strings.TrimLeft(line, " ")
			if len(line)-len(t) <= 3 && closesFence(t, fenceChar, fenceLen) {
				fenceLen = 0
			}
		case math:
			if strings.TrimSpace(line) == "$$" {
				math = false
			}
		default:
			if m := slideFenceOpen.FindStringSubmatch(line); m != nil {
				fenceChar, fenceLen = m[1][0], len(m[1])
			} else if strings.TrimSpace(line) == "$$" {
				math = true
			} else if slideSeparator.MatchString(line) && (i == 0 || strings.TrimSpace(lines[i-1]) == "") {
				push()
				continue
			} else if m := slideNotes.FindStringSubmatch(line); m != nil && !cur.inNotes {
				cur.inNotes = true
				if m[1] != "" {
					cur.notes = append(cur.notes, m[1])
				}
				continue
			}
		}
		if cur.inNotes {
			cur.notes = append(cur.notes, line)
		} else {
			cur.lines = append(cur.lines, slideLine{n: n, text: line})
		}
	}
	push()
	return deck
}

// closesFence reports whether t (a line without its up-to-3 leading spaces) closes a fence opened
// with len copies of char: at least as many, and nothing else but trailing blanks.
func closesFence(t string, char byte, length int) bool {
	k := 0
	for k < len(t) && t[k] == char {
		k++
	}
	return k >= length && strings.TrimRight(t[k:], " \t") == ""
}
