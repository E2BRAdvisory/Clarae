package sync

import (
	"context"
	"errors"
	"strings"
	"time"

	"memobrain/services/cloud/internal/access"
	"memobrain/services/cloud/internal/db"
	"memobrain/services/cloud/internal/sharing"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"memobrain/services/cloud/internal/sync/syncdb"
	"memobrain/shared/pathrules"
	"memobrain/shared/syncproto"
)

// timePtr adapts the optional client mtime.
type timePtr struct{ t *time.Time }

func (p *timePtr) get() *time.Time {
	if p == nil {
		return nil
	}
	return p.t
}

func mtime(op syncproto.Op) *timePtr {
	if op.ClientMtime == nil {
		return nil
	}
	return &timePtr{t: op.ClientMtime}
}

func ptr[T any](v T) *T { return &v }

func (s *Service) create(ctx context.Context, tx db.DBTX, env commitEnv, op syncproto.Op, opID uuid.UUID) (syncproto.OpResult, error) {
	q := syncdb.New(tx)
	fileID, err := parseFileID(op)
	if err != nil {
		return syncproto.OpResult{}, err
	}
	if b := env.batch; b != nil {
		if b.taken[fileID] {
			return syncproto.OpResult{}, reject(syncproto.CodeValidationFailed, "file_id already exists")
		}
	} else if exists, err := q.FileIDExists(ctx, fileID); err != nil {
		return syncproto.OpResult{}, err
	} else if exists {
		return syncproto.OpResult{}, reject(syncproto.CodeValidationFailed, "file_id already exists")
	}
	path, key, kind, err := resolvePath(env, op.Path, op.PathKey)
	if err != nil {
		return syncproto.OpResult{}, err
	}
	size, err := s.checkBlob(ctx, tx, env, op.BlobHash, op.Size)
	if err != nil {
		return syncproto.OpResult{}, err
	}
	if _, err := q.PathKeyTaken(ctx, syncdb.PathKeyTakenParams{VaultID: env.vault.ID, PathKey: key}); err == nil {
		return syncproto.OpResult{}, reject(syncproto.CodePathCollision, "%s already exists", displayPath(env, path))
	} else if !errors.Is(err, pgx.ErrNoRows) {
		return syncproto.OpResult{}, err
	}
	var conflictRev, conflictFile *uuid.UUID
	if op.ConflictOf != "" {
		if cid, perr := uuid.Parse(op.ConflictOf); perr == nil {
			if cf, gerr := q.GetFile(ctx, syncdb.GetFileParams{ID: cid, VaultID: env.vault.ID}); gerr == nil {
				// The file id is kept on its own: retention may prune the revision later.
				conflictFile = ptr(cf.ID)
				if rid, rerr := q.GetCurrentRevisionID(ctx, syncdb.GetCurrentRevisionIDParams{FileID: cf.ID, RevNo: cf.CurrentRev}); rerr == nil {
					conflictRev = &rid
				}
			}
		}
	}
	if err := chargeOwner(ctx, tx, env, size); err != nil {
		return syncproto.OpResult{}, err
	}
	f := syncdb.File{ID: fileID, VaultID: env.vault.ID, Path: path, PathKey: key, Kind: string(kind), BlobHash: ptr(op.BlobHash), Size: size}
	seq, err := s.record(ctx, tx, env, recordArgs{file: f, rev: 1, op: "create", clientMtm: mtime(op), opID: &opID, conflict: conflictRev, conflictFile: conflictFile})
	if err != nil {
		return syncproto.OpResult{}, err
	}
	if err := addUsage(ctx, tx, env, size, 1); err != nil {
		return syncproto.OpResult{}, err
	}
	return accepted(op.OpID, fileID, 1, seq), nil
}

func displayPath(env commitEnv, path string) string {
	if env.private() {
		return "the target path"
	}
	return path
}

