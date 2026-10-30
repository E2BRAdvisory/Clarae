package vaults

// Queries of this module that other modules may run, inside their own
// transactions: the tables stay owned here and the callers never import
// vaultsdb (ADR-0033). The types are aliases, so values flow unchanged.

import (
	"context"

	"github.com/google/uuid"

	"memobrain/services/cloud/internal/db"
	"memobrain/services/cloud/internal/vaults/vaultsdb"
)

// Types of the exported queries.
type (
	AddVaultUsageParams = vaultsdb.AddVaultUsageParams
	Vault               = vaultsdb.Vault
)

// GetVault runs the GetVault query on tx.
func GetVault(ctx context.Context, tx db.DBTX, id uuid.UUID) (Vault, error) {
	return vaultsdb.New(tx).GetVault(ctx, id)
}

// SoftDeleteVaultsOfOwner runs the SoftDeleteVaultsOfOwner query on tx.
func SoftDeleteVaultsOfOwner(ctx context.Context, tx db.DBTX, ownerID uuid.UUID) (int64, error) {
	return vaultsdb.New(tx).SoftDeleteVaultsOfOwner(ctx, ownerID)
}

// NextVaultSeq runs the NextVaultSeq query on tx.
func NextVaultSeq(ctx context.Context, tx db.DBTX, id uuid.UUID) (int64, error) {
	return vaultsdb.New(tx).NextVaultSeq(ctx, id)
}

// AddVaultUsage runs the AddVaultUsage query on tx.
func AddVaultUsage(ctx context.Context, tx db.DBTX, arg AddVaultUsageParams) error {
	return vaultsdb.New(tx).AddVaultUsage(ctx, arg)
}
