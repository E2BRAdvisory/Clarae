// Package sync is the server side of the synchronization protocol (§3.4):
// the totally ordered changelog of a vault and the commit that appends to it.
// The server orders and stores; it never interprets file content (§3.4.1).
package sync

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"slices"
	"strings"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"

	"nodus/services/cloud/internal/blobs"
	"nodus/services/cloud/internal/db"
	"nodus/services/cloud/internal/db/dbgen"
	"nodus/services/cloud/internal/httpproblem"
	"nodus/services/cloud/internal/quota"
	"nodus/shared/pathrules"
	"nodus/shared/syncproto"
)

// ChannelVaultChanged is the Postgres NOTIFY channel carrying "vault_id:seq".
const ChannelVaultChanged = "vault_changed"

// DefaultMaxFileBytes is used when the files.max_size_bytes setting is missing.
const DefaultMaxFileBytes int64 = 100 << 20

// VaultOpener decides whether a user may use a vault (vaults module).
type VaultOpener interface {
	Open(ctx context.Context, userID, vaultID uuid.UUID) (dbgen.Vault, error)
}

// QuotaSource resolves the effective quota of the vault owner.
type QuotaSource interface {
	QuotaOf(ctx context.Context, userID uuid.UUID) (int64, error)
}

// Service implements the sync module.
type Service struct {
	db     *db.DB
	vaults VaultOpener
	quota  QuotaSource
}

// NewService wires the module.
func NewService(d *db.DB, v VaultOpener, q QuotaSource) *Service {
	return &Service{db: d, vaults: v, quota: q}
}

// opError is a rejection of one operation: it becomes a "rejected" result.
type opError struct {
	code   syncproto.Code
	detail string
}

func (e *opError) Error() string { return string(e.code) + ": " + e.detail }

func reject(code syncproto.Code, format string, args ...any) *opError {
	return &opError{code: code, detail: fmt.Sprintf(format, args...)}
}

// conflict carries the current state of a file back to the client.
type conflictError struct{ f dbgen.File }

func (e *conflictError) Error() string { return "revision conflict" }

func (s *Service) maxFileBytes(ctx context.Context) int64 {
	raw, err := s.db.Queries().GetSetting(ctx, "files.max_size_bytes")
	if err != nil {
		return DefaultMaxFileBytes
	}
	var n int64
	if json.Unmarshal(raw, &n) != nil || n <= 0 {
		return DefaultMaxFileBytes
	}
	return n
}

// MaxFileBytes is the largest accepted file (exposed to the tus handler).
func (s *Service) MaxFileBytes(ctx context.Context) int64 { return s.maxFileBytes(ctx) }

// Commit applies the operations in order (§3.4.4 C); each is evaluated
// independently: one that is rejected or in conflict does not affect the others.
//
// The fast path runs the whole batch in one transaction (one fsync, one
// NOTIFY, the vault lock held for the batch). That is safe because every
// operation performs all its checks before its first write, so a business
// rejection leaves the transaction untouched; SAVEPOINTs are avoided on
// purpose: beyond 64 subtransactions PostgreSQL slows down dramatically.
// When a concurrent writer wins a race (unique violation, deadlock) the batch
// is rolled back and replayed operation by operation, each in its own
// transaction; operation ids make that replay idempotent.
func (s *Service) Commit(ctx context.Context, userID uuid.UUID, vaultID, deviceID uuid.UUID, ops []syncproto.Op) (syncproto.CommitResponse, error) {
	if len(ops) == 0 || len(ops) > syncproto.MaxOpsPerCommit {
		return syncproto.CommitResponse{}, httpproblem.Errorf(syncproto.CodeValidationFailed, "a commit carries 1..%d operations", syncproto.MaxOpsPerCommit)
	}
	vault, err := s.vaults.Open(ctx, userID, vaultID)
	if err != nil {
		return syncproto.CommitResponse{}, err
	}
	q := s.db.Queries()
	dev, err := q.GetDevice(ctx, dbgen.GetDeviceParams{ID: deviceID, UserID: userID})
	if errors.Is(err, pgx.ErrNoRows) {
		return syncproto.CommitResponse{}, httpproblem.Errorf(syncproto.CodeValidationFailed, "unknown device_id")
	}
	if err != nil {
		return syncproto.CommitResponse{}, err
	}
	if dev.RevokedAt != nil {
		return syncproto.CommitResponse{}, httpproblem.Errorf(syncproto.CodeForbidden, "device revoked")
	}
	_ = q.TouchDevice(ctx, dbgen.TouchDeviceParams{ID: deviceID, UserID: userID})

	// The owner pays for the storage, whoever edits (shared vaults, M4).
	quotaBytes, err := s.quota.QuotaOf(ctx, vault.OwnerID)
	if err != nil {
		return syncproto.CommitResponse{}, err
	}
	env := commitEnv{vault: vault, userID: userID, deviceID: deviceID, quota: quotaBytes, maxFile: s.maxFileBytes(ctx)}

	resp, err := s.commitBatch(ctx, env, ops)
	if isRace(err) {
		resp, err = s.commitEach(ctx, env, ops)
	}
	if err != nil {
		return syncproto.CommitResponse{}, err
	}
	if latest, err := q.GetVault(ctx, vaultID); err == nil {
		resp.LastSeq = latest.LastSeq
	}
	return resp, nil
}

