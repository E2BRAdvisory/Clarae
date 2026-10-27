// Package export builds ZIP archives of shared vaults (§2.6.4, M5-WP2). Small vaults
// stream straight to the client; larger ones become jobs whose ZIP lands in the
// exports bucket for 24 hours. Private (E2EE) vaults are refused with VAULT_ENCRYPTED:
// the server only holds ciphertext, so their ZIP is produced in the browser or the
// desktop app after decryption.
package export

import (
	"archive/zip"
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"path"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/rs/zerolog"

	"memobrain/services/cloud/internal/access"
	"memobrain/services/cloud/internal/audit"
	"memobrain/services/cloud/internal/db"
	"memobrain/services/cloud/internal/db/dbgen"
	"memobrain/services/cloud/internal/httpproblem"
	"memobrain/services/cloud/internal/storage"
	"memobrain/shared/pathrules"
	"memobrain/shared/syncproto"
)

const (
	// DirectLimit is the largest vault streamed within the request; beyond it a job is required.
	DirectLimit int64 = 512 << 20
	// LinkTTL is how long a finished export stays downloadable.
	LinkTTL = 24 * time.Hour
	// staleAfter requeues jobs whose worker disappeared while running.
	staleAfter = time.Hour
)

// Job statuses.
const (
	StatusQueued  = "queued"
	StatusRunning = "running"
	StatusReady   = "ready"
	StatusFailed  = "failed"
	StatusExpired = "expired"
)

// Service implements the export module.
type Service struct {
	db      *db.DB
	blobs   storage.BlobStore
	exports storage.BlobStore
	authz   access.Authorizer
	log     zerolog.Logger
	now     func() time.Time
}

// NewService wires the module. exports holds the finished archives (a separate bucket in
// production); blobs is the content store.
func NewService(d *db.DB, blobs, exports storage.BlobStore, a access.Authorizer, log zerolog.Logger) *Service {
	return &Service{db: d, blobs: blobs, exports: exports, authz: a, log: log, now: time.Now}
}

// SetClock replaces the time source (tests).
func (s *Service) SetClock(now func() time.Time) { s.now = now }

// vault authorizes the caller as owner of a live, non-encrypted vault.
func (s *Service) vault(ctx context.Context, user, vaultID uuid.UUID) (dbgen.Vault, error) {
	acc, err := s.authz.Authorize(ctx, user, vaultID, "", access.Owner)
	if err != nil {
		return dbgen.Vault{}, err
	}
	if acc.Vault.Kind == "private" {
		return dbgen.Vault{}, httpproblem.Errorf(syncproto.CodeVaultEncrypted, "a private vault is exported by the client, after decryption")
	}
	return acc.Vault, nil
}

// compressible lists text formats worth deflating; everything else is stored as is.
var compressible = map[string]bool{
	".md": true, ".canvas": true, ".base": true, ".excalidraw": true, ".json": true, ".txt": true,
	".csv": true, ".svg": true, ".html": true, ".css": true, ".js": true, ".xml": true, ".yaml": true, ".yml": true,
}

// skipped reports paths left out of an archive: what is device-specific or derived
// (workspace layout, caches, local databases) never belongs to the content of a vault.
// Sync already refuses them; this keeps old or foreign rows out of the archive too.
func skipped(p string) bool { return pathrules.IsExcluded(p, false) }

func (s *Service) writeZip(ctx context.Context, w io.Writer, vaultID uuid.UUID) error {
	files, err := s.db.Queries().ListExportFiles(ctx, vaultID)
	if err != nil {
		return err
	}
	zw := zip.NewWriter(w)
	for _, f := range files {
		if skipped(f.Path) || f.BlobHash == nil || path.Clean(f.Path) != f.Path || strings.HasPrefix(f.Path, "/") || strings.HasPrefix(f.Path, "../") {
			continue
		}
		method := zip.Store
		if compressible[strings.ToLower(path.Ext(f.Path))] {
			method = zip.Deflate
		}
		fw, err := zw.CreateHeader(&zip.FileHeader{Name: f.Path, Method: method, Modified: f.UpdatedAt})
		if err != nil {
			return err
		}
		rc, err := s.blobs.Get(ctx, storage.BlobKey(*f.BlobHash), 0, -1)
		if err != nil {
			return fmt.Errorf("export %s: %w", f.Path, err)
		}
		_, err = io.Copy(fw, rc)
		_ = rc.Close()
		if err != nil {
			return fmt.Errorf("export %s: %w", f.Path, err)
		}
	}
	return zw.Close()
}

