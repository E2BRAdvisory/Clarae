package admin

import (
	"context"

	"memobrain/services/cloud/internal/admin/admindb"
	"memobrain/services/cloud/internal/db"
)

// SnapshotStorage records today's total usage for the trend of the dashboard
// (run daily by the maintenance job, ADR-0033).
func SnapshotStorage(ctx context.Context, tx db.DBTX) error {
	q := admindb.New(tx)
	totals, err := q.StorageTotals(ctx)
	if err != nil {
		return err
	}
	return q.UpsertStorageSnapshot(ctx, totals.TotalUsed)
}
