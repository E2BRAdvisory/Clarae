package db

import (
	"slices"
	"testing"
)

// The order is the point: the name of 1.x first, then the current one, for every kind of lock.
// The names are the ones a pod of 1.4 takes (blobs.LockBlobHash, blobs.lockOwner, export.Service).
func TestAdvisoryLockKeysTakeTheOldNameFirst(t *testing.T) {
	for _, tc := range []struct {
		kind, id string
		want     []string
	}{
		{"blob", "abc", []string{"memobrain.blob:abc", "clarae.blob:abc"}},
		{"uploads", "0190-user", []string{"memobrain.uploads:0190-user", "clarae.uploads:0190-user"}},
		{"exports", "0190-user", []string{"memobrain.exports:0190-user", "clarae.exports:0190-user"}},
	} {
		if got := AdvisoryLockKeys(tc.kind, tc.id); !slices.Equal(got, tc.want) {
			t.Errorf("AdvisoryLockKeys(%q, %q) = %q, want %q", tc.kind, tc.id, got, tc.want)
		}
	}
}
