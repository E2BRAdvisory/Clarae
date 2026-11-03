package app

import (
	"context"

	syncpkg "memobrain/apps/desktop/internal/sync"
)

// CopyVerdict says whether the local copy of a vault can be removed without
// losing anything (D-04): it scans the local files first (no key or network
// needed) and counts what is pending or in conflict. The web workbench asks it
// before it removes a copy from the browser (ADR-0029, ADR-0045 point 8), so
// the decision is the core's; the host only removes the files.
func (s *SyncAPI) CopyVerdict(vaultID string) (syncpkg.CopyVerdict, error) {
	v, err := s.app.sync.CopyVerdict(context.Background(), vaultID)
	return v, bindingError(err)
}
