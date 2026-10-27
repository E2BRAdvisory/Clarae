// Package drawing validates Excalidraw files (.excalidraw, plain JSON) and
// extracts what the indexer needs: the text of the elements (full-text search)
// and the links from elements to notes (graph and backlinks).
package drawing

import (
	"encoding/json"
	"errors"
	"fmt"
	"strings"

	"memobrain/apps/desktop/internal/parser"
)

// MaxSize is the soft size limit of a drawing (§M3-WP1): the editor warns above it.
const MaxSize = 10 << 20

// Document is what the index keeps of a drawing.
type Document struct {
	// Text is the text of the live text elements, one per line.
	Text string
	// Links are the [[wikilinks]] set on elements or written in their text.
	Links []parser.Link
	// Elements counts the live (not deleted) elements.
	Elements int
}

type element struct {
	ID        string `json:"id"`
	Type      string `json:"type"`
	Text      string `json:"text"`
	Link      string `json:"link"`
	IsDeleted bool   `json:"isDeleted"`
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
		if el.Type == "text" && strings.TrimSpace(el.Text) != "" {
			texts = append(texts, el.Text)
			linkSrc = append(linkSrc, el.Text)
		}
		if l := strings.TrimSpace(el.Link); strings.HasPrefix(l, "[[") {
			linkSrc = append(linkSrc, l)
		}
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
