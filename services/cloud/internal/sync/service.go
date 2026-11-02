// Package sync is the server side of the synchronization protocol (§3.4):
// the totally ordered changelog of a vault and the commit that appends to it.
// The server orders and stores; it never interprets file content (§3.4.1).
package sync

import (
	"context"
	"errors"
	"fmt"
	"slices"
	"strings"
	"time"

	"memobrain/services/cloud/internal/access"
	"memobrain/services/cloud/internal/settings"
	"memobrain/services/cloud/internal/users"
	"memobrain/services/cloud/internal/vaults"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"

	"memobrain/services/cloud/internal/blobs"
	"memobrain/services/cloud/internal/db"
	"memobrain/services/cloud/internal/httpproblem"
	"memobrain/services/cloud/internal/notify"
	"memobrain/services/cloud/internal/observability"
	"memobrain/services/cloud/internal/quota"
	"memobrain/services/cloud/internal/sharing"
	"memobrain/services/cloud/internal/sync/syncdb"
	"memobrain/shared/pathrules"
	"memobrain/shared/syncproto"
)

// recordCommit feeds the commit metrics.
func recordCommit(resp syncproto.CommitResponse, err error) {
	statuses := make([]string, 0, len(resp.Results))
	for _, r := range resp.Results {
		statuses = append(statuses, string(r.Status))
	}
	observability.SyncCommit(err, statuses)
}

// touchEvery is how stale a device's last_seen_at may get before a commit refreshes it.
const touchEvery = time.Minute

// DefaultMaxFileBytes is used when the files.max_size_bytes setting is missing.
const DefaultMaxFileBytes = syncproto.DefaultMaxFileBytes

// QuotaSource resolves the effective quota of the vault owner.
type QuotaSource interface {
	QuotaOf(ctx context.Context, userID uuid.UUID) (int64, error)
}

// Service implements the sync module.
type Service struct {
	db    *db.DB
	authz access.Authorizer
	quota QuotaSource
}

