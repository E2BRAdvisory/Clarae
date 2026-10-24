// Package canvas validates JSON Canvas files (.canvas) and extracts what the
// indexer needs: node text (full-text search), links written in text nodes and
// the files embedded by file nodes (graph and backlinks).
package canvas

import (
	"encoding/json"
	"errors"
	"fmt"
	"strings"

	"nodus/apps/desktop/internal/parser"
)

// Node types of the JSON Canvas spec 1.0.
const (
	TypeText  = "text"
	TypeFile  = "file"
	TypeLink  = "link"
	TypeGroup = "group"
)

// Node is one canvas node.
type Node struct {
	ID      string  `json:"id"`
	Type    string  `json:"type"`
	X       float64 `json:"x"`
	Y       float64 `json:"y"`
	Width   float64 `json:"width"`
	Height  float64 `json:"height"`
	Color   string  `json:"color,omitempty"`
	Text    string  `json:"text,omitempty"`
	File    string  `json:"file,omitempty"`
	Subpath string  `json:"subpath,omitempty"`
	URL     string  `json:"url,omitempty"`
	Label   string  `json:"label,omitempty"`
}

// Edge connects two nodes.
type Edge struct {
	ID       string `json:"id"`
	FromNode string `json:"fromNode"`
	ToNode   string `json:"toNode"`
	Label    string `json:"label,omitempty"`
}

// Canvas is a parsed .canvas file.
type Canvas struct {
	Nodes []Node `json:"nodes"`
	Edges []Edge `json:"edges"`
}

// Document is what the index keeps of a canvas.
type Document struct {
	// Text is the searchable text: text nodes, group and edge labels, file names.
	Text  string
	Links []parser.Link
	Nodes int
}

// ErrInvalid wraps every validation failure.
var ErrInvalid = errors.New("invalid canvas file")

// Parse validates data and decodes it. An empty file is an empty canvas.
func Parse(data []byte) (Canvas, error) {
	if strings.TrimSpace(string(data)) == "" {
		return Canvas{}, nil
	}
	var c Canvas
	if err := json.Unmarshal(data, &c); err != nil {
		return Canvas{}, fmt.Errorf("%w: %w", ErrInvalid, err)
	}
	ids := map[string]bool{}
	for i, n := range c.Nodes {
		if n.ID == "" {
			return Canvas{}, fmt.Errorf("%w: node %d has no id", ErrInvalid, i)
		}
		if ids[n.ID] {
			return Canvas{}, fmt.Errorf("%w: duplicate id %q", ErrInvalid, n.ID)
		}
		ids[n.ID] = true
		switch n.Type {
		case TypeText, TypeGroup:
		case TypeFile:
			if n.File == "" {
				return Canvas{}, fmt.Errorf("%w: file node %q has no file", ErrInvalid, n.ID)
			}
		case TypeLink:
			if n.URL == "" {
				return Canvas{}, fmt.Errorf("%w: link node %q has no url", ErrInvalid, n.ID)
			}
		default:
			return Canvas{}, fmt.Errorf("%w: node %q has type %q", ErrInvalid, n.ID, n.Type)
		}
	}
	edgeIDs := map[string]bool{}
	for i, e := range c.Edges {
		if e.ID == "" {
			return Canvas{}, fmt.Errorf("%w: edge %d has no id", ErrInvalid, i)
		}
		if ids[e.ID] || edgeIDs[e.ID] {
			return Canvas{}, fmt.Errorf("%w: duplicate id %q", ErrInvalid, e.ID)
		}
		edgeIDs[e.ID] = true
		if !ids[e.FromNode] || !ids[e.ToNode] {
			return Canvas{}, fmt.Errorf("%w: edge %q points to a missing node", ErrInvalid, e.ID)
		}
	}
	return c, nil
}

// Extract validates data and returns its searchable content.
func Extract(data []byte) (Document, error) {
	c, err := Parse(data)
	if err != nil {
		return Document{}, err
	}
	var doc Document
	var text, md []string
	for _, n := range c.Nodes {
		doc.Nodes++
		switch n.Type {
		case TypeText:
			if strings.TrimSpace(n.Text) != "" {
				text = append(text, n.Text)
				md = append(md, n.Text)
			}
		case TypeGroup:
			if n.Label != "" {
				text = append(text, n.Label)
			}
		case TypeFile:
			// A file node is an embed of that file.
			md = append(md, "![["+n.File+headingOf(n.Subpath)+"]]")
			text = append(text, n.File)
		}
	}
	for _, e := range c.Edges {
		if e.Label != "" {
			text = append(text, e.Label)
		}
	}
	doc.Text = strings.Join(text, "\n")
	parsed := parser.Parse("", []byte(strings.Join(md, "\n\n")))
	for _, l := range parsed.Links {
		if l.Kind == parser.LinkWikilink && l.Target != "" {
			doc.Links = append(doc.Links, l)
		}
	}
	return doc, nil
}

// headingOf turns a JSON Canvas subpath ("#Heading" or "#^block") into the link fragment.
func headingOf(subpath string) string {
	if subpath == "" || subpath[0] != '#' {
		return ""
	}
	return subpath
}