// lockFile loads the file for update and enforces the optimistic concurrency
// rule: the client must have based its change on the current revision.
func (s *Service) lockFile(ctx context.Context, tx db.DBTX, env commitEnv, op syncproto.Op) (syncdb.File, error) {
	q := syncdb.New(tx)
	fileID, err := parseFileID(op)
	if err != nil {
		return syncdb.File{}, err
	}
	f, cached := syncdb.File{}, false
	if b := env.batch; b != nil {
		f, cached = b.rows[fileID]
	}
	if !cached {
		f, err = q.GetFileForUpdate(ctx, syncdb.GetFileForUpdateParams{ID: fileID, VaultID: env.vault.ID})
		if errors.Is(err, pgx.ErrNoRows) {
			return syncdb.File{}, reject(syncproto.CodeNotFound, "file not found")
		}
		if err != nil {
			return syncdb.File{}, err
		}
		if b := env.batch; b != nil {
			b.rows[f.ID] = f
		}
	}
	if env.scope != nil && !env.scope.ContainsFile(f.ID, f.Path) {
		// Outside the share the file does not exist for the caller.
		return syncdb.File{}, reject(syncproto.CodeNotFound, "file not found")
	}
	if op.BaseRev == nil {
		return syncdb.File{}, reject(syncproto.CodeValidationFailed, "base_rev is required")
	}
	if int64(*op.BaseRev) != int64(f.CurrentRev) {
		// A retry that overlapped its own original (sent again while the first
		// request was still running) may have passed the idempotency check
		// before the original committed: what it finds now is its own write.
		if opID, err := uuid.Parse(op.OpID); err == nil {
			prev, err := q.GetRevisionByOpID(ctx, syncdb.GetRevisionByOpIDParams{VaultID: env.vault.ID, OpID: &opID})
			if err == nil {
				return syncdb.File{}, &appliedError{rev: prev}
			}
			if !errors.Is(err, pgx.ErrNoRows) {
				return syncdb.File{}, err
			}
		}
		return syncdb.File{}, &conflictError{f: f}
	}
	return f, nil
}

func (s *Service) modify(ctx context.Context, tx db.DBTX, env commitEnv, op syncproto.Op, opID uuid.UUID) (syncproto.OpResult, error) {
	q := syncdb.New(tx)
	f, err := s.lockFile(ctx, tx, env, op)
	if err != nil {
		return syncproto.OpResult{}, err
	}
	size, err := s.checkBlob(ctx, tx, env, op.BlobHash, op.Size)
	if err != nil {
		return syncproto.OpResult{}, err
	}
	revive := f.IsDeleted
	kind := f.Kind
	path, key := f.Path, f.PathKey
	if revive {
		// A modification of a deleted file brings it back ("modification wins").
		if op.Path != "" {
			var k syncproto.FileKind
			if path, key, k, err = resolvePath(env, op.Path, op.PathKey); err != nil {
				return syncproto.OpResult{}, err
			}
			kind = string(k)
		}
		if taken, err := q.PathKeyTaken(ctx, syncdb.PathKeyTakenParams{VaultID: env.vault.ID, PathKey: key}); err == nil && taken != f.ID {
			return syncproto.OpResult{}, reject(syncproto.CodePathCollision, "%s is used by another file now", displayPath(env, path))
		} else if err != nil && !errors.Is(err, pgx.ErrNoRows) {
			return syncproto.OpResult{}, err
		}
	}
	old := f.Size
	if revive {
		old = 0
	}
	if err := chargeOwner(ctx, tx, env, size-old); err != nil {
		return syncproto.OpResult{}, err
	}
	opName := "modify"
	if revive || env.restore {
		opName = "restore"
	}
	nf := f
	nf.Path, nf.PathKey, nf.Kind, nf.BlobHash, nf.Size, nf.IsDeleted = path, key, kind, ptr(op.BlobHash), size, false
	rev := f.CurrentRev + 1
	seq, err := s.record(ctx, tx, env, recordArgs{file: nf, exists: true, rev: rev, op: opName, baseRev: ptr(f.CurrentRev), clientMtm: mtime(op), opID: &opID})
	if err != nil {
		return syncproto.OpResult{}, err
	}
	files := int32(0)
	if revive {
		files = 1
	}
	if err := addUsage(ctx, tx, env, size-old, files); err != nil {
		return syncproto.OpResult{}, err
	}
	return accepted(op.OpID, f.ID, rev, seq), nil
}

func (s *Service) move(ctx context.Context, tx db.DBTX, env commitEnv, op syncproto.Op, opID uuid.UUID) (syncproto.OpResult, error) {
	q := syncdb.New(tx)
	f, err := s.lockFile(ctx, tx, env, op)
	if err != nil {
		return syncproto.OpResult{}, err
	}
	if f.IsDeleted {
		return syncproto.OpResult{}, reject(syncproto.CodeValidationFailed, "file is deleted")
	}
	path, key, kind, err := resolvePath(env, op.Path, op.PathKey)
	if err != nil {
		return syncproto.OpResult{}, err
	}
	if path == f.Path {
		return syncproto.OpResult{}, reject(syncproto.CodeValidationFailed, "path is unchanged")
	}
	if taken, err := q.PathKeyTaken(ctx, syncdb.PathKeyTakenParams{VaultID: env.vault.ID, PathKey: key}); err == nil && taken != f.ID {
		return syncproto.OpResult{}, reject(syncproto.CodePathCollision, "%s already exists", displayPath(env, path))
	} else if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		return syncproto.OpResult{}, err
	}
	if err := s.checkShareRoot(ctx, tx, env, f, path); err != nil {
		return syncproto.OpResult{}, err
	}
	nf := f
	nf.Path, nf.PathKey, nf.Kind = path, key, string(kind)
	rev := f.CurrentRev + 1
	seq, err := s.record(ctx, tx, env, recordArgs{file: nf, exists: true, rev: rev, op: "move", prevPath: ptr(f.Path), baseRev: ptr(f.CurrentRev), clientMtm: mtime(op), opID: &opID})
	if err != nil {
		return syncproto.OpResult{}, err
	}
	return accepted(op.OpID, f.ID, rev, seq), nil
}