// Stream returns a reader producing the ZIP of a vault and the suggested file name.
// The archive is generated while the reader is consumed; an error mid-way surfaces as a
// read error (and a truncated, invalid ZIP for the client).
func (s *Service) Stream(ctx context.Context, user, vaultID uuid.UUID) (io.ReadCloser, string, error) {
	v, err := s.vault(ctx, user, vaultID)
	if err != nil {
		return nil, "", err
	}
	if v.TotalBytes > DirectLimit {
		return nil, "", httpproblem.Errorf(syncproto.CodeInvalidState, "the vault is larger than %d MB: start an export job instead", DirectLimit>>20)
	}
	pr, pw := io.Pipe()
	go func() { pw.CloseWithError(s.writeZip(ctx, pw, vaultID)) }()
	s.audit(ctx, user, "vault.export", v.ID, map[string]string{"mode": "stream"})
	return pr, s.filename(v), nil
}

func (s *Service) audit(ctx context.Context, user uuid.UUID, action string, vaultID uuid.UUID, details any) {
	err := s.db.WithTx(ctx, func(ctx context.Context, q *dbgen.Queries, _ pgx.Tx) error {
		return audit.Record(ctx, q, user, action, "vault", vaultID.String(), details)
	})
	if err != nil {
		s.log.Warn().Err(err).Str("action", action).Msg("export: cannot write the audit entry")
	}
}

func (s *Service) filename(v dbgen.Vault) string {
	var b strings.Builder
	for _, r := range v.Name {
		switch {
		case r >= 'a' && r <= 'z', r >= 'A' && r <= 'Z', r >= '0' && r <= '9', r == '-', r == '_', r == '.':
			b.WriteRune(r)
		case r == ' ':
			b.WriteByte('_')
		}
	}
	name := strings.Trim(b.String(), "._")
	if name == "" {
		name = "vault"
	}
	return name + "-" + s.now().UTC().Format("20060102") + ".zip"
}

// Create queues an export job for a vault of any size.
func (s *Service) Create(ctx context.Context, user, vaultID uuid.UUID) (dbgen.ExportJob, error) {
	v, err := s.vault(ctx, user, vaultID)
	if err != nil {
		return dbgen.ExportJob{}, err
	}
	var j dbgen.ExportJob
	err = s.db.WithTx(ctx, func(ctx context.Context, q *dbgen.Queries, _ pgx.Tx) error {
		var err error
		if j, err = q.CreateExportJob(ctx, dbgen.CreateExportJobParams{ID: uuid.Must(uuid.NewV7()), VaultID: v.ID, RequestedBy: user}); err != nil {
			return err
		}
		return audit.Record(ctx, q, user, "vault.export", "vault", v.ID.String(), map[string]string{"mode": "job", "job": j.ID.String()})
	})
	return j, err
}

// Job returns a job of a vault the caller owns.
func (s *Service) Job(ctx context.Context, user, vaultID, jobID uuid.UUID) (dbgen.ExportJob, error) {
	if _, err := s.vault(ctx, user, vaultID); err != nil {
		return dbgen.ExportJob{}, err
	}
	j, err := s.db.Queries().GetExportJob(ctx, dbgen.GetExportJobParams{ID: jobID, VaultID: vaultID})
	if errors.Is(err, pgx.ErrNoRows) {
		return dbgen.ExportJob{}, httpproblem.NotFound("export")
	}
	return j, err
}

func objectKey(id uuid.UUID) string { return "exports/" + id.String() + ".zip" }

