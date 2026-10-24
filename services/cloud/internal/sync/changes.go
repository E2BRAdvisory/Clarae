package sync

import (
	"context"
	"time"

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
func (s *Service) Changes(ctx context.Context, userID, vaultID uuid.UUID, since int64, limit int) (items []Change, next int64, more bool, err error) {
	v, err := s.vaults.Open(ctx, userID, vaultID)
	if err != nil {
		return nil, 0, false, err
	}
	if since < v.CompactionSeq {
		return nil, 0, false, &httpproblem.Error{
			Code: syncproto.CodeCursorExpired, Detail: "the cursor predates the changelog window: bootstrap from /tree",
			Extra: map[string]any{"compaction_seq": v.CompactionSeq},
		}
	}
	if limit <= 0 || limit > 500 {
		limit = 500
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
