package config

import (
	"os"
	"regexp"
	"strings"
	"testing"
)

// TestEveryEnvVarIsDocumented fails when config.go reads an environment variable that the
// administrator guide does not list: the documentation is part of the contract.
func TestEveryEnvVarIsDocumented(t *testing.T) {
	src, err := os.ReadFile("config.go")
	if err != nil {
		t.Fatal(err)
	}
	doc, err := os.ReadFile("../../../../docs/admin-guide/configurazione.md")
	if err != nil {
		t.Fatalf("administrator guide missing: %v", err)
	}
	re := regexp.MustCompile(`\benv(?:Bool|Duration|List)?\("([A-Z][A-Z0-9_]+)"`)
	seen := map[string]bool{}
	for _, m := range re.FindAllStringSubmatch(string(src), -1) {
		seen[m[1]] = true
	}
	if len(seen) < 20 {
		t.Fatalf("expected to find the environment variables in config.go, found %d", len(seen))
	}
	for name := range seen {
		if !strings.Contains(string(doc), "`"+name+"`") {
			t.Errorf("environment variable %s is not documented in docs/admin-guide/configurazione.md", name)
		}
	}
}
