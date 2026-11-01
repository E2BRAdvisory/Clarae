// Package revisions serves file history: listing, reading the content of a
// revision, restoring one as a new revision, and the retention policy
// (§2.6.2, M2-WP1/WP7).
package revisions

import (
	"bytes"
	"context"
	"errors"
	"io"
	"maps"
	"slices"
	"strconv"
	"time"

	"memobrain/services/cloud/internal/access"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"memobrain/services/cloud/internal/blobs"
	"memobrain/services/cloud/internal/db"
	"memobrain/services/cloud/internal/httpproblem"
	"memobrain/services/cloud/internal/revisions/revisionsdb"
	"memobrain/services/cloud/internal/vaults"
	"memobrain/shared/syncproto"
)

// Restorer creates the new revision (implemented by the sync module).
type Restorer interface {
	RestoreRevision(ctx context.Context, userID, vaultID uuid.UUID, scope string, fileID uuid.UUID, rev int32, opID uuid.UUID) (syncproto.OpResult, error)
}

// BlobReader streams blob content (implemented by the blobs module).
type BlobReader interface {
	OpenForVault(ctx context.Context, vaultID uuid.UUID, hash string, rng *blobs.Range) (io.ReadCloser, int64, error)
}

// Service implements the revisions module.
type Service struct {
	db       *db.DB
	authz    access.Authorizer
	restorer Restorer
	blobs    BlobReader

	// RetentionBatch is the page size of Prune (zero: 5000).
	RetentionBatch int
}

// NewService wires the module.
func NewService(d *db.DB, a access.Authorizer, r Restorer, b BlobReader) *Service {
	return &Service{db: d, authz: a, restorer: r, blobs: b}
}

// readableFile authorizes a read of a file's history, through an optional
// share, and returns the share's scope (nil for the owner).
func (s *Service) readableFile(ctx context.Context, userID, vaultID uuid.UUID, scope string, fileID uuid.UUID) (*access.Scope, error) {
	acc, err := s.authz.Authorize(ctx, userID, vaultID, scope, access.Viewer)
	if err != nil {
		return nil, err
	}
	f, err := revisionsdb.New(s.db.Pool).GetFile(ctx, revisionsdb.GetFileParams{ID: fileID, VaultID: vaultID})
	if errors.Is(err, pgx.ErrNoRows) || (err == nil && acc.Scope != nil && !acc.Scope.ContainsFile(f.ID, f.Path)) {
		return nil, httpproblem.NotFound("file")
	}
	return acc.Scope, err
}

// project shows a revision through a share like the changelog does (§3.4.7):
// paths relative to the root, a move into the share as a create (where the
// file came from is not shared), a move out as a deletion without content.
// Revisions made while the file was outside the share are invisible.
func project(sc *access.Scope, r revisionsdb.FileRevision) (revisionsdb.FileRevision, bool) {
	if sc == nil {
		return r, true
	}
	pr, ok := sc.Project(r.FileID, r.Op, r.Path, r.PrevPath)
	if !ok {
		return revisionsdb.FileRevision{}, false
	}
	r.Op, r.Path, r.PrevPath = pr.Op, pr.Path, pr.PrevPath
	if !pr.Content {
		r.BlobHash, r.Size = nil, 0
	}
	return r, true
}

// scopedPages bounds the pages a share read scans to fill one page of visible
// revisions: a file with a long history outside the share costs bounded work.
const scopedPages = 20

