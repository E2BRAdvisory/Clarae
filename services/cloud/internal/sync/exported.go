package sync

// Queries of this module that other modules may run, inside their own
// transactions: the tables stay owned here and the callers never import
// syncdb (ADR-0033). The types are aliases, so values flow unchanged.

import (
	"context"

	"github.com/google/uuid"

	"memobrain/services/cloud/internal/db"
	"memobrain/services/cloud/internal/sync/syncdb"
)

// Types of the exported queries.
type (
	ListExportFilesRow = syncdb.ListExportFilesRow
)

// ListExportFiles runs the ListExportFiles query on tx.
func ListExportFiles(ctx context.Context, tx db.DBTX, vaultID uuid.UUID) ([]ListExportFilesRow, error) {
	return syncdb.New(tx).ListExportFiles(ctx, vaultID)
}
