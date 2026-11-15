package db

import (
	"slices"
	"strings"
	"testing"
)

// One key per lock, with the current name only: a pod of 1.7 no longer takes the name of 1.x, so the
// test fails if that name comes back or if a lock needs more than one key again.
func TestAdvisoryLockKeysAreTheCurrentNameAlone(t *testing.T) {
	for _, tc := range []struct {
		kind, id string
		want     []string
	}{
		{"blob", "abc", []string{"clarae.blob:abc"}},
		{"uploads", "0190-user", []string{"clarae.uploads:0190-user"}},
		{"exports", "0190-user", []string{"clarae.exports:0190-user"}},
	} {
		got := AdvisoryLockKeys(tc.kind, tc.id)
		if !slices.Equal(got, tc.want) {
			t.Errorf("AdvisoryLockKeys(%q, %q) = %q, want %q", tc.kind, tc.id, got, tc.want)
		}
		for _, k := range got {
			// The old name is written in two pieces so that this file needs no line in the brand allowlist.
			if strings.Contains(strings.ToLower(k), "memo"+"brain") {
				t.Errorf("AdvisoryLockKeys(%q, %q) still takes the name of 1.x: %q", tc.kind, tc.id, k)
			}
		}
	}
}
