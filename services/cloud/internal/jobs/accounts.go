package jobs

import (
	"context"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"

	"memobrain/services/cloud/internal/audit"
	"memobrain/services/cloud/internal/jobs/jobsdb"
	"memobrain/services/cloud/internal/privacy"
)

// PurgeDeletedAccounts finishes the deletion of accounts that were deleted longer
// ago than privacy.account_purge_days (default 30; ADR-0021): every vault they
// still own is purged (releasing blob references, which the blob GC then removes),
// the personal data is anonymised again (accounts deleted by an administrator are
// only soft-deleted until now), and the row becomes a permanent tombstone whose id
// keeps audit entries and revisions in other users' vaults consistent.
func (r *Runner) PurgeDeletedAccounts(ctx context.Context) (int, error) {
	retention := time.Duration(r.setting(ctx, "privacy.account_purge_days", 30)) * 24 * time.Hour
	q := jobsdb.New(r.db.Pool)
	ids, err := q.ListUsersToPurge(ctx, ptrTime(r.now().Add(-retention)))
	if err != nil {
		return 0, err
	}
	for _, id := range ids {
		vaults, err := q.ListAllVaultIDsOfOwner(ctx, id)
		if err != nil {
			return 0, err
		}
		for _, v := range vaults {
			// The account retention governs: no need to wait for the vault retention.
			if err := r.purgeVault(ctx, v); err != nil {
				return 0, fmt.Errorf("purge vault %s of deleted account %s: %w", v, id, err)
			}
		}
		err = r.db.WithTx(ctx, func(ctx context.Context, tx pgx.Tx) error {
			q := jobsdb.New(tx)
			if err := privacy.Anonymise(ctx, tx, id); err != nil {
				return err
			}
			if err := q.MarkUserPurged(ctx, id); err != nil {
				return err
			}
			return audit.Record(ctx, tx, id, "account.purge", "user", id.String(), map[string]int{"vaults": len(vaults)})
		})
		if err != nil {
			return 0, err
		}
	}
	return len(ids), nil
}
