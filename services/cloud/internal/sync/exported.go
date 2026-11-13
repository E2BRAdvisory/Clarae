package sync

// Queries of this module that other modules may run, inside their own
// transactions: the tables stay owned here and the callers never import
// syncdb (ADR-0033). The types are aliases, so values flow unchanged.

import (
	"context"
	"errors"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"clarae/services/cloud/internal/db"
	"clarae/services/cloud/internal/sync/syncdb"
)

// Types of the exported queries.
type (
	ListExportFilesRow = syncdb.ListExportFilesRow
	File               = syncdb.File
	FileRevision       = syncdb.FileRevision
)

// GetFile runs the GetFile query on tx: the file row, deleted or not, if it
// belongs to the vault.
func GetFile(ctx context.Context, tx db.DBTX, vaultID, fileID uuid.UUID) (File, error) {
	return syncdb.New(tx).GetFile(ctx, syncdb.GetFileParams{ID: fileID, VaultID: vaultID})
}

// GetRevision runs the GetRevision query on tx: revision rev of a file.
func GetRevision(ctx context.Context, tx db.DBTX, vaultID, fileID uuid.UUID, rev int32) (FileRevision, error) {
	return syncdb.New(tx).GetRevision(ctx, syncdb.GetRevisionParams{VaultID: vaultID, FileID: fileID, RevNo: rev})
}

// ListExportFiles runs the ListExportFiles query on tx.
func ListExportFiles(ctx context.Context, tx db.DBTX, vaultID uuid.UUID) ([]ListExportFilesRow, error) {
	return syncdb.New(tx).ListExportFiles(ctx, vaultID)
}

// ChangeIDAt returns the id of the changelog entry at seq in the vault, ok
// false when there is none (seq 0, or an entry pruned by retention). The
// manifest reports it with its position so that a client can keep the
// identity of its cursor (ADR-0046).
func ChangeIDAt(ctx context.Context, tx db.DBTX, vaultID uuid.UUID, seq int64) (id uuid.UUID, ok bool, err error) {
	if seq <= 0 {
		return uuid.Nil, false, nil
	}
	id, err = syncdb.New(tx).GetChangeIDAt(ctx, syncdb.GetChangeIDAtParams{VaultID: vaultID, Seq: seq})
	if errors.Is(err, pgx.ErrNoRows) {
		return uuid.Nil, false, nil
	}
	return id, err == nil, err
}
