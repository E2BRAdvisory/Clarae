package parity

import (
	"regexp"
	"testing"
)

func TestFeatureIDsAreWellFormedAndUnique(t *testing.T) {
	if len(Features) == 0 {
		t.Fatal("no features: run `task gen`")
	}
	valid := regexp.MustCompile(`^[a-z0-9-]+(\.[a-z0-9-]+)*$`)
	seen := map[FeatureID]bool{}
	for _, f := range Features {
		if !valid.MatchString(string(f)) {
			t.Errorf("%q is not a valid feature id", f)
		}
		if seen[f] {
			t.Errorf("%q is listed twice", f)
		}
		seen[f] = true
	}
	if !seen[VaultCreate] {
		t.Errorf("%q is missing from Features", VaultCreate)
	}
}
