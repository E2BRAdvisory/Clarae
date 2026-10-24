// Package revisions serves file history: listing, reading the content of a
// revision, restoring one as a new revision, and the retention policy
// (§2.6.2, M2-WP1/WP7).
package revisions

import (
	"context"
	"errors"
	"io"
	"strconv"
	"time"

	"nodus/services/cloud/internal/access"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"nodus/services/cloud/internal/blobs"
	"nodus/services/cloud/internal/db"
	"nodus/services/cloud/internal/db/dbgen"
	"nodus/services/cloud/internal/httpproblem"
	"nodus/shared/syncproto"
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
}

// NewService wires the module.
func NewService(d *db.DB, a access.Authorizer, r Restorer, b BlobReader) *Service {
	return &Service{db: d, authz: a, restorer: r, blobs: b}
}

// readableFile authorizes a read of a file's history, through an optional share.
func (s *Service) readableFile(ctx context.Context, userID, vaultID uuid.UUID, scope string, fileID uuid.UUID) error {
	acc, err := s.authz.Authorize(ctx, userID, vaultID, scope, access.Viewer)
	if err != nil {
		return err
	}
	f, err := s.db.Queries().GetFile(ctx, dbgen.GetFileParams{ID: fileID, VaultID: vaultID})
	if errors.Is(err, pgx.ErrNoRows) || (err == nil && acc.Scope != nil && !acc.Scope.ContainsFile(f.ID, f.Path)) {
		return httpproblem.NotFound("file")
	}
	return err
}

// List returns revisions newest first, with a cursor for the next page.
func (s *Service) List(ctx context.Context, userID, vaultID uuid.UUID, scope string, fileID uuid.UUID, limit int, cursor string) ([]dbgen.FileRevision, string, error) {
	if err := s.readableFile(ctx, userID, vaultID, scope, fileID); err != nil {
		return nil, "", err
	}
	q := s.db.Queries()
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
	rows, err := q.ListRevisions(ctx, dbgen.ListRevisionsParams{VaultID: vaultID, FileID: fileID, BeforeRev: before, MaxRows: int32(limit + 1)})
	if err != nil {
		return nil, "", err
	}
	next := ""
	if len(rows) > limit {
		rows = rows[:limit]
		next = strconv.Itoa(int(rows[len(rows)-1].RevNo))
	}
	return rows, next, nil
}

// Content opens the blob of a revision.
func (s *Service) Content(ctx context.Context, userID, vaultID uuid.UUID, scope string, fileID uuid.UUID, rev int32) (io.ReadCloser, int64, error) {
	if err := s.readableFile(ctx, userID, vaultID, scope, fileID); err != nil {
		return nil, 0, err
	}
	r, err := s.db.Queries().GetRevision(ctx, dbgen.GetRevisionParams{VaultID: vaultID, FileID: fileID, RevNo: rev})
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, 0, httpproblem.NotFound("revision")
	}
	if err != nil {
		return nil, 0, err
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

// Prune applies the policy and returns how many revisions were deleted. It
// works in bounded batches so a huge backlog never holds a long transaction.
func (s *Service) Prune(ctx context.Context, p RetentionPolicy, now time.Time) (int, error) {
	fullCut := now.AddDate(0, 0, -p.FullDays)
	dailyCut := now.AddDate(0, 0, -p.DailyDays)
	q := s.db.Queries()
	total := 0
	for {
		cands, err := q.ListRevisionsForRetention(ctx, dbgen.ListRevisionsForRetentionParams{ServerTime: fullCut, Limit: 5000})
		if err != nil {
			return total, err
		}
		if len(cands) == 0 {
			return total, nil
		}
		doomed := selectDoomed(cands, dailyCut)
		if len(doomed) == 0 {
			return total, nil
		}
		err = s.db.WithTx(ctx, func(ctx context.Context, q *dbgen.Queries, _ pgx.Tx) error {
			hashes, err := q.DeleteRevisions(ctx, doomed)
			if err != nil {
				return err
			}
			count := map[string]int32{}
			for _, h := range hashes {
				if h != nil {
					count[*h]++
				}
			}
			for h, n := range count {
				if err := blobs.AddRef(ctx, q, h, -n); err != nil {
					return err
				}
			}
			return nil
		})
		if err != nil {
			return total, err
		}
		total += len(doomed)
		if len(cands) < 5000 {
			return total, nil
		}
	}
}

// selectDoomed picks the revisions to delete among candidates ordered by
// (file, time): all older than dailyCut, and within the daily window every
// revision except the last one of its UTC day.
func selectDoomed(cands []dbgen.ListRevisionsForRetentionRow, dailyCut time.Time) []uuid.UUID {
	var doomed []uuid.UUID
	for i, c := range cands {
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
