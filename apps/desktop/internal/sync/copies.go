package sync

import (
	"context"
	"errors"
)

// Reasons of a CopyVerdict (stable: the web host branches on them).
const (
	// CopyClean: the cloud has everything the local copy holds.
	CopyClean = "clean"
	// CopyPending: changes not uploaded yet.
	CopyPending = "pending"
	// CopyConflicts: unresolved conflicts, whose local side may exist only here.
	CopyConflicts = "conflicts"
	// CopyUnknown: the local changes could not be counted (a failed scan or
	// database read); unknown is kept like changes.
	CopyUnknown = "unknown"
	// CopyUnlinked: the folder is not linked to the cloud (any more, e.g. its
	// cloud vault was deleted elsewhere): the core no longer tracks what the
	// cloud has, so it cannot vouch for the copy.
	CopyUnlinked = "unlinked"
)

// CopyVerdict says whether the local copy of a linked vault can be removed
// without losing anything (D-04): the web workbench asks it before it removes
// a copy from the browser (ADR-0029), so the rule lives here and not in the
// host. Removable only when the copy is linked, its local changes were
// scanned just now and nothing is pending or in conflict.
type CopyVerdict struct {
	Removable bool   `json:"removable"`
	Reason    string `json:"reason"` // CopyClean, CopyPending, CopyConflicts, CopyUnknown or CopyUnlinked
	// Pending and Conflicts are the counts behind the verdict; -1 when unknown.
	Pending   int `json:"pending"`
	Conflicts int `json:"conflicts"`
}

// CopyVerdict scans the local files of a linked vault (no key and no network
// needed, so it works on a locked private vault and offline), waiting for a
// running cycle to end, and says whether the copy may be removed.
func (m *Manager) CopyVerdict(ctx context.Context, localID string) (CopyVerdict, error) {
	if _, err := m.get(localID); err != nil {
		return CopyVerdict{}, err
	}
	v, err := m.linked(localID)
	if err != nil {
		return CopyVerdict{Reason: CopyUnlinked, Pending: -1, Conflicts: -1}, nil
	}
	err = v.engine.Exclusive(func() error { return v.engine.scan(ctx) })
	if errors.Is(err, ErrUnlinked) {
		return CopyVerdict{Reason: CopyUnlinked, Pending: -1, Conflicts: -1}, nil
	}
	out := CopyVerdict{Pending: -1, Conflicts: -1}
	if err == nil {
		out.Pending, err = v.db.PendingCount(ctx)
		if err != nil {
			out.Pending = -1
		}
	}
	if err != nil {
		m.log.Warn().Err(err).Str("vault", localID).Msg("sync: local changes of a copy unknown")
	}
	if n, cerr := v.db.OpenConflictCount(ctx); cerr == nil {
		out.Conflicts = n
	}
	if out.Pending >= 0 && out.Conflicts >= 0 {
		// The status (and the UI's counters) follow the fresh scan.
		v.engine.setStatus(func(s *Status) { s.Pending, s.Conflicts = out.Pending, out.Conflicts })
	}
	out.Reason = copyReason(out.Pending, out.Conflicts)
	out.Removable = out.Reason == CopyClean
	return out, nil
}

// copyReason is the verdict of known counts; a negative count is unknown.
func copyReason(pending, conflicts int) string {
	switch {
	case pending < 0 || conflicts < 0:
		return CopyUnknown
	case pending > 0:
		return CopyPending
	case conflicts > 0:
		return CopyConflicts
	default:
		return CopyClean
	}
}