// DownloadURL is where a ready job is fetched: a presigned object URL when the store has a
// public endpoint, otherwise the authenticated API path ("").
func (s *Service) DownloadURL(ctx context.Context, j dbgen.ExportJob, name string) string {
	if j.Status != StatusReady {
		return ""
	}
	if p, ok := s.exports.(storage.Presigner); ok {
		if u, err := p.PresignGet(ctx, objectKey(j.ID), name, time.Until(*j.ExpiresAt)); err == nil && u != "" {
			return u
		}
	}
	return fmt.Sprintf("/api/v1/vaults/%s/exports/%s/download", j.VaultID, j.ID)
}

// Name is the file name proposed for a job's archive.
func (s *Service) Name(ctx context.Context, j dbgen.ExportJob) string {
	v, err := s.db.Queries().GetVault(ctx, j.VaultID)
	if err != nil {
		return "vault.zip"
	}
	return s.filename(v)
}

// Open streams a ready archive.
func (s *Service) Open(ctx context.Context, user, vaultID, jobID uuid.UUID) (io.ReadCloser, int64, string, error) {
	j, err := s.Job(ctx, user, vaultID, jobID)
	if err != nil {
		return nil, 0, "", err
	}
	if j.Status != StatusReady || (j.ExpiresAt != nil && j.ExpiresAt.Before(s.now())) {
		return nil, 0, "", httpproblem.NotFound("export")
	}
	rc, err := s.exports.Get(ctx, objectKey(j.ID), 0, -1)
	if errors.Is(err, storage.ErrNotFound) {
		return nil, 0, "", httpproblem.NotFound("export")
	}
	if err != nil {
		return nil, 0, "", err
	}
	var size int64
	if j.Size != nil {
		size = *j.Size
	}
	return rc, size, s.Name(ctx, j), nil
}

// ProcessPending builds queued jobs until none is left and returns how many it handled.
func (s *Service) ProcessPending(ctx context.Context) (int, error) {
	n := 0
	for ctx.Err() == nil {
		j, err := s.db.Queries().ClaimExportJob(ctx)
		if errors.Is(err, pgx.ErrNoRows) {
			return n, nil
		}
		if err != nil {
			return n, err
		}
		n++
		if err := s.build(ctx, j); err != nil {
			s.log.Error().Err(err).Str("job", j.ID.String()).Msg("export job failed")
			msg := err.Error()
			if len(msg) > 500 {
				msg = msg[:500]
			}
			if ferr := s.db.Queries().FailExportJob(context.WithoutCancel(ctx), dbgen.FailExportJobParams{ID: j.ID, Error: &msg}); ferr != nil {
				return n, ferr
			}
		}
	}
	return n, ctx.Err()
}

func (s *Service) build(ctx context.Context, j dbgen.ExportJob) error {
	tmp, err := os.CreateTemp("", "memobrain-export-*.zip")
	if err != nil {
		return err
	}
	defer func() { _ = os.Remove(tmp.Name()); _ = tmp.Close() }()
	if err := s.writeZip(ctx, tmp, j.VaultID); err != nil {
		return err
	}
	size, err := tmp.Seek(0, io.SeekCurrent)
	if err != nil {
		return err
	}
	if _, err := tmp.Seek(0, io.SeekStart); err != nil {
		return err
	}
	if err := s.exports.Put(ctx, objectKey(j.ID), tmp, size); err != nil {
		return err
	}
	exp := s.now().Add(LinkTTL)
	return s.db.Queries().FinishExportJob(ctx, dbgen.FinishExportJobParams{ID: j.ID, Size: &size, ObjectKey: ptrStr(objectKey(j.ID)), ExpiresAt: &exp})
}

func ptrStr(s string) *string { return &s }

// Expire retires finished exports past their 24 hours, deleting the archives, and requeues
// jobs abandoned by a crashed worker.
func (s *Service) Expire(ctx context.Context) error {
	rows, err := s.db.Queries().ExpireExportJobs(ctx, s.now())
	if err != nil {
		return err
	}
	for _, r := range rows {
		if r.ObjectKey != nil {
			if err := s.exports.Delete(ctx, *r.ObjectKey); err != nil {
				s.log.Warn().Err(err).Str("key", *r.ObjectKey).Msg("export: cannot delete an expired archive")
			}
		}
	}
	_, err = s.db.Queries().RequeueStaleExportJobs(ctx, s.now().Add(-staleAfter))
	return err
}
