// Package conformance loads the shared fixtures in shared/conformance so that
// the Go parser (and, later, merge and crypto) can be checked against the
// same expectations as the TypeScript side. See shared/conformance/README.md
// for the fixture format.
package conformance

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
)

// Expected is the content of a <case>.expected.json Markdown fixture.
type Expected struct {
	Title      string            `json:"title"`
	Aliases    []string          `json:"aliases"`
	Properties map[string]any    `json:"properties"`
	Headings   []ExpectedHeading `json:"headings"`
	Links      []ExpectedLink    `json:"links"`
	Tags       []ExpectedTag     `json:"tags"`
	BlockIDs   []ExpectedBlockID `json:"blockIds"`
	Tasks      []ExpectedTask    `json:"tasks"`
	Footnotes  []string          `json:"footnotes"`
	WordCount  int               `json:"wordCount"`
}

// ExpectedHeading is one heading.
type ExpectedHeading struct {
	Level int    `json:"level"`
	Text  string `json:"text"`
	Line  int    `json:"line"`
}

// LinkKind distinguishes link syntaxes.
type LinkKind string

// Link kinds.
const (
	LinkWikilink LinkKind = "wikilink"
	LinkMarkdown LinkKind = "markdown"
	LinkExternal LinkKind = "external"
)

// ExpectedLink is one link or embed.
type ExpectedLink struct {
	Line    int      `json:"line"`
	Kind    LinkKind `json:"kind"`
	Target  string   `json:"target"`
	Heading string   `json:"heading"`
	Block   string   `json:"block"`
	Alias   string   `json:"alias"`
	Embed   bool     `json:"embed"`
}

// ExpectedTag is one tag occurrence (name without '#').
type ExpectedTag struct {
	Line int    `json:"line"`
	Name string `json:"name"`
}

// ExpectedBlockID is one ^id definition.
type ExpectedBlockID struct {
	Line int    `json:"line"`
	ID   string `json:"id"`
}

// ExpectedTask is one task list item.
type ExpectedTask struct {
	Line  int    `json:"line"`
	State string `json:"state"`
	Text  string `json:"text"`
}

// MarkdownCase pairs an input document with its expectation.
type MarkdownCase struct {
	Name     string
	Source   []byte
	Expected Expected
}

// LoadMarkdownCases reads every <case>.md with its <case>.expected.json from
// dir, sorted by name. A .md without expectation, or vice versa, is an error.
func LoadMarkdownCases(dir string) ([]MarkdownCase, error) {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return nil, err
	}
	var cases []MarkdownCase
	seen := map[string]bool{}
	for _, e := range entries {
		name := e.Name()
		if e.IsDir() || !strings.HasSuffix(name, ".md") {
			continue
		}
		caseName := strings.TrimSuffix(name, ".md")
		seen[caseName] = true
		src, err := os.ReadFile(filepath.Join(dir, name))
		if err != nil {
			return nil, err
		}
		expPath := filepath.Join(dir, caseName+".expected.json")
		raw, err := os.ReadFile(expPath)
		if err != nil {
			return nil, fmt.Errorf("fixture %s has no expectation: %w", caseName, err)
		}
		var exp Expected
		dec := json.NewDecoder(strings.NewReader(string(raw)))
		dec.DisallowUnknownFields()
		if err := dec.Decode(&exp); err != nil {
			return nil, fmt.Errorf("fixture %s: %w", expPath, err)
		}
		if err := exp.check(caseName); err != nil {
			return nil, fmt.Errorf("fixture %s: %w", expPath, err)
		}
		cases = append(cases, MarkdownCase{Name: caseName, Source: src, Expected: exp})
	}
	for _, e := range entries {
		name := e.Name()
		if strings.HasSuffix(name, ".expected.json") && !seen[strings.TrimSuffix(name, ".expected.json")] {
			return nil, fmt.Errorf("expectation %s has no .md input", name)
		}
	}
	sort.Slice(cases, func(i, j int) bool { return cases[i].Name < cases[j].Name })
	return cases, nil
}

// check enforces the structural rules of README.md so that a malformed
// fixture fails loudly instead of silently passing or failing a parser.
func (e Expected) check(caseName string) error {
	if e.Title != caseName {
		return fmt.Errorf("title %q must equal the case name %q", e.Title, caseName)
	}
	if e.Aliases == nil || e.Properties == nil || e.Headings == nil || e.Links == nil ||
		e.Tags == nil || e.BlockIDs == nil || e.Tasks == nil || e.Footnotes == nil {
		return fmt.Errorf("every list/object field is required (use [] or {})")
	}
	for _, h := range e.Headings {
		if h.Level < 1 || h.Level > 6 || h.Line < 1 || h.Text == "" {
			return fmt.Errorf("invalid heading %+v", h)
		}
	}
	for _, l := range e.Links {
		switch l.Kind {
		case LinkWikilink, LinkMarkdown, LinkExternal:
		default:
			return fmt.Errorf("invalid link kind %q", l.Kind)
		}
		if l.Line < 1 || (l.Target == "" && l.Heading == "" && l.Block == "") {
			return fmt.Errorf("invalid link %+v", l)
		}
	}
	for _, t := range e.Tags {
		if t.Line < 1 || t.Name == "" || strings.HasPrefix(t.Name, "#") {
			return fmt.Errorf("invalid tag %+v", t)
		}
	}
	for _, b := range e.BlockIDs {
		if b.Line < 1 || b.ID == "" {
			return fmt.Errorf("invalid block id %+v", b)
		}
	}
	for _, t := range e.Tasks {
		if t.Line < 1 || len(t.State) != 1 {
			return fmt.Errorf("invalid task %+v", t)
		}
	}
	if e.WordCount < 0 {
		return fmt.Errorf("negative word count")
	}
	return nil
}

// Dir returns the absolute path of a subdirectory of shared/conformance,
// resolved relative to this source file's module (shared/go). It lets tests
// in any module find the fixtures without hard-coding relative depths.
func Dir(sub string) (string, error) {
	root, err := repoRoot()
	if err != nil {
		return "", err
	}
	return filepath.Join(root, "shared", "conformance", sub), nil
}

// repoRoot walks up from the working directory until it finds go.work.
func repoRoot() (string, error) {
	dir, err := os.Getwd()
	if err != nil {
		return "", err
	}
	for {
		if _, err := os.Stat(filepath.Join(dir, "go.work")); err == nil {
			return dir, nil
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			return "", fmt.Errorf("go.work not found above %s", dir)
		}
		dir = parent
	}
}
