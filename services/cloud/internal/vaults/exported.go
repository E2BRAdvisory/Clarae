package vaults

// Queries of this module that other modules may run, inside their own
// transactions: the tables stay owned here and the callers never import
// vaultsdb (ADR-0033). The types are aliases, so values flow unchanged.

import (
	"context"

	"github.com/google/uuid"

	"clarae/services/cloud/internal/db"
	"clarae/services/cloud/internal/vaults/vaultsdb"
)

// Types of the exported queries.
type (
	AddVaultUsageParams     = vaultsdb.AddVaultUsageParams
	AdvanceCompactionParams = vaultsdb.AdvanceCompactionParams
	FinishVaultBatchParams  = vaultsdb.FinishVaultBatchParams
	Vault                   = vaultsdb.Vault
)

// GetVault runs the GetVault query on tx.
func GetVault(ctx context.Context, tx db.DBTX, id uuid.UUID) (Vault, error) {
	return vaultsdb.New(tx).GetVault(ctx, id)
}

// SoftDeleteVaultsOfOwner runs the SoftDeleteVaultsOfOwner query on tx.
func SoftDeleteVaultsOfOwner(ctx context.Context, tx db.DBTX, ownerID uuid.UUID) (int64, error) {
	return vaultsdb.New(tx).SoftDeleteVaultsOfOwner(ctx, ownerID)
}

// ListVaultIDsOfOwner runs the ListVaultIDsOfOwner query on tx.
func ListVaultIDsOfOwner(ctx context.Context, tx db.DBTX, ownerID uuid.UUID) ([]uuid.UUID, error) {
	return vaultsdb.New(tx).ListVaultIDsOfOwner(ctx, ownerID)
}

// NextVaultSeq runs the NextVaultSeq query on tx.
func NextVaultSeq(ctx context.Context, tx db.DBTX, id uuid.UUID) (int64, error) {
	return vaultsdb.New(tx).NextVaultSeq(ctx, id)
}

// LockVault takes the vault's row lock (the one NextVaultSeq takes) on tx,
// held until tx ends. A commit takes it before any file row so that every
// writer of a vault locks in the same order: vault row, file rows, owner
// usage, blob rows (retention and the reconciliation jobs lock the vault
// before the blobs too).
func LockVault(ctx context.Context, tx db.DBTX, id uuid.UUID) error {
	_, err := vaultsdb.New(tx).LockVault(ctx, id)
	return err
}

// LockVaultSeq takes the vault's row lock like LockVault and returns its
// last_seq: a commit batch hands out the following seqs itself while it holds
// the lock, and stores the last one with FinishVaultBatch.
func LockVaultSeq(ctx context.Context, tx db.DBTX, id uuid.UUID) (int64, error) {
	return vaultsdb.New(tx).LockVaultSeq(ctx, id)
}

// FinishVaultBatch runs the FinishVaultBatch query on tx: the last seq of a
// commit batch and its usage delta, in one update of the vault row.
func FinishVaultBatch(ctx context.Context, tx db.DBTX, arg FinishVaultBatchParams) error {
	return vaultsdb.New(tx).FinishVaultBatch(ctx, arg)
}

// AddVaultUsage runs the AddVaultUsage query on tx.
func AddVaultUsage(ctx context.Context, tx db.DBTX, arg AddVaultUsageParams) error {
	return vaultsdb.New(tx).AddVaultUsage(ctx, arg)
}

// AdvanceCompaction runs the AdvanceCompaction query on tx: cursors before seq
// expire (CURSOR_EXPIRED) and their clients bootstrap from the manifest. The
// revisions module calls it when retention deletes changelog entries that a
// later entry does not supersede.
func AdvanceCompaction(ctx context.Context, tx db.DBTX, arg AdvanceCompactionParams) error {
	return vaultsdb.New(tx).AdvanceCompaction(ctx, arg)
}