// List returns revisions newest first, with a cursor for the next page.
func (s *Service) List(ctx context.Context, userID, vaultID uuid.UUID, scope string, fileID uuid.UUID, limit int, cursor string) ([]revisionsdb.FileRevision, string, error) {
	sc, err := s.readableFile(ctx, userID, vaultID, scope, fileID)
	if err != nil {
		return nil, "", err
	}
	conn := s.db.Pool
	q := revisionsdb.New(conn)
	before := int32(0)
	if cursor != "" {
		n, err := strconv.ParseInt(cursor, 10, 32)
		if err != nil || n < 0 {
			return nil, "", httpproblem.Errorf(syncproto.CodeValidationFailed, "invalid cursor")
		}
		before = int32(n)
	}
	if limit <= 0 || limit > 500 {
		limit = 100
	}
	out := make([]revisionsdb.FileRevision, 0, limit)
	for page := 0; page < scopedPages; page++ {
		rows, err := q.ListRevisions(ctx, revisionsdb.ListRevisionsParams{VaultID: vaultID, FileID: fileID, BeforeRev: before, MaxRows: int32(limit + 1)})
		if err != nil {
			return nil, "", err
		}
		more := len(rows) > limit
		if more {
			rows = rows[:limit]
		}
		for _, r := range rows {
			before = r.RevNo
			if v, ok := project(sc, r); ok {
				out = append(out, v)
				if len(out) == limit {
					// The page is full: continue after it if anything older exists.
					if more || r.RevNo != rows[len(rows)-1].RevNo {
						return out, strconv.Itoa(int(r.RevNo)), nil
					}
					return out, "", nil
				}
			}
		}
		if !more || before <= 1 {
			return out, "", nil
		}
	}
	// Bounded scan through a share: hand back what was found and where to go on.
	return out, strconv.Itoa(int(before)), nil
}

// Content opens the blob of a revision.
func (s *Service) Content(ctx context.Context, userID, vaultID uuid.UUID, scope string, fileID uuid.UUID, rev int32) (io.ReadCloser, int64, error) {
	sc, err := s.readableFile(ctx, userID, vaultID, scope, fileID)
	if err != nil {
		return nil, 0, err
	}
	r, err := revisionsdb.New(s.db.Pool).GetRevision(ctx, revisionsdb.GetRevisionParams{VaultID: vaultID, FileID: fileID, RevNo: rev})
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, 0, httpproblem.NotFound("revision")
	}
	if err != nil {
		return nil, 0, err
	}
	r, ok := project(sc, r)
	if !ok {
		return nil, 0, httpproblem.NotFound("revision")
	}
	if r.BlobHash == nil {
		return nil, 0, httpproblem.NotFound("revision content")
	}
	return s.blobs.OpenForVault(ctx, vaultID, *r.BlobHash, nil)
}

// Restore restores a revision as a new one.
func (s *Service) Restore(ctx context.Context, userID, vaultID uuid.UUID, scope string, fileID uuid.UUID, rev int32, opID uuid.UUID) (syncproto.OpResult, error) {
	return s.restorer.RestoreRevision(ctx, userID, vaultID, scope, fileID, rev, opID)
}

// RetentionPolicy defines which revisions survive (§2.6.2): everything newer
// than FullDays, then the last revision of each UTC day until DailyDays,
// nothing older. The current revision of a file is never pruned.
type RetentionPolicy struct {
	FullDays  int
	DailyDays int
}

// defaultRetentionBatch bounds the candidates of one retention transaction.
const defaultRetentionBatch = 5000

