package sync

import (
	"context"
	"testing"
)

// The verdict on removing a copy: it scans first (a change no cycle has seen
// counts), works on a locked private vault, and an unlinked folder is never
// vouched for.
func TestCopyVerdict(t *testing.T) {
	ctx := context.Background()
	f := newLockFixture(t)
	got, err := f.m.CopyVerdict(ctx, lockLocal)
	if want := (CopyVerdict{Removable: true, Reason: CopyClean}); err != nil || got != want {
		t.Fatalf("synced copy: %+v %v, want %+v", got, err, want)
	}

	// Paused: no cycle scans the new file, the verdict does.
	if err := f.m.SetPaused(ctx, lockLocal, true); err != nil {
		t.Fatal(err)
	}
	writeFile(t, f.dir, "note.md", []byte("not uploaded"))
	got, err = f.m.CopyVerdict(ctx, lockLocal)
	if want := (CopyVerdict{Reason: CopyPending, Pending: 1}); err != nil || got != want {
		t.Fatalf("unscanned change: %+v %v, want %+v", got, err, want)
	}
	if st := engineOfVault(t, f.m, lockLocal).Status(); st.Pending != 1 {
		t.Fatalf("the status does not follow the scan: %+v", st)
	}

	// Locked: the scan needs no key, the change is still there.
	if err := f.m.LockVault(ctx, lockLocal); err != nil {
		t.Fatal(err)
	}
	got, err = f.m.CopyVerdict(ctx, lockLocal)
	if want := (CopyVerdict{Reason: CopyPending, Pending: 1}); err != nil || got != want {
		t.Fatalf("locked copy: %+v %v, want %+v", got, err, want)
	}

	if err := f.m.Unlink(ctx, lockLocal); err != nil {
		t.Fatal(err)
	}
	got, err = f.m.CopyVerdict(ctx, lockLocal)
	if want := (CopyVerdict{Reason: CopyUnlinked, Pending: -1, Conflicts: -1}); err != nil || got != want {
		t.Fatalf("unlinked folder: %+v %v, want %+v", got, err, want)
	}
	if _, err := f.m.CopyVerdict(ctx, "not-open"); err == nil {
		t.Fatal("a vault that is not open has no verdict")
	}
}

func TestCopyReason(t *testing.T) {
	for _, c := range []struct {
		pending, conflicts int
		want               string
	}{
		{0, 0, CopyClean},
		{2, 0, CopyPending},
		{2, 1, CopyPending},
		{0, 1, CopyConflicts},
		{-1, 0, CopyUnknown},
		{0, -1, CopyUnknown},
	} {
		if got := copyReason(c.pending, c.conflicts); got != c.want {
			t.Errorf("%d/%d: %s, want %s", c.pending, c.conflicts, got, c.want)
		}
	}
}
