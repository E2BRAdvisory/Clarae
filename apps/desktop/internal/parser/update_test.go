package parser

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"nodus/shared/conformance"
)

// TestUpdateFixtures writes the expectation of every fixture whose
// .expected.json is the placeholder "{}". Run with UPDATE_FIXTURES=1, then
// REVIEW the generated JSON by hand before committing: the expectation is
// the contract shared with the TypeScript parsers.
func TestUpdateFixtures(t *testing.T) {
	if os.Getenv("UPDATE_FIXTURES") == "" {
		t.Skip("set UPDATE_FIXTURES=1 to generate placeholder expectations")
	}
	dir, err := conformance.Dir("markdown")
	if err != nil {
		t.Fatal(err)
	}
	mds, _ := filepath.Glob(filepath.Join(dir, "*.md"))
	for _, md := range mds {
		name := strings.TrimSuffix(filepath.Base(md), ".md")
		expPath := filepath.Join(dir, name+".expected.json")
		cur, _ := os.ReadFile(expPath)
		if strings.TrimSpace(string(cur)) != "{}" {
			continue
		}
		src, err := os.ReadFile(md)
		if err != nil {
			t.Fatal(err)
		}
		out, _ := json.MarshalIndent(toExpected(Parse(name, src)), "", "  ")
		if err := os.WriteFile(expPath, append(out, '\n'), 0o644); err != nil {
			t.Fatal(err)
		}
	}
}