type commitEnv struct {
	vault    dbgen.Vault
	userID   uuid.UUID
	deviceID uuid.UUID
	quota    int64
	maxFile  int64
	// batch is set on the fast path: the writes that every operation of the
	// batch would repeat on the same few rows (the owner's usage, blob
	// reference counts) are accumulated and applied once, just before commit,
	// so concurrent batches hold those row locks for microseconds instead of
	// for the whole batch. nil on the slow path: apply immediately.
	batch *batchState
}

type batchState struct {
	usedAtStart int64
	delta       int64
	refs        map[string]int32
}

// errChargeRace means the final quota charge failed although every operation
// passed its check: another writer used the space meanwhile.
var errChargeRace = errors.New("sync: quota consumed concurrently")

func (e commitEnv) private() bool { return e.vault.Kind == "private" }

func (s *Service) notify(ctx context.Context, tx pgx.Tx, vaultID uuid.UUID, seq int64) error {
	// One notification per transaction: it carries the highest seq and
	// listeners coalesce per vault anyway.
	_, err := tx.Exec(ctx, "SELECT pg_notify($1, $2)", ChannelVaultChanged, fmt.Sprintf("%s:%d", vaultID, seq))
	return err
}

// commitBatch is the fast path: all operations in one transaction.
func (s *Service) commitBatch(ctx context.Context, env commitEnv, ops []syncproto.Op) (syncproto.CommitResponse, error) {
	resp := syncproto.CommitResponse{Results: make([]syncproto.OpResult, 0, len(ops))}
	tx, err := s.db.Pool.Begin(ctx)
	if err != nil {
		return resp, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	q := dbgen.New(tx)
	used, err := q.UserUsedBytes(ctx, env.vault.OwnerID)
	if err != nil {
		return resp, err
	}
	env.batch = &batchState{usedAtStart: used, refs: map[string]int32{}}
	var top int64
	for _, op := range ops {
		res, err := s.execOp(ctx, q, env, op)
		if res2, handled := business(op.OpID, err); handled {
			res, err = res2, nil
		}
		if err != nil {
			return resp, err
		}
		resp.Results = append(resp.Results, res)
		top = max(top, res.Seq)
	}
	if top > 0 {
		if err := s.flushBatch(ctx, q, env); err != nil {
			return resp, err
		}
		if err := s.notify(ctx, tx, env.vault.ID, top); err != nil {
			return resp, err
		}
	}
	return resp, tx.Commit(ctx)
}

// flushBatch applies the accumulated usage charge and blob references. Blob
// hashes are processed in sorted order so concurrent batches never deadlock.
func (s *Service) flushBatch(ctx context.Context, q *dbgen.Queries, env commitEnv) error {
	b := env.batch
	if b.delta != 0 {
		if err := quota.Charge(ctx, q, env.vault.OwnerID, b.delta, env.quota); err != nil {
			var pe *httpproblem.Error
			if errors.As(err, &pe) && pe.Code == syncproto.CodeQuotaExceeded {
				return errChargeRace
			}
			return err
		}
	}
	hashes := make([]string, 0, len(b.refs))
	for h := range b.refs {
		hashes = append(hashes, h)
	}
	slices.Sort(hashes)
	for _, h := range hashes {
		if err := blobs.AddRef(ctx, q, h, b.refs[h]); err != nil {
			return err
		}
	}
	return nil
}

// commitEach is the slow path: one transaction per operation.
func (s *Service) commitEach(ctx context.Context, env commitEnv, ops []syncproto.Op) (syncproto.CommitResponse, error) {
	resp := syncproto.CommitResponse{Results: make([]syncproto.OpResult, 0, len(ops))}
	for _, op := range ops {
		var res syncproto.OpResult
		err := s.db.WithTx(ctx, func(ctx context.Context, q *dbgen.Queries, tx pgx.Tx) error {
			var err error
			if res, err = s.execOp(ctx, q, env, op); err != nil {
				return err
			}
			if res.Status == syncproto.StatusAccepted && res.Seq > 0 {
				return s.notify(ctx, tx, env.vault.ID, res.Seq)
			}
			return nil
		})
		switch {
		case isUnique(err, "files_path_uq"):
			res, err = syncproto.OpResult{OpID: op.OpID, Status: syncproto.StatusRejected, Code: syncproto.CodePathCollision, Detail: "another file already uses this path"}, nil
		case isUnique(err, "file_revisions_op_uq"):
			// A concurrent retry of the same operation won: it is applied.
			opID, _ := uuid.Parse(op.OpID)
			prev, gerr := s.db.Queries().GetRevisionByOpID(ctx, dbgen.GetRevisionByOpIDParams{VaultID: env.vault.ID, OpID: &opID})
			if gerr != nil {
				return resp, gerr
			}
			res, err = accepted(op.OpID, prev.FileID, prev.RevNo, prev.Seq), nil
		}
		if res2, handled := business(op.OpID, err); handled {
			res, err = res2, nil
		}
		if err != nil {
			return resp, err
		}
		resp.Results = append(resp.Results, res)
	}
	return resp, nil
}

// execOp evaluates one operation inside tx. Business outcomes come back as
// *opError or *conflictError (see business); anything else is an infrastructure
// error.
func (s *Service) execOp(ctx context.Context, q *dbgen.Queries, env commitEnv, op syncproto.Op) (syncproto.OpResult, error) {
	opID, err := uuid.Parse(op.OpID)
	if err != nil {
		return syncproto.OpResult{}, reject(syncproto.CodeValidationFailed, "op_id must be a UUID")
	}
	// A retried operation returns its original outcome (idempotency).
	prev, err := q.GetRevisionByOpID(ctx, dbgen.GetRevisionByOpIDParams{VaultID: env.vault.ID, OpID: &opID})
	if err == nil {
		return accepted(op.OpID, prev.FileID, prev.RevNo, prev.Seq), nil
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return syncproto.OpResult{}, err
	}
	return s.dispatch(ctx, q, env, op, opID)
}

// business converts a rejection or conflict into the operation's result.
func business(opID string, err error) (syncproto.OpResult, bool) {
	var oe *opError
	var ce *conflictError
	switch {
	case errors.As(err, &oe):
		return syncproto.OpResult{OpID: opID, Status: syncproto.StatusRejected, Code: oe.code, Detail: oe.detail}, true
	case errors.As(err, &ce):
		h := ""
		if ce.f.BlobHash != nil {
			h = *ce.f.BlobHash
		}
		return syncproto.OpResult{
			OpID: opID, Status: syncproto.StatusConflict, Code: syncproto.CodeRevConflict, FileID: ce.f.ID.String(),
			CurrentRev: int(ce.f.CurrentRev), CurrentHash: h, CurrentSeq: ce.f.CurrentSeq,
		}, true
	}
	return syncproto.OpResult{}, false
}

// isRace reports errors that mean "a concurrent writer got there first".
func isRace(err error) bool {
	if errors.Is(err, errChargeRace) {
		return true
	}
	var pg *pgconn.PgError
	if !errors.As(err, &pg) {
		return false
	}
	switch pg.Code {
	case "23505", "40001", "40P01": // unique violation, serialization failure, deadlock
		return true
	}
	return false
}

func isUnique(err error, constraint string) bool {
	var pg *pgconn.PgError
	return errors.As(err, &pg) && pg.Code == "23505" && pg.ConstraintName == constraint
}

func accepted(opID string, fileID uuid.UUID, rev int32, seq int64) syncproto.OpResult {
	return syncproto.OpResult{OpID: opID, Status: syncproto.StatusAccepted, FileID: fileID.String(), Rev: int(rev), Seq: seq}
}

func (s *Service) dispatch(ctx context.Context, q *dbgen.Queries, env commitEnv, op syncproto.Op, opID uuid.UUID) (syncproto.OpResult, error) {
	switch op.Op {
	case syncproto.OpCreate:
		return s.create(ctx, q, env, op, opID)
	case syncproto.OpModify, syncproto.OpRestore:
		return s.modify(ctx, q, env, op, opID)
	case syncproto.OpMove:
		return s.move(ctx, q, env, op, opID)
	case syncproto.OpDelete:
		return s.remove(ctx, q, env, op, opID)
	case syncproto.OpMovePrefix:
		return s.movePrefix(ctx, q, env, op, opID)
	default:
		return syncproto.OpResult{}, reject(syncproto.CodeValidationFailed, "unknown operation %q", op.Op)
	}
}

// resolvePath validates a path and returns it with its uniqueness key and
// file kind. Shared vaults carry clear paths the server normalizes; private
// vaults carry opaque tokens plus the client-computed key (§3.8.3, ADR-0009).
func resolvePath(env commitEnv, path, pathKey string) (p, key string, kind syncproto.FileKind, err error) {
	if env.private() {
		if !strings.HasPrefix(path, "enc1:") || len(path) > 1100 || len(path) < 10 || strings.ContainsAny(path, "/ \n\r\t") {
			return "", "", "", reject(syncproto.CodePathInvalid, "path must be an opaque enc1: token")
		}
		if !strings.HasPrefix(pathKey, "hmac1:") || len(pathKey) != len("hmac1:")+64 || !blobs.IsHash(pathKey[len("hmac1:"):]) {
			return "", "", "", reject(syncproto.CodePathInvalid, "path_key must be hmac1:<64 hex>")
		}
		return path, pathKey, syncproto.KindOpaque, nil
	}
	norm, err := pathrules.Normalize(path)
	if err != nil {
		return "", "", "", reject(syncproto.CodePathInvalid, "%v", err)
	}
	if pathrules.IsExcluded(norm, false) {
		return "", "", "", reject(syncproto.CodePathInvalid, "%s is excluded from synchronization", norm)
	}
	return norm, pathrules.Key(norm), syncproto.KindOf(norm), nil
}

func parseFileID(op syncproto.Op) (uuid.UUID, error) {
	id, err := uuid.Parse(op.FileID)
	if err != nil {
		return uuid.Nil, reject(syncproto.CodeValidationFailed, "file_id must be a UUID")
	}
	return id, nil
}

// checkBlob verifies the vault owns the blob and returns its size, enforcing
// the file size limit.
func (s *Service) checkBlob(ctx context.Context, q *dbgen.Queries, env commitEnv, hash string, declared int64) (int64, error) {
	if !blobs.IsHash(hash) {
		return 0, reject(syncproto.CodeValidationFailed, "blob_hash must be a SHA-256 hex digest")
	}
	size, ok, err := blobs.VaultBlob(ctx, q, env.vault.ID, hash)
	if err != nil {
		return 0, err
	}
	if !ok {
		return 0, reject(syncproto.CodeBlobMissing, "blob %s has not been uploaded to this vault", hash)
	}
	if declared != 0 && declared != size {
		return 0, reject(syncproto.CodeValidationFailed, "size %d does not match the uploaded blob (%d bytes)", declared, size)
	}
	if size > env.maxFile {
		return 0, reject(syncproto.CodeFileTooLarge, "file of %d bytes exceeds the limit of %d", size, env.maxFile)
	}
	return size, nil
}

func chargeOwner(ctx context.Context, q *dbgen.Queries, env commitEnv, delta int64) error {
	if delta == 0 {
		return nil
	}
	if b := env.batch; b != nil {
		// Check against the running total now, charge once at the end.
		if delta > 0 && env.quota >= 0 && b.usedAtStart+b.delta+delta > env.quota {
			return reject(syncproto.CodeQuotaExceeded, "storage quota exceeded (used %d of %d bytes)", b.usedAtStart+b.delta, env.quota)
		}
		b.delta += delta
		return nil
	}
	if err := quota.Charge(ctx, q, env.vault.OwnerID, delta, env.quota); err != nil {
		var pe *httpproblem.Error
		if errors.As(err, &pe) && pe.Code == syncproto.CodeQuotaExceeded {
			return reject(syncproto.CodeQuotaExceeded, "storage quota exceeded (used %v of %v bytes)", pe.Extra["used_bytes"], pe.Extra["quota_bytes"])
		}
		return err
	}
	return nil
}

// record appends a revision, advances the file and notifies listeners. The
// caller has already taken care of quota and counters.
type recordArgs struct {
	file      dbgen.File // new state of the files row (ID, Path, PathKey, Kind, BlobHash, Size, IsDeleted)
	exists    bool       // false: INSERT (create), true: UPDATE
	rev       int32
	op        string
	prevPath  *string
	baseRev   *int32
	clientMtm *timePtr
	opID      *uuid.UUID
	conflict  *uuid.UUID
}

func (s *Service) record(ctx context.Context, q *dbgen.Queries, env commitEnv, a recordArgs) (seq int64, err error) {
	seq, err = q.NextVaultSeq(ctx, env.vault.ID)
	if err != nil {
		return 0, err
	}
	f := a.file
	if a.exists {
		err = q.UpdateFile(ctx, dbgen.UpdateFileParams{
			ID: f.ID, Path: f.Path, PathKey: f.PathKey, Kind: f.Kind, CurrentRev: a.rev, CurrentSeq: seq,
			BlobHash: f.BlobHash, Size: f.Size, IsDeleted: f.IsDeleted,
		})
	} else {
		err = q.InsertFile(ctx, dbgen.InsertFileParams{
			ID: f.ID, VaultID: env.vault.ID, Path: f.Path, PathKey: f.PathKey, Kind: f.Kind, CurrentRev: a.rev, CurrentSeq: seq,
			BlobHash: f.BlobHash, Size: f.Size,
		})
	}
	if err != nil {
		return 0, err
	}
	revID, err := uuid.NewV7()
	if err != nil {
		return 0, err
	}
	devID := env.deviceID
	var devPtr *uuid.UUID
	if devID != uuid.Nil {
		devPtr = &devID
	}
	if _, err := q.InsertRevision(ctx, dbgen.InsertRevisionParams{
		ID: revID, FileID: f.ID, VaultID: env.vault.ID, Seq: seq, RevNo: a.rev, Op: a.op, Path: f.Path, PrevPath: a.prevPath,
		BlobHash: f.BlobHash, Size: f.Size, BaseRev: a.baseRev, AuthorID: env.userID, DeviceID: devPtr, OpID: a.opID,
		ClientMtime: a.clientMtm.get(), ConflictOf: a.conflict,
	}); err != nil {
		return 0, err
	}
	if f.BlobHash != nil {
		if env.batch != nil {
			env.batch.refs[*f.BlobHash]++
		} else if err := blobs.AddRef(ctx, q, *f.BlobHash, 1); err != nil {
			return 0, err
		}
	}
	return seq, nil
}
