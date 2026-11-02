package sync

import (
	"context"
	"time"

	"memobrain/services/cloud/internal/access"
	"memobrain/services/cloud/internal/vaults"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"memobrain/services/cloud/internal/db"
	"memobrain/services/cloud/internal/httpproblem"
	"memobrain/services/cloud/internal/sync/syncdb"
	"memobrain/shared/syncproto"
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

// ChangesPage is one page of the changelog.
type ChangesPage struct {
	Items []Change
	// Next is the cursor after the page and NextID the id of the change at it,
	// uuid.Nil when there is none (Next 0, or an entry pruned by retention).
	Next   int64
	NextID uuid.UUID
	More   bool
}

// Changes returns the entries after since, oldest first. A cursor the server
// cannot continue from is refused and the client bootstraps from the manifest
// (§3.4.4 B): one older than the compaction window, or one from a timeline
// the server lost to a restored backup. sinceID, when the client has it, is
// the id of the change at since and tells a seq reused after the restore
// apart (ADR-0046).
func (s *Service) Changes(ctx context.Context, userID, vaultID uuid.UUID, scope string, since int64, sinceID *uuid.UUID, limit int) (ChangesPage, error) {
	acc, err := s.authz.Authorize(ctx, userID, vaultID, scope, access.Viewer)
	if err != nil {
		return ChangesPage{}, err
	}
	if limit <= 0 || limit > 500 {
		limit = 500
	}
	// The cursor checks and the page read one snapshot: a retention prune that
	// committed in between would advance compaction_seq after the check and take
	// a structural entry out of the page unnoticed (ADR-0038).
	tx, err := s.db.Pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.RepeatableRead, AccessMode: pgx.ReadOnly})
	if err != nil {
		return ChangesPage{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	v, err := vaults.GetVault(ctx, tx, acc.Vault.ID)
	if err != nil {
		return ChangesPage{}, err
	}
	atSince, err := checkCursor(ctx, tx, v, since, sinceID)
	if err != nil {
		return ChangesPage{}, err
	}
	if acc.Scope != nil {
		return scopedChanges(ctx, tx, acc.Scope, v, since, atSince, limit)
	}
	rows, err := syncdb.New(tx).ListChanges(ctx, syncdb.ListChangesParams{VaultID: v.ID, Seq: since, Limit: int32(limit + 1)})
	if err != nil {
		return ChangesPage{}, err
	}
	page := ChangesPage{Next: since, NextID: atSince}
	if len(rows) > limit {
		rows, page.More = rows[:limit], true
	}
	page.Items = make([]Change, 0, len(rows))
	for _, r := range rows {
		page.Items = append(page.Items, Change{
			Seq: r.Seq, FileID: r.FileID, Op: r.Op, Path: r.Path, PrevPath: r.PrevPath, Rev: r.RevNo, BlobHash: r.BlobHash,
			Size: r.Size, AuthorID: r.AuthorID, DeviceID: r.DeviceID, ServerTime: r.ServerTime, ConflictOf: r.ConflictOfFile,
		})
		page.Next, page.NextID = r.Seq, r.ID
	}
	return page, nil
}

// checkCursor refuses a cursor the changelog of v cannot continue from, and
// returns the id of the change at since (uuid.Nil when there is none).
func checkCursor(ctx context.Context, tx db.DBTX, v vaults.Vault, since int64, sinceID *uuid.UUID) (uuid.UUID, error) {
	if since < v.CompactionSeq {
		return uuid.Nil, &httpproblem.Error{
			Code: syncproto.CodeCursorExpired, Detail: "the cursor predates the changelog window: bootstrap from /tree",
			Extra: map[string]any{"compaction_seq": v.CompactionSeq},
		}
	}
	if since > v.LastSeq {
		// The client is ahead of the server: the database was restored to an earlier point
		// in time (PITR), and new commits will reuse the sequence numbers the client
		// already consumed. Serving an empty page would make it miss them silently, so it
		// must bootstrap from /tree like for an expired cursor.
		return uuid.Nil, serverBehind(v, "the cursor is ahead of the server (restored backup?): bootstrap from /tree")
	}
	atSince, found, err := ChangeIDAt(ctx, tx, v.ID, since)
	if err != nil || sinceID == nil || since == 0 {
		return atSince, err
	}
	switch {
	case !found:
		// Seqs are handed out without gaps, so the entry was pruned by retention (a
		// superseded modify, which does not advance compaction_seq) and the cursor can
		// no longer be verified. Resuming blindly could skip changes reused after a
		// restore, and treating it as a restore would republish files deleted since:
		// the bootstrap of an expired cursor is the safe answer.
		return uuid.Nil, &httpproblem.Error{
			Code: syncproto.CodeCursorExpired, Detail: "the change at the cursor was pruned, the cursor cannot be verified: bootstrap from /tree",
			Extra: map[string]any{"compaction_seq": v.CompactionSeq},
		}
	case atSince != *sinceID:
		// The seq was consumed again after a restore of the database, by a device that
		// republished what the server lost (ADR-0046): the cursor is not beyond the end,
		// but what the client applied up to it is not what the server has.
		return uuid.Nil, serverBehind(v, "another change holds the seq of the cursor (restored backup?): bootstrap from /tree")
	}
	return atSince, nil
}

// serverBehind is the 410 of a cursor from a timeline the server lost: the
// extension member last_seq tells the client to republish what the server
// no longer has (ADR-0022, ADR-0046).
func serverBehind(v vaults.Vault, detail string) error {
	return &httpproblem.Error{
		Code: syncproto.CodeCursorExpired, Detail: detail,
		Extra: map[string]any{"last_seq": v.LastSeq},
	}
}

// Scanning limits of a scoped read: the changelog of the vault is walked in batches and
// filtered, so one request does bounded work however little of the vault the share covers.
const (
	scanBatch   = 500
	scanBatches = 20
)

// scopedChanges serves GET changes through a share (§3.4.7): revisions are kept when they
// touch the share, paths become relative to its root, a file leaving the share is shown as a
// delete and one entering it as a create. The cursor is a position in the vault's changelog,
// so it may stop on a revision the share does not show; its id is returned all the same.
func scopedChanges(ctx context.Context, tx db.DBTX, sc *access.Scope, v vaults.Vault, since int64, atSince uuid.UUID, limit int) (ChangesPage, error) {
	q := syncdb.New(tx)
	page := ChangesPage{Items: make([]Change, 0, limit), Next: since, NextID: atSince}
	// end closes the page at seq, looking up its id when the cursor jumps past
	// the last revision scanned.
	end := func(seq int64, more bool) (ChangesPage, error) {
		page.More = more
		if seq == page.Next {
			return page, nil
		}
		id, _, err := ChangeIDAt(ctx, tx, v.ID, seq)
		page.Next, page.NextID = seq, id
		return page, err
	}
	// The snapshot holds every seq up to its last_seq (commits take the vault lock in seq
	// order), so reaching it means the cursor can jump there even if nothing matched.
	for b := 0; b < scanBatches; b++ {
		rows, err := q.ListChanges(ctx, syncdb.ListChangesParams{VaultID: v.ID, Seq: page.Next, Limit: scanBatch})
		if err != nil {
			return ChangesPage{}, err
		}
		for _, r := range rows {
			if r.Seq > v.LastSeq {
				return end(v.LastSeq, false)
			}
			page.Next, page.NextID = r.Seq, r.ID
			if c, ok := scopeChange(sc, r); ok {
				page.Items = append(page.Items, c)
				if len(page.Items) == limit {
					return end(page.Next, page.Next < v.LastSeq)
				}
			}
		}
		if len(rows) < scanBatch {
			return end(v.LastSeq, false)
		}
	}
	return end(page.Next, page.Next < v.LastSeq)
}

// scopeChange translates one revision for a share, or reports that it is invisible to it.
func scopeChange(sc *access.Scope, r syncdb.FileRevision) (Change, bool) {
	pr, ok := sc.Project(r.FileID, r.Op, r.Path, r.PrevPath)
	if !ok {
		return Change{}, false
	}
	c := Change{
		Seq: r.Seq, FileID: r.FileID, Op: pr.Op, Path: pr.Path, PrevPath: pr.PrevPath, Rev: r.RevNo, BlobHash: r.BlobHash, Size: r.Size,
		AuthorID: r.AuthorID, DeviceID: r.DeviceID, ServerTime: r.ServerTime, ConflictOf: r.ConflictOfFile,
	}
	if !pr.Content {
		c.BlobHash, c.Size = nil, 0
	}
	return c, true
}