// Prune applies the policy and returns how many revisions were deleted. It
// walks the candidates in bounded pages, keyed on (file, time, id), so a huge
// backlog never holds a long transaction and pages full of survivors never
// stop it before the files that come after them.
//
// Deleting a changelog entry leaves a hole in "changes since" for the
// cursors before it. A plain content modify is superseded by the later
// revision of the same file, which carries the whole state (the current
// revision is never pruned); any other operation (create, move, delete,
// restore) is not, so the vault's compaction point advances past it and
// those cursors are refused with CURSOR_EXPIRED instead of silently missing
// a rename or a deletion.
func (s *Service) Prune(ctx context.Context, p RetentionPolicy, now time.Time) (int, error) {
	fullCut := now.AddDate(0, 0, -p.FullDays)
	dailyCut := now.AddDate(0, 0, -p.DailyDays)
	batch := s.RetentionBatch
	if batch <= 0 {
		batch = defaultRetentionBatch
	}
	q := revisionsdb.New(s.db.Pool)
	total := 0
	var after revisionsdb.ListRevisionsForRetentionRow // keyset: the zero value sorts first
	var carry []revisionsdb.ListRevisionsForRetentionRow
	for {
		rows, err := q.ListRevisionsForRetention(ctx, revisionsdb.ListRevisionsForRetentionParams{
			Cutoff: fullCut, AfterFile: after.FileID, AfterTime: after.ServerTime, AfterID: after.ID, MaxRows: int32(batch),
		})
		if err != nil {
			return total, err
		}
		more := len(rows) == batch
		if len(rows) > 0 {
			after = rows[len(rows)-1]
		}
		cands := slices.Concat(carry, rows)
		carry = nil
		if more {
			// Whether the last candidate has a successor on its day is known
			// only with the next page: it is decided there.
			carry = []revisionsdb.ListRevisionsForRetentionRow{cands[len(cands)-1]}
		}
		if doomed := selectDoomed(cands, dailyCut, more); len(doomed) > 0 {
			if err := s.deleteRevisions(ctx, doomed); err != nil {
				return total, err
			}
			total += len(doomed)
		}
		if !more {
			return total, nil
		}
	}
}

// deleteRevisions deletes one page of revisions, advances the compaction
// point of their vaults (see Prune) and releases their blob references. The
// vault rows are locked before the blobs, like a commit does.
func (s *Service) deleteRevisions(ctx context.Context, ids []uuid.UUID) error {
	return s.db.WithTx(ctx, func(ctx context.Context, tx pgx.Tx) error {
		deleted, err := revisionsdb.New(tx).DeleteRevisions(ctx, ids)
		if err != nil {
			return err
		}
		compaction := map[uuid.UUID]int64{}
		refs := map[string]int32{}
		for _, d := range deleted {
			if d.Op != "modify" && d.Seq > compaction[d.VaultID] {
				compaction[d.VaultID] = d.Seq
			}
			if d.BlobHash != nil {
				refs[*d.BlobHash]++
			}
		}
		vaultIDs := slices.SortedFunc(maps.Keys(compaction), func(a, b uuid.UUID) int { return bytes.Compare(a[:], b[:]) })
		for _, id := range vaultIDs {
			if err := vaults.AdvanceCompaction(ctx, tx, vaults.AdvanceCompactionParams{ID: id, Seq: compaction[id]}); err != nil {
				return err
			}
		}
		for _, h := range slices.Sorted(maps.Keys(refs)) {
			if err := blobs.AddRef(ctx, tx, h, -refs[h]); err != nil {
				return err
			}
		}
		return nil
	})
}

// selectDoomed picks the revisions to delete among candidates ordered by
// (file, time): all older than dailyCut, and within the daily window every
// revision except the last one of its UTC day. With lookahead the last
// candidate only tells whether the one before it has a successor on its day,
// and is not decided itself.
func selectDoomed(cands []revisionsdb.ListRevisionsForRetentionRow, dailyCut time.Time, lookahead bool) []uuid.UUID {
	n := len(cands)
	if lookahead {
		n--
	}
	var doomed []uuid.UUID
	for i := 0; i < n; i++ {
		c := cands[i]
		if c.ServerTime.Before(dailyCut) {
			doomed = append(doomed, c.ID)
			continue
		}
		next := i + 1
		sameDayLater := next < len(cands) && cands[next].FileID == c.FileID && sameUTCDay(cands[next].ServerTime, c.ServerTime) && !cands[next].ServerTime.Before(dailyCut)
		if sameDayLater {
			doomed = append(doomed, c.ID)
		}
	}
	return doomed
}

func sameUTCDay(a, b time.Time) bool {
	ay, am, ad := a.UTC().Date()
	by, bm, bd := b.UTC().Date()
	return ay == by && am == bm && ad == bd
}