// NewService wires the module.
func NewService(d *db.DB, a access.Authorizer, q QuotaSource) *Service {
	return &Service{db: d, authz: a, quota: q}
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

// appliedError means the operation is in the changelog already: a retry that
// overlapped its original (see lockFile).
type appliedError struct{ rev syncdb.FileRevision }

func (e *appliedError) Error() string { return "operation already applied" }

// conflict carries the current state of a file back to the client.
type conflictError struct{ f syncdb.File }

func (e *conflictError) Error() string { return "revision conflict" }

func (s *Service) maxFileBytes(ctx context.Context) int64 {
	return settings.Int(ctx, s.db.Pool, "files.max_size_bytes", DefaultMaxFileBytes)
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
// When a concurrent writer wins a race (unique violation, quota consumed
// meanwhile) the batch is rolled back and replayed operation by operation,
// each in its own transaction; operation ids make that replay idempotent.
//
// Lock order: every writer of a vault takes the vault row first (LockVault),
// then file rows, the owner's usage and blob rows (sorted). Two batches over
// overlapping files therefore queue on the vault row instead of deadlocking
// on each other's file rows.
func (s *Service) Commit(ctx context.Context, userID uuid.UUID, vaultID uuid.UUID, scope string, deviceID uuid.UUID, ops []syncproto.Op) (resp syncproto.CommitResponse, err error) {
	defer func() { recordCommit(resp, err) }()
	if len(ops) == 0 || len(ops) > syncproto.MaxOpsPerCommit {
		return syncproto.CommitResponse{}, httpproblem.Errorf(syncproto.CodeValidationFailed, "a commit carries 1..%d operations", syncproto.MaxOpsPerCommit)
	}
	// Writing needs at least the editor level; through a share every path below is
	// relative to its root and confined to it (§3.4.7).
	acc, err := s.authz.Authorize(ctx, userID, vaultID, scope, access.Editor)
	if err != nil {
		return syncproto.CommitResponse{}, err
	}
	vault := acc.Vault
	conn := s.db.Pool
	dev, err := users.GetDevice(ctx, conn, users.GetDeviceParams{ID: deviceID, UserID: userID})
	if errors.Is(err, pgx.ErrNoRows) {
		return syncproto.CommitResponse{}, httpproblem.Errorf(syncproto.CodeValidationFailed, "unknown device_id")
	}
	if err != nil {
		return syncproto.CommitResponse{}, err
	}
	if dev.RevokedAt != nil {
		// extra.reason lets the client tell this from the other FORBIDDEN answers:
		// it stops syncing and offers to register the device again.
		return syncproto.CommitResponse{}, &httpproblem.Error{Code: syncproto.CodeForbidden, Detail: "device revoked", Extra: map[string]any{"reason": syncproto.ReasonDeviceRevoked}}
	}
	if dev.LastSeenAt == nil || time.Since(*dev.LastSeenAt) > touchEvery {
		// last_seen_at is shown with minute precision: a client committing in a
		// loop does not need one write of its device row per commit.
		_ = users.TouchDevice(ctx, conn, users.TouchDeviceParams{ID: deviceID, UserID: userID})
	}

	// The owner pays for the storage, whoever edits (shared vaults, M4).
	quotaBytes, err := s.quota.QuotaOf(ctx, vault.OwnerID)
	if err != nil {
		return syncproto.CommitResponse{}, err
	}
	env := commitEnv{vault: vault, userID: userID, deviceID: deviceID, quota: quotaBytes, maxFile: s.maxFileBytes(ctx), scope: acc.Scope}

	resp, err = s.commitBatch(ctx, env, ops)
	if isRace(err) {
		observability.SyncCommitFallback(raceReason(err))
		resp, err = s.commitEach(ctx, env, ops)
	}
	if err != nil {
		return syncproto.CommitResponse{}, err
	}
	if latest, err := vaults.GetVault(ctx, conn, vaultID); err == nil {
		resp.LastSeq = latest.LastSeq
	}
	return resp, nil
}

// recheckScope runs right after a write locked the vault: the share the caller
// works through was authorised before the lock, and a move_prefix holding it
// meanwhile may have rebased the share (or the owner revoked it). Paths are
// resolved against the share's root only after this check.
func (s *Service) recheckScope(ctx context.Context, tx db.DBTX, env commitEnv) error {
	if env.scope == nil {
		return nil
	}
	return sharing.RecheckScope(ctx, tx, env.userID, env.vault, env.scope, access.Editor)
}

type commitEnv struct {
	vault    vaults.Vault
	userID   uuid.UUID
	deviceID uuid.UUID
	quota    int64
	maxFile  int64
	// scope is set when the caller works through a share.
	scope *access.Scope
	// restore marks RestoreRevision: its modification is recorded as a
	// restore even when the file is live (§3.5.2).
	restore bool
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
	// startSeq is the vault's last_seq when the batch locked it; seq is the
	// last seq handed out since (the vault row lock makes that safe).
	startSeq, seq int64
	// usage of the vault (bytes, files), stored once with the last seq.
	vaultBytes int64
	vaultFiles int32
	// applied holds the operations of the batch already in the changelog:
	// read once for the whole batch, then completed as operations apply.
	applied map[uuid.UUID]appliedOp
	// rows holds the file rows the batch has locked, in their current state.
	rows map[uuid.UUID]syncdb.File
	// taken holds the file ids that exist (create must refuse them).
	taken map[uuid.UUID]bool
}

// appliedOp is where an operation landed in the changelog.
type appliedOp struct {
	fileID uuid.UUID
	rev    int32
	seq    int64
}

// errChargeRace means the final quota charge failed although every operation
// passed its check: another writer used the space meanwhile.
var errChargeRace = errors.New("sync: quota consumed concurrently")

func (e commitEnv) private() bool { return e.vault.Kind == "private" }

func (s *Service) notify(ctx context.Context, tx pgx.Tx, vaultID uuid.UUID, seq int64) error {
	// One notification per transaction: it carries the highest seq and
	// listeners coalesce per vault anyway.
	return notify.PublishVaultChanged(ctx, tx, vaultID, seq)
}

// commitBatch is the fast path: all operations in one transaction.
//
// While it holds the vault lock the batch keeps its round trips per operation
// low: the operation ids already applied, the file rows it changes (locked in
// id order) and the file ids it creates are read once up front; seqs are
// handed out in memory; the owner's usage, the vault's usage and last seq and
// the blob references are written once at the end (flushBatch).
func (s *Service) commitBatch(ctx context.Context, env commitEnv, ops []syncproto.Op) (syncproto.CommitResponse, error) {
	resp := syncproto.CommitResponse{Results: make([]syncproto.OpResult, 0, len(ops))}
	tx, err := s.db.Pool.Begin(ctx)
	if err != nil {
		return resp, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	lastSeq, err := vaults.LockVaultSeq(ctx, tx, env.vault.ID)
	if err != nil {
		return resp, err
	}
	if err := s.recheckScope(ctx, tx, env); err != nil {
		return resp, err
	}
	used, err := quota.UsedBytes(ctx, tx, env.vault.OwnerID)
	if err != nil {
		return resp, err
	}
	env.batch = &batchState{usedAtStart: used, refs: map[string]int32{}, startSeq: lastSeq, seq: lastSeq}
	if err := s.preload(ctx, tx, env, ops); err != nil {
		return resp, err
	}
	for _, op := range ops {
		res, err := s.execOp(ctx, tx, env, op)
		if res2, handled := business(op.OpID, err); handled {
			res, err = res2, nil
		}
		if err != nil {
			return resp, err
		}
		resp.Results = append(resp.Results, res)
	}
	if env.batch.seq > env.batch.startSeq {
		if err := s.flushBatch(ctx, tx, env); err != nil {
			return resp, err
		}
		if err := s.notify(ctx, tx, env.vault.ID, env.batch.seq); err != nil {
			return resp, err
		}
	}
	return resp, tx.Commit(ctx)
}

// preload reads, under the vault lock, what every operation of the batch would
// otherwise query on its own: the operation ids already applied, the rows of
// the files it changes (locked in id order, so the batch never waits on a row
// halfway) and which of the file ids it creates already exist.
func (s *Service) preload(ctx context.Context, tx db.DBTX, env commitEnv, ops []syncproto.Op) error {
	b := env.batch
	q := syncdb.New(tx)
	var opIDs, changed, created []uuid.UUID
	for _, op := range ops {
		if id, err := uuid.Parse(op.OpID); err == nil {
			opIDs = append(opIDs, id)
		}
		id, err := uuid.Parse(op.FileID)
		if err != nil {
			continue
		}
		switch op.Op {
		case syncproto.OpCreate:
			created = append(created, id)
		case syncproto.OpModify, syncproto.OpRestore, syncproto.OpMove, syncproto.OpDelete:
			changed = append(changed, id)
		}
	}
	b.applied = make(map[uuid.UUID]appliedOp, len(ops))
	b.rows = make(map[uuid.UUID]syncdb.File, len(changed))
	b.taken = make(map[uuid.UUID]bool, len(created))
	if len(opIDs) > 0 {
		prev, err := q.ListRevisionsByOpIDs(ctx, syncdb.ListRevisionsByOpIDsParams{VaultID: env.vault.ID, OpIds: opIDs})
		if err != nil {
			return err
		}
		for _, r := range prev {
			if r.OpID != nil {
				b.applied[*r.OpID] = appliedOp{fileID: r.FileID, rev: r.RevNo, seq: r.Seq}
			}
		}
	}
	if len(changed) > 0 {
		rows, err := q.LockFiles(ctx, syncdb.LockFilesParams{VaultID: env.vault.ID, Ids: changed})
		if err != nil {
			return err
		}
		for _, f := range rows {
			b.rows[f.ID] = f
		}
	}
	if len(created) > 0 {
		taken, err := q.ExistingFileIDs(ctx, created)
		if err != nil {
			return err
		}
		for _, id := range taken {
			b.taken[id] = true
		}
	}
	return nil
}

// flushBatch applies the accumulated usage charge, the vault's last seq and
// usage, and the blob references. Blob hashes are processed in sorted order so
// concurrent batches never deadlock.
func (s *Service) flushBatch(ctx context.Context, tx db.DBTX, env commitEnv) error {
	b := env.batch
	if b.delta != 0 {
		if err := quota.Charge(ctx, tx, env.vault.OwnerID, b.delta, env.quota); err != nil {
			var pe *httpproblem.Error
			if errors.As(err, &pe) && pe.Code == syncproto.CodeQuotaExceeded {
				return errChargeRace
			}
			return err
		}
	}
	if err := vaults.FinishVaultBatch(ctx, tx, vaults.FinishVaultBatchParams{
		ID: env.vault.ID, LastSeq: b.seq, TotalBytes: b.vaultBytes, FileCount: b.vaultFiles,
	}); err != nil {
		return err
	}
	hashes := make([]string, 0, len(b.refs))
	for h := range b.refs {
		hashes = append(hashes, h)
	}
	slices.Sort(hashes)
	deltas := make([]int32, len(hashes))
	for i, h := range hashes {
		deltas[i] = b.refs[h]
	}
	return blobs.AddRefs(ctx, tx, hashes, deltas)
}

// opAttempts bounds how often the slow path runs one operation again after a
// deadlock or serialization failure (PostgreSQL rolled the transaction back:
// running it again is safe, and the op id keeps it idempotent).
const opAttempts = 5

// commitEach is the slow path: one transaction per operation.
func (s *Service) commitEach(ctx context.Context, env commitEnv, ops []syncproto.Op) (syncproto.CommitResponse, error) {
	resp := syncproto.CommitResponse{Results: make([]syncproto.OpResult, 0, len(ops))}
	for _, op := range ops {
		var res syncproto.OpResult
		var err error
		for attempt := 1; ; attempt++ {
			err = s.db.WithTx(ctx, func(ctx context.Context, tx pgx.Tx) error {
				if err := vaults.LockVault(ctx, tx, env.vault.ID); err != nil {
					return err
				}
				if err := s.recheckScope(ctx, tx, env); err != nil {
					return err
				}
				var err error
				res, err = s.execOp(ctx, tx, env, op)
				if err != nil {
					return err
				}
				if res.Status == syncproto.StatusAccepted && res.Seq > 0 {
					return s.notify(ctx, tx, env.vault.ID, res.Seq)
				}
				return nil
			})
			if attempt >= opAttempts || !isRetryable(err) || ctx.Err() != nil {
				break
			}
		}
		switch {
		case isUnique(err, "files_path_uq"):
			res, err = syncproto.OpResult{OpID: op.OpID, Status: syncproto.StatusRejected, Code: syncproto.CodePathCollision, Detail: "another file already uses this path"}, nil
		case isUnique(err, "file_revisions_op_uq"):
			// A concurrent retry of the same operation won: it is applied.
			opID, _ := uuid.Parse(op.OpID)
			prev, gerr := syncdb.New(s.db.Pool).GetRevisionByOpID(ctx, syncdb.GetRevisionByOpIDParams{VaultID: env.vault.ID, OpID: &opID})
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
func (s *Service) execOp(ctx context.Context, tx db.DBTX, env commitEnv, op syncproto.Op) (syncproto.OpResult, error) {
	q := syncdb.New(tx)
	opID, err := uuid.Parse(op.OpID)
	if err != nil {
		return syncproto.OpResult{}, reject(syncproto.CodeValidationFailed, "op_id must be a UUID")
	}
	// A retried operation returns its original outcome (idempotency).
	if b := env.batch; b != nil {
		if a, ok := b.applied[opID]; ok {
			return accepted(op.OpID, a.fileID, a.rev, a.seq), nil
		}
		if env.scope != nil {
			if op, err = scopeOp(env.scope, op); err != nil {
				return syncproto.OpResult{}, err
			}
		}
		return s.dispatch(ctx, tx, env, op, opID)
	}
	prev, err := q.GetRevisionByOpID(ctx, syncdb.GetRevisionByOpIDParams{VaultID: env.vault.ID, OpID: &opID})
	if err == nil {
		return accepted(op.OpID, prev.FileID, prev.RevNo, prev.Seq), nil
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return syncproto.OpResult{}, err
	}
	if env.scope != nil {
		if op, err = scopeOp(env.scope, op); err != nil {
			return syncproto.OpResult{}, err
		}
	}
	return s.dispatch(ctx, tx, env, op, opID)
}

// scopeOp turns the paths of an operation sent through a share (relative to its root)
// into vault paths and refuses what the share cannot express.
func scopeOp(sc *access.Scope, op syncproto.Op) (syncproto.Op, error) {
	if sc.Type == access.ResourceFile {
		// A shared document can be edited (restoring a revision is an edit) or removed, not
		// moved, and nothing can be added beside it.
		if op.Op != syncproto.OpModify && op.Op != syncproto.OpRestore && op.Op != syncproto.OpDelete {
			return op, reject(syncproto.CodeForbidden, "a shared document can only be modified or deleted")
		}
		op.Path = ""
		return op, nil
	}
	abs := func(rel string) (string, error) {
		a, err := sc.Abs(rel)
		if err != nil {
			return "", reject(syncproto.CodePathInvalid, "%v", err)
		}
		return a, nil
	}
	var err error
	switch op.Op {
	case syncproto.OpCreate, syncproto.OpMove:
		if op.Path, err = abs(op.Path); err != nil {
			return op, err
		}
	case syncproto.OpModify:
		if op.Path != "" {
			if op.Path, err = abs(op.Path); err != nil {
				return op, err
			}
		}
	case syncproto.OpMovePrefix:
		if strings.Trim(op.From, "/") == "" || strings.Trim(op.To, "/") == "" {
			return op, reject(syncproto.CodeShareRootMove, "the root of a share cannot be renamed or moved from a mount")
		}
		if op.From, err = abs(op.From); err != nil {
			return op, err
		}
		if op.To, err = abs(op.To); err != nil {
			return op, err
		}
	}
	return op, nil
}

// business converts a rejection or conflict into the operation's result.
func business(opID string, err error) (syncproto.OpResult, bool) {
	var oe *opError
	var ce *conflictError
	var ae *appliedError
	switch {
	case errors.As(err, &ae):
		return accepted(opID, ae.rev.FileID, ae.rev.RevNo, ae.rev.Seq), true
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

// isRetryable reports a transaction PostgreSQL aborted only because of
// concurrency (deadlock, serialization failure): running it again can succeed.
func isRetryable(err error) bool {
	var pg *pgconn.PgError
	return errors.As(err, &pg) && (pg.Code == "40001" || pg.Code == "40P01")
}

// raceReason labels why the fast path fell back to the slow one (metrics).
func raceReason(err error) string {
	if errors.Is(err, errChargeRace) {
		return "quota"
	}
	var pg *pgconn.PgError
	if errors.As(err, &pg) {
		switch pg.Code {
		case "23505":
			return "unique"
		case "40001":
			return "serialization"
		case "40P01":
			return "deadlock"
		}
	}
	return "other"
}

func isUnique(err error, constraint string) bool {
	var pg *pgconn.PgError
	return errors.As(err, &pg) && pg.Code == "23505" && pg.ConstraintName == constraint
}

func accepted(opID string, fileID uuid.UUID, rev int32, seq int64) syncproto.OpResult {
	return syncproto.OpResult{OpID: opID, Status: syncproto.StatusAccepted, FileID: fileID.String(), Rev: int(rev), Seq: seq}
}

func (s *Service) dispatch(ctx context.Context, tx db.DBTX, env commitEnv, op syncproto.Op, opID uuid.UUID) (syncproto.OpResult, error) {
	switch op.Op {
	case syncproto.OpCreate:
		return s.create(ctx, tx, env, op, opID)
	case syncproto.OpModify, syncproto.OpRestore:
		return s.modify(ctx, tx, env, op, opID)
	case syncproto.OpMove:
		return s.move(ctx, tx, env, op, opID)
	case syncproto.OpDelete:
		return s.remove(ctx, tx, env, op, opID)
	case syncproto.OpMovePrefix:
		return s.movePrefix(ctx, tx, env, op, opID)
	default:
		return syncproto.OpResult{}, reject(syncproto.CodeValidationFailed, "unknown operation %q", op.Op)
	}
}

// resolvePath validates a path entering the vault (create, move, a revive at
// a new path) and returns it with its uniqueness key and file kind. Shared
// vaults carry clear paths the server normalizes, refusing names no Windows
// client could create (NormalizePortable); private vaults carry opaque tokens,
// enc1 or enc2 (ADR-0042), plus the client-computed key (§3.8.3, ADR-0009).
func resolvePath(env commitEnv, path, pathKey string) (p, key string, kind syncproto.FileKind, err error) {
	if env.private() {
		opaque := strings.HasPrefix(path, syncproto.OpaquePathPrefix) || strings.HasPrefix(path, syncproto.OpaquePathPrefixV2)
		if !opaque || len(path) > 1100 || len(path) < 10 || strings.ContainsAny(path, "/ \n\r\t") {
			return "", "", "", reject(syncproto.CodePathInvalid, "path must be an opaque enc1: or enc2: token")
		}
		if !strings.HasPrefix(pathKey, "hmac1:") || len(pathKey) != len("hmac1:")+64 || !blobs.IsHash(pathKey[len("hmac1:"):]) {
			return "", "", "", reject(syncproto.CodePathInvalid, "path_key must be hmac1:<64 hex>")
		}
		return path, pathKey, syncproto.KindOpaque, nil
	}
	norm, err := pathrules.NormalizePortable(path)
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
func (s *Service) checkBlob(ctx context.Context, tx db.DBTX, env commitEnv, hash string, declared int64) (int64, error) {
	if !blobs.IsHash(hash) {
		return 0, reject(syncproto.CodeValidationFailed, "blob_hash must be a SHA-256 hex digest")
	}
	size, ok, err := blobs.VaultBlob(ctx, tx, env.vault.ID, hash)
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

func chargeOwner(ctx context.Context, tx db.DBTX, env commitEnv, delta int64) error {
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
	if err := quota.Charge(ctx, tx, env.vault.OwnerID, delta, env.quota); err != nil {
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
	file      syncdb.File // new state of the files row (ID, Path, PathKey, Kind, BlobHash, Size, IsDeleted)
	exists    bool        // false: INSERT (create), true: UPDATE
	rev       int32
	op        string
	prevPath  *string
	baseRev   *int32
	clientMtm *timePtr
	opID      *uuid.UUID
	conflict  *uuid.UUID // revision of the original, for conflict copies
	// file of the original, for conflict copies: served by the changelog even
	// after retention prunes the revision
	conflictFile *uuid.UUID
}

func (s *Service) record(ctx context.Context, tx db.DBTX, env commitEnv, a recordArgs) (seq int64, err error) {
	q := syncdb.New(tx)
	if b := env.batch; b != nil {
		b.seq++
		seq = b.seq
	} else if seq, err = vaults.NextVaultSeq(ctx, tx, env.vault.ID); err != nil {
		return 0, err
	}
	f := a.file
	if a.exists {
		err = q.UpdateFile(ctx, syncdb.UpdateFileParams{
			ID: f.ID, Path: f.Path, PathKey: f.PathKey, Kind: f.Kind, CurrentRev: a.rev, CurrentSeq: seq,
			BlobHash: f.BlobHash, Size: f.Size, IsDeleted: f.IsDeleted,
		})
	} else {
		err = q.InsertFile(ctx, syncdb.InsertFileParams{
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
	if _, err := q.InsertRevision(ctx, syncdb.InsertRevisionParams{
		ID: revID, FileID: f.ID, VaultID: env.vault.ID, Seq: seq, RevNo: a.rev, Op: a.op, Path: f.Path, PrevPath: a.prevPath,
		BlobHash: f.BlobHash, Size: f.Size, BaseRev: a.baseRev, AuthorID: env.userID, DeviceID: devPtr, OpID: a.opID,
		ClientMtime: a.clientMtm.get(), ConflictOf: a.conflict, ConflictOfFile: a.conflictFile,
	}); err != nil {
		return 0, err
	}
	if f.BlobHash != nil {
		if env.batch != nil {
			env.batch.refs[*f.BlobHash]++
		} else if err := blobs.AddRef(ctx, tx, *f.BlobHash, 1); err != nil {
			return 0, err
		}
	}
	if b := env.batch; b != nil {
		// Later operations of the batch see the row as it is now.
		f.VaultID, f.CurrentRev, f.CurrentSeq = env.vault.ID, a.rev, seq
		b.rows[f.ID] = f
		b.taken[f.ID] = true
		if a.opID != nil {
			b.applied[*a.opID] = appliedOp{fileID: f.ID, rev: a.rev, seq: seq}
		}
	}
	return seq, nil
}

// addUsage changes the vault's usage counters: at the end of the batch on the
// fast path, at once otherwise.
func addUsage(ctx context.Context, tx db.DBTX, env commitEnv, bytes int64, files int32) error {
	if bytes == 0 && files == 0 {
		return nil
	}
	if b := env.batch; b != nil {
		b.vaultBytes += bytes
		b.vaultFiles += files
		return nil
	}
	return vaults.AddVaultUsage(ctx, tx, vaults.AddVaultUsageParams{ID: env.vault.ID, TotalBytes: bytes, FileCount: files})
}
