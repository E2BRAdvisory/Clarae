package sharing

// Queries of this module that other modules may run, inside their own
// transactions: the tables stay owned here and the callers never import
// sharingdb (ADR-0033). The types are aliases, so values flow unchanged.

import (
	"context"

	"github.com/google/uuid"

	"memobrain/services/cloud/internal/db"
	"memobrain/services/cloud/internal/sharing/sharingdb"
)

// Types of the exported queries.
type (
	ListGrantsOfUserRow      = sharingdb.ListGrantsOfUserRow
	ListGrantsRow            = sharingdb.ListGrantsRow
	RebasePrefixSharesParams = sharingdb.RebasePrefixSharesParams
	Share                    = sharingdb.Share
)

// ListLiveSharesOfVault runs the ListLiveSharesOfVault query on tx.
func ListLiveSharesOfVault(ctx context.Context, tx db.DBTX, vaultID uuid.UUID) ([]Share, error) {
	return sharingdb.New(tx).ListLiveSharesOfVault(ctx, vaultID)
}

// RebasePrefixShares runs the RebasePrefixShares query on tx.
func RebasePrefixShares(ctx context.Context, tx db.DBTX, arg RebasePrefixSharesParams) error {
	return sharingdb.New(tx).RebasePrefixShares(ctx, arg)
}

// ListGrants runs the ListGrants query on tx.
func ListGrants(ctx context.Context, tx db.DBTX, shareID uuid.UUID) ([]ListGrantsRow, error) {
	return sharingdb.New(tx).ListGrants(ctx, shareID)
}

// ListGrantsOfUser runs the ListGrantsOfUser query on tx.
func ListGrantsOfUser(ctx context.Context, tx db.DBTX, principalID uuid.UUID) ([]ListGrantsOfUserRow, error) {
	return sharingdb.New(tx).ListGrantsOfUser(ctx, principalID)
}

// DeleteGrantsOfPrincipal removes every grant given to a user or a group (a
// deleted group, an erased account), inside tx.
func DeleteGrantsOfPrincipal(ctx context.Context, tx db.DBTX, principalType string, principalID uuid.UUID) error {
	_, err := sharingdb.New(tx).DeleteGrantsOfPrincipal(ctx, sharingdb.DeleteGrantsOfPrincipalParams{PrincipalType: principalType, PrincipalID: principalID})
	return err
}

// DeleteGrantsOfPrincipal implements groups.GrantRemover.
func (s *Service) DeleteGrantsOfPrincipal(ctx context.Context, tx db.DBTX, principalType string, principalID uuid.UUID) error {
	return DeleteGrantsOfPrincipal(ctx, tx, principalType, principalID)
}
