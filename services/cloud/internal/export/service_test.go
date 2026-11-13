package export

import (
	"errors"
	"fmt"
	"strings"
	"testing"

	"github.com/google/uuid"

	"clarae/services/cloud/internal/httpproblem"
	"clarae/services/cloud/internal/storage"
	"clarae/shared/syncproto"
)

func TestSkippedLeavesOutDeviceSpecificFiles(t *testing.T) {
	for p, want := range map[string]bool{
		"Notes/a.md":               false,
		".clarae/editor.json":      false, // user settings are part of the vault
		".clarae/workspace.json":   true,
		".clarae/index.db":         true,
		".clarae/cache/x.svg":      true,
		".clarae/snapshots/1/a.md": true,
		"Notes/.DS_Store":          true,
		"Notes/.clarae/cache/x":    false,
	} {
		if got := skipped(p); got != want {
			t.Errorf("skipped(%q) = %v, want %v", p, got, want)
		}
	}
}

// The error stored in a failed job is shown to the client: it never carries
// the internal error text (endpoints, paths, SQL).
func TestFailureHidesTheInternalError(t *testing.T) {
	internal := errors.New(`Put "https://minio.internal:9000/clarae-exports/exports/x.zip": dial tcp 10.0.3.7:9000: connection refused`)
	for err, want := range map[error]string{
		internal:     failedBuild,
		errVaultGone: failedVaultGone,
		fmt.Errorf("export Notes/a.md: %w", storage.ErrNotFound): failedMissing,
	} {
		got := failure(err)
		if got != want || strings.Contains(got, "minio") {
			t.Errorf("failure(%v) = %q, want %q", err, got, want)
		}
	}
}

// A user has at most limit direct streams open on a node; each release
// frees one slot, once.
func TestAcquireStreamBoundsTheStreamsOfAUser(t *testing.T) {
	s := &Service{}
	ada, bob := uuid.New(), uuid.New()
	r1, err := s.acquireStream(ada, 2)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := s.acquireStream(ada, 2); err != nil {
		t.Fatal(err)
	}
	_, err = s.acquireStream(ada, 2)
	var pe *httpproblem.Error
	if !errors.As(err, &pe) || pe.Code != syncproto.CodeRateLimited || pe.Extra["active_streams"] != 2 {
		t.Fatalf("third stream: %v, want RATE_LIMITED", err)
	}
	if _, err := s.acquireStream(bob, 2); err != nil {
		t.Fatalf("another user is not limited by ada's streams: %v", err)
	}
	r1()
	r1() // a second release does not free another slot
	if _, err := s.acquireStream(ada, 2); err != nil {
		t.Fatalf("after a release: %v", err)
	}
	if _, err := s.acquireStream(ada, 2); err == nil {
		t.Fatal("a double release freed two slots")
	}
}