func (s *Service) remove(ctx context.Context, tx db.DBTX, env commitEnv, op syncproto.Op, opID uuid.UUID) (syncproto.OpResult, error) {
	f, err := s.lockFile(ctx, tx, env, op)
	if err != nil {
		return syncproto.OpResult{}, err
	}
	if f.IsDeleted {
		return accepted(op.OpID, f.ID, f.CurrentRev, f.CurrentSeq), nil // already gone
	}
	if err := chargeOwner(ctx, tx, env, -f.Size); err != nil {
		return syncproto.OpResult{}, err
	}
	nf := f
	nf.BlobHash, nf.Size, nf.IsDeleted = nil, 0, true
	rev := f.CurrentRev + 1
	seq, err := s.record(ctx, tx, env, recordArgs{file: nf, exists: true, rev: rev, op: "delete", baseRev: ptr(f.CurrentRev), clientMtm: mtime(op), opID: &opID})
	if err != nil {
		return syncproto.OpResult{}, err
	}
	if err := addUsage(ctx, tx, env, -f.Size, -1); err != nil {
		return syncproto.OpResult{}, err
	}
	return accepted(op.OpID, f.ID, rev, seq), nil
}

// checkShareRoot refuses a file-by-file rename that would move the last file out of a
// folder share: to the recipients the whole root would vanish (SHARE_ROOT_MOVE, §3.4.7);
// renaming the folder is a move_prefix, which carries the share along.
func (s *Service) checkShareRoot(ctx context.Context, tx db.DBTX, env commitEnv, f syncdb.File, newPath string) error {
	return s.checkShareRoots(ctx, tx, env, f.Path, newPath, 1)
}

// checkShareRoots refuses a move of n files from below from (a file path, or a
// folder for a move_prefix) to below to that would leave a folder share empty:
// every live folder share that contains from without containing to must keep at
// least one file. A folder rename that carries the root of a share (the root
// itself or a folder above it) is not concerned: RebasePrefixShares moves the
// share with it. The rule holds for the owner and for an editor working through
// a mount: a share nested inside the mount belongs to other recipients, whose
// whole mount would vanish just the same. Private vaults have no shares.
func (s *Service) checkShareRoots(ctx context.Context, tx db.DBTX, env commitEnv, from, to string, n int) error {
	if env.private() {
		return nil
	}
	q := syncdb.New(tx)
	shares, err := sharing.ListLiveSharesOfVault(ctx, tx, env.vault.ID)
	if err != nil {
		return err
	}
	for _, sh := range shares {
		if sh.ResourceType != access.ResourceFolder {
			continue
		}
		sc := access.NewScope(sh.ID, sh.ResourceType, sh.PathPrefix, sh.FileID)
		if !sc.ContainsPath(from) || sc.ContainsPath(to) {
			continue
		}
		key := pathrules.Key(sc.Prefix)
		count, err := q.CountFilesUnderPrefix(ctx, syncdb.CountFilesUnderPrefixParams{VaultID: env.vault.ID, Exact: key, Descendants: likeEscape(key) + "/%"})
		if err != nil {
			return err
		}
		if int(count) <= n {
			return reject(syncproto.CodeShareRootMove, "moving %s would take the last file out of the shared folder %s: rename the folder instead",
				scopedPath(env, from), scopedPath(env, sc.Prefix))
		}
	}
	return nil
}

// scopedPath is a vault path as the caller sees it: relative to the root of the
// share it works through (a nested share's root, inside the mount), or as is.
func scopedPath(env commitEnv, p string) string {
	if env.scope != nil && env.scope.ContainsPath(p) {
		return env.scope.Rel(p)
	}
	return p
}

