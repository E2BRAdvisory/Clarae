package sync

import (
	"context"
	"path"
	"time"

	"nodus/services/cloud/internal/access"

	"github.com/google/uuid"

	"nodus/services/cloud/internal/db/dbgen"
	"nodus/services/cloud/internal/httpproblem"
	"nodus/shared/syncproto"
)

// Change is one changelog entry (§3.5.3).
type Change struct {
	Seq        int64
	FileID     uuid.UUID
	Op         string
	Path       string
	PrevPath   *string
	Rev        int32
	BlobHash   *string
	Size       int64
	AuthorID   uuid.UUID
	DeviceID   *uuid.UUID
	ServerTime time.Time
	ConflictOf *uuid.UUID // file id of the original, for conflict copies
}

// Changes returns the entries after since, oldest first. A cursor older than
// the compaction window is refused: the client must bootstrap from the
// manifest (§3.4.4 B).
func (s *Service) Changes(ctx context.Context, userID, vaultID uuid.UUID, scope string, since int64, limit int) (items []Change, next int64, more bool, err error) {
	acc, err := s.authz.Authorize(ctx, userID, vaultID, scope, access.Viewer)
	if err != nil {
		return nil, 0, false, err
	}
	v := acc.Vault
	if since < v.CompactionSeq {
		return nil, 0, false, &httpproblem.Error{
			Code: syncproto.CodeCursorExpired, Detail: "the cursor predates the changelog window: bootstrap from /tree",
			Extra: map[string]any{"compaction_seq": v.CompactionSeq},
		}
	}
	if limit <= 0 || limit > 500 {
		limit = 500
	}
	if acc.Scope != nil {
		return s.scopedChanges(ctx, acc, since, limit)
	}
	rows, err := s.db.Queries().ListChanges(ctx, dbgen.ListChangesParams{VaultID: vaultID, Seq: since, Limit: int32(limit + 1)})
	if err != nil {
		return nil, 0, false, err
	}
	if len(rows) > limit {
		rows, more = rows[:limit], true
	}
	items = make([]Change, 0, len(rows))
	next = since
	for _, r := range rows {
		var original *uuid.UUID
		if r.ConflictOfFile != uuid.Nil {
			id := r.ConflictOfFile
			original = &id
		}
		items = append(items, Change{
			Seq: r.Seq, FileID: r.FileID, Op: r.Op, Path: r.Path, PrevPath: r.PrevPath, Rev: r.RevNo, BlobHash: r.BlobHash,
			Size: r.Size, AuthorID: r.AuthorID, DeviceID: r.DeviceID, ServerTime: r.ServerTime, ConflictOf: original,
		})
		next = r.Seq
	}
	return items, next, more, nil
}

// Scanning limits of a scoped read: the changelog of the vault is walked in batches and
// filtered, so one request does bounded work however little of the vault the share covers.
const (
	scanBatch   = 500
	scanBatches = 20
)

// scopedChanges serves GET changes through a share (§3.4.7): revisions are kept when they
// touch the share, paths become relative to its root, a file leaving the share is shown as a
// delete and one entering it as a create.
func (s *Service) scopedChanges(ctx context.Context, acc access.Access, since int64, limit int) ([]Change, int64, bool, error) {
	q := s.db.Queries()
	// Every seq up to the committed last_seq is visible (commits take the vault lock in seq
	// order), so reaching it means the cursor can jump there even if nothing matched.
	head, err := q.GetVault(ctx, acc.Vault.ID)
	if err != nil {
		return nil, 0, false, err
	}
	items := make([]Change, 0, limit)
	cursor := since
	for b := 0; b < scanBatches; b++ {
		rows, err := q.ListChanges(ctx, dbgen.ListChangesParams{VaultID: acc.Vault.ID, Seq: cursor, Limit: scanBatch})
		if err != nil {
			return nil, 0, false, err
		}
		for _, r := range rows {
			if r.Seq > head.LastSeq {
				return items, head.LastSeq, false, nil
			}
			cursor = r.Seq
			if c, ok := scopeChange(acc.Scope, r); ok {
				items = append(items, c)
				if len(items) == limit {
					return items, cursor, cursor < head.LastSeq, nil
				}
			}
		}
		if len(rows) < scanBatch {
			return items, head.LastSeq, false, nil
		}
	}
	return items, cursor, cursor < head.LastSeq, nil
}

// scopeChange translates one revision for a share, or reports that it is invisible to it.
func scopeChange(sc *access.Scope, r dbgen.ListChangesRow) (Change, bool) {
	inNew := sc.ContainsFile(r.FileID, r.Path)
	inOld := r.PrevPath != nil && sc.ContainsFile(r.FileID, *r.PrevPath)
	var original *uuid.UUID
	if r.ConflictOfFile != uuid.Nil {
		id := r.ConflictOfFile
		original = &id
	}
	c := Change{
		Seq: r.Seq, FileID: r.FileID, Op: r.Op, Path: sc.Rel(r.Path), Rev: r.RevNo, BlobHash: r.BlobHash, Size: r.Size,
		AuthorID: r.AuthorID, DeviceID: r.DeviceID, ServerTime: r.ServerTime, ConflictOf: original,
	}
	switch r.Op {
	case "move":
		switch {
		case inOld && inNew:
			c.PrevPath = ptr(sc.Rel(*r.PrevPath))
			if sc.Type == access.ResourceFile && path.Base(r.Path) == path.Base(*r.PrevPath) {
				return Change{}, false // a document moving between folders does not change its name in the mount
			}
		case inOld:
			// It left the share: to the recipient it is gone.
			c.Op, c.Path, c.BlobHash, c.Size = "delete", sc.Rel(*r.PrevPath), nil, 0
		case inNew:
			c.Op = "create"
		default:
			return Change{}, false
		}
	default:
		if !inNew {
			return Change{}, false
		}
	}
	return c, true
}
