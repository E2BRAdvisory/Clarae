package dataset

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestDeterministicAndRealistic(t *testing.T) {
	a, b := t.TempDir(), t.TempDir()
	ma, err := Generate(a, Config{Notes: 300, Seed: 5})
	if err != nil {
		t.Fatal(err)
	}
	mb, err := Generate(b, Config{Notes: 300, Seed: 5})
	if err != nil {
		t.Fatal(err)
	}
	if ma != mb {
		t.Fatalf("same seed, different manifests: %+v vs %+v", ma, mb)
	}
	var notes, withLinks, withTags int
	err = filepath.WalkDir(a, func(p string, d os.DirEntry, err error) error {
		if err != nil || d.IsDir() || !strings.HasSuffix(p, ".md") {
			return err
		}
		notes++
		rel, _ := filepath.Rel(a, p)
		other, err := os.ReadFile(filepath.Join(b, rel))
		if err != nil {
			return err
		}
		raw, _ := os.ReadFile(p)
		if string(raw) != string(other) {
			t.Errorf("%s differs between runs", rel)
		}
		s := string(raw)
		if strings.Contains(s, "[[") {
			withLinks++
		}
		if strings.Contains(s, "tags: [") || strings.Contains(s, " #") {
			withTags++
		}
		if !strings.HasPrefix(s, "---\n") || !strings.Contains(s, "\n# ") {
			t.Errorf("%s lacks frontmatter or heading", rel)
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	if notes != 300 || withLinks < 295 || withTags < 200 {
		t.Fatalf("notes=%d withLinks=%d withTags=%d", notes, withLinks, withTags)
	}
}

func TestEnsureReusesMatchingCache(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "v")
	m1, err := Ensure(dir, Config{Notes: 20, Seed: 1})
	if err != nil {
		t.Fatal(err)
	}
	marker := filepath.Join(dir, "marker")
	if err := os.WriteFile(marker, []byte("x"), 0o600); err != nil {
		t.Fatal(err)
	}
	if m2, err := Ensure(dir, Config{Notes: 20, Seed: 1}); err != nil || m2 != m1 {
		t.Fatalf("expected the cached vault: %+v %v", m2, err)
	}
	if _, err := os.Stat(marker); err != nil {
		t.Fatal("matching cache was regenerated")
	}
	if _, err := Ensure(dir, Config{Notes: 21, Seed: 1}); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(marker); err == nil {
		t.Fatal("changed parameters must regenerate the vault")
	}
}
