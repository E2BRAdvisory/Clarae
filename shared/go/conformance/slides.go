package conformance

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
)

// ExpectedSlideConfig is the slides configuration read from the frontmatter (ADR-0027).
type ExpectedSlideConfig struct {
	Transition string `json:"transition"`
	Theme      string `json:"theme"`
	Progress   bool   `json:"progress"`
	Numbers    bool   `json:"numbers"`
	Notes      bool   `json:"notes"`
}

// ExpectedSlide is one slide: the 1-based file line of its first non-blank
// line, its Markdown and its speaker notes.
type ExpectedSlide struct {
	Line    int    `json:"line"`
	Content string `json:"content"`
	Notes   string `json:"notes"`
}

// ExpectedSlides is the content of a slides <case>.expected.json fixture.
type ExpectedSlides struct {
	Config ExpectedSlideConfig `json:"config"`
	Slides []ExpectedSlide     `json:"slides"`
}

// SlideCase pairs an input note with its expected slides.
type SlideCase struct {
	Name     string
	Source   []byte
	Expected ExpectedSlides
}

// LoadSlideCases reads every <case>.md with its <case>.expected.json from dir
// (shared/conformance/slides), sorted by name.
func LoadSlideCases(dir string) ([]SlideCase, error) {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return nil, err
	}
	var cases []SlideCase
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
		var exp ExpectedSlides
		dec := json.NewDecoder(strings.NewReader(string(raw)))
		dec.DisallowUnknownFields()
		if err := dec.Decode(&exp); err != nil {
			return nil, fmt.Errorf("fixture %s: %w", expPath, err)
		}
		if exp.Slides == nil {
			return nil, fmt.Errorf("fixture %s: slides is required (use [])", expPath)
		}
		for _, s := range exp.Slides {
			if s.Line < 1 || s.Content == "" {
				return nil, fmt.Errorf("fixture %s: invalid slide %+v", expPath, s)
			}
		}
		cases = append(cases, SlideCase{Name: caseName, Source: src, Expected: exp})
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
