package revisions

// Queries of this module that other modules may run, inside their own
// transactions: the changelog tables stay owned here (and by sync) and the
// callers never import revisionsdb (ADR-0033).

import (
	"context"

	"github.com/google/uuid"

	"clarae/services/cloud/internal/db"
	"clarae/services/cloud/internal/revisions/revisionsdb"
)

// DeletedRefs is one group of the revisions DeleteVaultRevisionsPage deleted:
// the blob they referenced (nil for revisions without content) and how many
// of them did.
type DeletedRefs = revisionsdb.DeleteVaultRevisionsPageRow

// DeleteVaultRevisionsPage deletes up to maxRows revisions of a vault, oldest
// first, skipping rows another transaction holds, and returns their blob
// references grouped by hash in hash order. The caller (the purge of a
// deleted vault) holds the vault row and releases the references in the same
// transaction.
func DeleteVaultRevisionsPage(ctx context.Context, tx db.DBTX, vaultID uuid.UUID, maxRows int32) ([]DeletedRefs, error) {
	return revisionsdb.New(tx).DeleteVaultRevisionsPage(ctx, revisionsdb.DeleteVaultRevisionsPageParams{VaultID: vaultID, MaxRows: maxRows})
}
