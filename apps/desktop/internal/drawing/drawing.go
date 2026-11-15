// Package drawing validates Excalidraw files (.excalidraw, plain JSON) and
// extracts what the indexer needs: the text of the elements (full-text search)
// and the links from elements to notes (graph and backlinks).
package drawing

import (
	"encoding/json"
	"errors"
	"fmt"
	"sort"
	"strings"

	"clarae/apps/desktop/internal/parser"
)

// MaxSize is the soft size limit of a drawing (§M3-WP1): the editor warns above it.
const MaxSize = 10 << 20

// MaxImageSize is the soft limit of one entry of `files` (the data URL of an image): the editor
// refuses larger images, so a bigger one comes from another tool and only earns a warning.
const MaxImageSize = 10 << 20

// Document is what the index keeps of a drawing.
type Document struct {
	// Text is the text of the live text elements (the typed text, without the line breaks of the
	// automatic wrapping), the frame names and the TeX of the formulas, one per line.
	Text string
	// Links are the [[wikilinks]] set on elements or written in their text.
	Links []parser.Link
	// Elements counts the live (not deleted) elements.
	Elements int
	// Warnings are problems that do not block saving: an image above MaxImageSize.
	Warnings []string
}

type element struct {
	ID   string `json:"id"`
	Type string `json:"type"`
	Text string `json:"text"`
	// OriginalText is what the user typed: Text has the line breaks of the automatic wrapping
	// added, so a word split across two lines would not be found in it.
	OriginalText string          `json:"originalText"`
	CustomData   json.RawMessage `json:"customData"` // the product's metadata sit in it (formulas)
	Name         string          `json:"name"`       // frames
	Link         string          `json:"link"`
	IsDeleted    bool            `json:"isDeleted"`
}

// typedText is the text of a text element as the user wrote it: originalText when there is one,
// else text (files written by tools that do not set it).
func (e element) typedText() string {
	if strings.TrimSpace(e.OriginalText) != "" {
		return e.OriginalText
	}
	return e.Text
}

// Keys of the product's metadata in an element's customData: the current one and the one of 1.x
// files (packages/workbench/src/drawing/meta.ts: the current key wins when both are there).
const (
	metaKey       = "clarae"
	legacyMetaKey = "memobrain"
	latexKind     = "latex"
)

// latex is the TeX source of a formula element (customData.<key>.kind == "latex"), "" when the
// element is not one. Mirrors latexOf in packages/workbench/src/drawing/latex/insert.ts.
func (e element) latex() string {
	if len(e.CustomData) == 0 {
		return ""
	}
	var cd map[string]json.RawMessage
	if json.Unmarshal(e.CustomData, &cd) != nil {
		return ""
	}
	var meta struct {
		Kind  string          `json:"kind"`
		Latex json.RawMessage `json:"latex"`
	}
	found := false
	for _, k := range []string{metaKey, legacyMetaKey} {
		raw, ok := cd[k]
		if !ok {
			continue
		}
		var probe map[string]json.RawMessage
		if json.Unmarshal(raw, &probe) != nil || probe == nil {
			continue // not an object: the reader falls through to the legacy key
		}
		_ = json.Unmarshal(raw, &meta) // a field of another type stays empty: not a formula
		found = true
		break
	}
	var tex string
	if !found || meta.Kind != latexKind || json.Unmarshal(meta.Latex, &tex) != nil {
		return ""
	}
	return strings.TrimSpace(tex)
}

type file struct {
	Type     string            `json:"type"`
	Elements []json.RawMessage `json:"elements"`
	AppState json.RawMessage   `json:"appState"`
	Files    json.RawMessage   `json:"files"`
}

// ErrInvalid wraps every validation failure.
var ErrInvalid = errors.New("invalid excalidraw file")

// Parse validates data and extracts its searchable content. An empty file is a
// valid, empty drawing (a newly created file).
func Parse(data []byte) (Document, error) {
	if strings.TrimSpace(string(data)) == "" {
		return Document{}, nil
	}
	var f file
	if err := json.Unmarshal(data, &f); err != nil {
		return Document{}, fmt.Errorf("%w: %w", ErrInvalid, err)
	}
	if f.Type != "" && f.Type != "excalidraw" {
		return Document{}, fmt.Errorf("%w: type is %q", ErrInvalid, f.Type)
	}
	if f.Elements == nil {
		return Document{}, fmt.Errorf("%w: no elements array", ErrInvalid)
	}
	var doc Document
	var texts, linkSrc []string
	seen := map[string]bool{}
	for i, raw := range f.Elements {
		var el element
		if err := json.Unmarshal(raw, &el); err != nil {
			return Document{}, fmt.Errorf("%w: element %d: %w", ErrInvalid, i, err)
		}
		if el.ID == "" || el.Type == "" {
			return Document{}, fmt.Errorf("%w: element %d has no id or type", ErrInvalid, i)
		}
		if seen[el.ID] {
			return Document{}, fmt.Errorf("%w: duplicate element id %q", ErrInvalid, el.ID)
		}
		seen[el.ID] = true
		if el.IsDeleted {
			continue
		}
		doc.Elements++
		if el.Type == "text" {
			if t := el.typedText(); strings.TrimSpace(t) != "" {
				texts = append(texts, t)
				linkSrc = append(linkSrc, t)
			}
		}
		// A formula is an image holding its TeX: searchable, but not a source of links.
		if tex := el.latex(); tex != "" {
			texts = append(texts, tex)
		}
		// A frame's name is its title on the canvas (and the slide name in a presentation).
		if (el.Type == "frame" || el.Type == "magicframe") && strings.TrimSpace(el.Name) != "" {
			texts = append(texts, el.Name)
		}
		if l := strings.TrimSpace(el.Link); strings.HasPrefix(l, "[[") {
			linkSrc = append(linkSrc, l)
		}
	}
	var files map[string]struct {
		DataURL string `json:"dataURL"`
	}
	if len(f.Files) > 0 && json.Unmarshal(f.Files, &files) == nil {
		for id, fl := range files {
			if len(fl.DataURL) > MaxImageSize {
				doc.Warnings = append(doc.Warnings, fmt.Sprintf("image %q is larger than %d MB", id, MaxImageSize>>20))
			}
		}
		sort.Strings(doc.Warnings)
	}
	doc.Text = strings.Join(texts, "\n")
	// The Markdown parser reads the wikilinks; each source gets its own line.
	parsed := parser.Parse("", []byte(strings.Join(linkSrc, "\n\n")))
	for _, l := range parsed.Links {
		if l.Kind == parser.LinkWikilink && l.Target != "" {
			doc.Links = append(doc.Links, l)
		}
	}
	return doc, nil
}
