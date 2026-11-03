package links_test

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"memobrain/apps/desktop/internal/links"
)

// resolveFixture is shared/conformance/links/resolve.json.
type resolveFixture struct {
	Files []struct {
		Path    string   `json:"path"`
		Aliases []string `json:"aliases"`
	} `json:"files"`
	Cases []struct {
		Note     string `json:"note"`
		From     string `json:"from"`
		Target   string `json:"target"`
		Expected string `json:"expected"`
	} `json:"cases"`
}

// fixtureContent is what the fixture's file holds on disk: a note with its
// aliases in the frontmatter (as the Wails mock's test writes it too).
func fixtureContent(path string, aliases []string) string {
	if !strings.HasSuffix(path, ".md") {
		return "binary"
	}
	if len(aliases) == 0 {
		return "# note\n"
	}
	return "---\naliases: [" + strings.Join(aliases, ", ") + "]\n---\n# note\n"
}

// The link resolution of the core against the shared fixture, through the
// indexer (aliases read from the frontmatter): the Wails mock of the
// workbench runs the same cases (packages/workbench/src/test/wails-mock).
func TestResolveConformance(t *testing.T) {
	raw, err := os.ReadFile(filepath.Join("..", "..", "..", "..", "shared", "conformance", "links", "resolve.json"))
	if err != nil {
		t.Fatal(err)
	}
	var fx resolveFixture
	if err := json.Unmarshal(raw, &fx); err != nil {
		t.Fatal(err)
	}
	if len(fx.Cases) == 0 {
		t.Fatal("no cases")
	}
	files := map[string]string{}
	for _, f := range fx.Files {
		files[f.Path] = fixtureContent(f.Path, f.Aliases)
	}
	ix, ctx := setup(t, files)
	r, err := links.Load(ctx, ix.DB())
	if err != nil {
		t.Fatal(err)
	}
	for _, c := range fx.Cases {
		if got := r.Resolve(c.From, c.Target); got != c.Expected {
			t.Errorf("%s: [[%s]] in %s resolves to %q, want %q", c.Note, c.Target, c.From, got, c.Expected)
		}
	}
}
