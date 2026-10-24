package sync

import (
	"context"
	"errors"
	"fmt"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"nodus/services/cloud/internal/db/dbgen"
	"nodus/shared/syncproto"
)

// RestoreRevision makes an old revision current again as a *new* revision that
// reuses its blob (§3.5.2). History is never rewritten: restoring revision 3
// of a file at revision 7 produces revision 8. A deleted file comes back at
// its last path. opID makes retries idempotent.
func (s *Service) RestoreRevision(ctx context.Context, userID, vaultID, fileID uuid.UUID, rev int32, opID uuid.UUID) (syncproto.OpResult, error) {
	vault, err := s.vaults.Open(ctx, userID, vaultID)
	if err != nil {
		return syncproto.OpResult{}, err
	}
	quotaBytes, err := s.quota.QuotaOf(ctx, vault.OwnerID)
	if err != nil {
		return syncproto.OpResult{}, err
	}
	env := commitEnv{vault: vault, userID: userID, quota: quotaBytes, maxFile: s.maxFileBytes(ctx)}
	op := syncproto.Op{OpID: opID.String(), Op: syncproto.OpRestore, FileID: fileID.String()}

	var res syncproto.OpResult
	err = s.db.WithTx(ctx, func(ctx context.Context, q *dbgen.Queries, tx pgx.Tx) error {
		if prev, err := q.GetRevisionByOpID(ctx, dbgen.GetRevisionByOpIDParams{VaultID: vaultID, OpID: &opID}); err == nil {
			res = accepted(op.OpID, prev.FileID, prev.RevNo, prev.Seq)
			return nil
		} else if !errors.Is(err, pgx.ErrNoRows) {
			return err
		}
		f, err := q.GetFileForUpdate(ctx, dbgen.GetFileForUpdateParams{ID: fileID, VaultID: vaultID})
		if errors.Is(err, pgx.ErrNoRows) {
			return reject(syncproto.CodeNotFound, "file not found")
		}
		if err != nil {
			return err
		}
		target, err := q.GetRevision(ctx, dbgen.GetRevisionParams{VaultID: vaultID, FileID: fileID, RevNo: rev})
		if errors.Is(err, pgx.ErrNoRows) {
			return reject(syncproto.CodeNotFound, "revision not found")
		}
		if err != nil {
			return err
		}
		if target.BlobHash == nil {
			return reject(syncproto.CodeValidationFailed, "revision %d is a deletion: it has no content to restore", rev)
		}
		size, err := s.checkBlob(ctx, q, env, *target.BlobHash, 0)
		if err != nil {
			return err
		}
		if f.IsDeleted {
			if taken, err := q.PathKeyTaken(ctx, dbgen.PathKeyTakenParams{VaultID: vaultID, PathKey: f.PathKey}); err == nil && taken != f.ID {
				return reject(syncproto.CodePathCollision, "the original path is used by another file now")
			} else if err != nil && !errors.Is(err, pgx.ErrNoRows) {
				return err
			}
		}
		old := f.Size
		if f.IsDeleted {
			old = 0
		}
		if err := chargeOwner(ctx, q, env, size-old); err != nil {
			return err
		}
		nf := f
		nf.BlobHash, nf.Size, nf.IsDeleted = target.BlobHash, size, false
		newRev := f.CurrentRev + 1
		seq, err := s.record(ctx, q, tx, env, recordArgs{file: nf, exists: true, rev: newRev, op: "restore", baseRev: ptr(f.CurrentRev), opID: &opID})
		if err != nil {
			return err
		}
		files := int32(0)
		if f.IsDeleted {
			files = 1
		}
		if err := q.AddVaultUsage(ctx, dbgen.AddVaultUsageParams{ID: vaultID, TotalBytes: size - old, FileCount: files}); err != nil {
			return err
		}
		if _, err := tx.Exec(ctx, "SELECT pg_notify($1, $2)", ChannelVaultChanged, fmt.Sprintf("%s:%d", vaultID, seq)); err != nil {
			return err
		}
		res = accepted(op.OpID, f.ID, newRev, seq)
		return nil
	})
	var oe *opError
	if errors.As(err, &oe) {
		return syncproto.OpResult{OpID: op.OpID, Status: syncproto.StatusRejected, Code: oe.code, Detail: oe.detail}, nil
	}
	return res, err
}