// likeEscape escapes LIKE metacharacters of a path key used as a prefix.
func likeEscape(s string) string {
	r := strings.NewReplacer(`\`, `\\`, `%`, `\%`, `_`, `\_`)
	return r.Replace(s)
}

// movePrefix renames a folder atomically: every file below it gets a move
// revision, or none does (shared vaults only; private vaults emit one move
// per file because the server cannot see folders, §3.8.5).
func (s *Service) movePrefix(ctx context.Context, tx db.DBTX, env commitEnv, op syncproto.Op, opID uuid.UUID) (syncproto.OpResult, error) {
	q := syncdb.New(tx)
	if env.private() {
		return syncproto.OpResult{}, reject(syncproto.CodeVaultEncrypted, "move_prefix is not available on private vaults")
	}
	from, err := pathrules.Normalize(op.From)
	if err != nil {
		return syncproto.OpResult{}, reject(syncproto.CodePathInvalid, "from: %v", err)
	}
	to, err := pathrules.NormalizePortable(op.To) // the new folder names enter the vault
	if err != nil {
		return syncproto.OpResult{}, reject(syncproto.CodePathInvalid, "to: %v", err)
	}
	fromKey, toKey := pathrules.Key(from), pathrules.Key(to)
	if from == to {
		return syncproto.OpResult{}, reject(syncproto.CodeValidationFailed, "path is unchanged")
	}
	// Equal keys with different paths is a case-only rename ("notes" to "Notes"): allowed.
	if strings.HasPrefix(toKey, fromKey+"/") {
		return syncproto.OpResult{}, reject(syncproto.CodePathInvalid, "a folder cannot move into itself")
	}
	files, err := q.ListFilesUnderPrefix(ctx, syncdb.ListFilesUnderPrefixParams{VaultID: env.vault.ID, Exact: fromKey, Descendants: likeEscape(fromKey) + "/%"})
	if err != nil {
		return syncproto.OpResult{}, err
	}
	if len(files) == 0 {
		return syncproto.OpResult{}, reject(syncproto.CodeNotFound, "nothing under %s", from)
	}
	moving := make(map[uuid.UUID]bool, len(files))
	for _, f := range files {
		moving[f.ID] = true
	}
	depth := len(strings.Split(from, "/"))
	type target struct {
		f         syncdb.File
		path, key string
		kind      syncproto.FileKind
	}
	targets := make([]target, 0, len(files))
	for _, f := range files {
		segs := strings.Split(f.Path, "/")
		rest := segs[min(depth, len(segs)):]
		np := to
		if len(rest) > 0 && len(segs) != depth {
			np = to + "/" + strings.Join(rest, "/")
		}
		if pathrules.Validate(np) != nil {
			return syncproto.OpResult{}, reject(syncproto.CodePathInvalid, "moving would create an invalid path: %s", np)
		}
		nk := pathrules.Key(np)
		if taken, err := q.PathKeyTaken(ctx, syncdb.PathKeyTakenParams{VaultID: env.vault.ID, PathKey: nk}); err == nil && !moving[taken] {
			return syncproto.OpResult{}, reject(syncproto.CodePathCollision, "%s already exists", np)
		} else if err != nil && !errors.Is(err, pgx.ErrNoRows) {
			return syncproto.OpResult{}, err
		}
		targets = append(targets, target{f: f, path: np, key: nk, kind: syncproto.KindOf(np)})
	}
	// A folder inside a share that takes all of the share's files elsewhere would
	// empty it, exactly as moving them one by one would (SHARE_ROOT_MOVE).
	if err := s.checkShareRoots(ctx, tx, env, from, to, len(files)); err != nil {
		return syncproto.OpResult{}, err
	}
	var last int64
	var lastRev int32
	for i, t := range targets {
		nf := t.f
		nf.Path, nf.PathKey, nf.Kind = t.path, t.key, string(t.kind)
		var id *uuid.UUID
		if i == 0 {
			id = &opID // only the first revision can carry the idempotency id
		}
		rev := t.f.CurrentRev + 1
		seq, err := s.record(ctx, tx, env, recordArgs{file: nf, exists: true, rev: rev, op: "move", prevPath: ptr(t.f.Path), baseRev: ptr(t.f.CurrentRev), clientMtm: mtime(op), opID: id})
		if err != nil {
			return syncproto.OpResult{}, err
		}
		last, lastRev = seq, rev
	}
	// The shares rooted at or below the renamed folder follow it, also when an
	// editor renames it through a mount: the shares nested inside it would be left
	// pointing at a folder that no longer exists. The mount's own root is never
	// among them (scopeOp refuses renaming it, and from lies strictly below it).
	if err := sharing.RebasePrefixShares(ctx, tx, sharing.RebasePrefixSharesParams{
		VaultID: env.vault.ID, ToPath: to, FromPath: from, LikeFrom: likeEscape(from) + "/%",
	}); err != nil {
		return syncproto.OpResult{}, err
	}
	return accepted(op.OpID, targets[len(targets)-1].f.ID, lastRev, last), nil
}
