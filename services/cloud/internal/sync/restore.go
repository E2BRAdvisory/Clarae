package sync

import (
	"context"
	"errors"

	"memobrain/services/cloud/internal/access"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"memobrain/services/cloud/internal/sync/syncdb"
	"memobrain/shared/syncproto"
)

// restoreAttempts bounds how often a restore is re-based on a file that other
// writers keep changing.
const restoreAttempts = 5

// RestoreRevision makes an old revision current again as a *new* revision that
// reuses its blob (§3.5.2). History is never rewritten: restoring revision 3
// of a file at revision 7 produces revision 8. A deleted file comes back at
// its last path. opID makes retries idempotent.
//
// The restore is a commit of one restore operation based on the current
// revision: it goes through the same machinery as every other write (vault
// lock, idempotency, scope checks, quota, race mapping, notification). A
// concurrent change of the file only moves the base forward: the restore is
// replayed on top of it.
func (s *Service) RestoreRevision(ctx context.Context, userID, vaultID uuid.UUID, scope string, fileID uuid.UUID, rev int32, opID uuid.UUID) (syncproto.OpResult, error) {
	acc, err := s.authz.Authorize(ctx, userID, vaultID, scope, access.Editor)
	if err != nil {
		return syncproto.OpResult{}, err
	}
	rejected := func(code syncproto.Code, detail string) syncproto.OpResult {
		return syncproto.OpResult{OpID: opID.String(), Status: syncproto.StatusRejected, Code: code, Detail: detail}
	}
	q := syncdb.New(s.db.Pool)
	// A retry returns the original outcome even if the target was pruned meanwhile.
	if prev, err := q.GetRevisionByOpID(ctx, syncdb.GetRevisionByOpIDParams{VaultID: vaultID, OpID: &opID}); err == nil {
		return accepted(opID.String(), prev.FileID, prev.RevNo, prev.Seq), nil
	} else if !errors.Is(err, pgx.ErrNoRows) {
		return syncproto.OpResult{}, err
	}
	target, err := q.GetRevision(ctx, syncdb.GetRevisionParams{VaultID: vaultID, FileID: fileID, RevNo: rev})
	if errors.Is(err, pgx.ErrNoRows) {
		return rejected(syncproto.CodeNotFound, "revision not found"), nil
	}
	if err != nil {
		return syncproto.OpResult{}, err
	}
	if acc.Scope != nil {
		// Through a share only what the share showed can come back: not the
		// content the file had before it entered the share.
		if pr, ok := acc.Scope.Project(target.FileID, target.Op, target.Path, target.PrevPath); !ok || !pr.Content {
			return rejected(syncproto.CodeNotFound, "revision not found"), nil
		}
	}
	if target.BlobHash == nil {
		return rejected(syncproto.CodeValidationFailed, "this revision is a deletion: it has no content to restore"), nil
	}
	vault := acc.Vault
	quotaBytes, err := s.quota.QuotaOf(ctx, vault.OwnerID)
	if err != nil {
		return syncproto.OpResult{}, err
	}
	env := commitEnv{vault: vault, userID: userID, quota: quotaBytes, maxFile: s.maxFileBytes(ctx), scope: acc.Scope, restore: true}
	var res syncproto.OpResult
	for attempt := 0; attempt < restoreAttempts; attempt++ {
		f, err := q.GetFile(ctx, syncdb.GetFileParams{ID: fileID, VaultID: vaultID})
		if errors.Is(err, pgx.ErrNoRows) {
			return rejected(syncproto.CodeNotFound, "file not found"), nil
		}
		if err != nil {
			return syncproto.OpResult{}, err
		}
		base := int(f.CurrentRev)
		op := syncproto.Op{OpID: opID.String(), Op: syncproto.OpRestore, FileID: fileID.String(), BaseRev: &base, BlobHash: *target.BlobHash}
		resp, err := s.commitEach(ctx, env, []syncproto.Op{op})
		if err != nil {
			return syncproto.OpResult{}, err
		}
		if res = resp.Results[0]; res.Status != syncproto.StatusConflict {
			return res, nil
		}
	}
	return res, nil
}
