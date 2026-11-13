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
	stdsync "sync"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/rs/zerolog"

	"clarae/services/cloud/internal/access"
	"clarae/services/cloud/internal/audit"
	"clarae/services/cloud/internal/db"
	"clarae/services/cloud/internal/export/exportdb"
	"clarae/services/cloud/internal/httpproblem"
	"clarae/services/cloud/internal/settings"
	"clarae/services/cloud/internal/storage"
	"clarae/services/cloud/internal/sync"
	"clarae/services/cloud/internal/vaults"
	"clarae/shared/pathrules"
	"clarae/shared/syncproto"
)

const (
	// DirectLimit is the largest vault streamed within the request; beyond it a job is required.
	DirectLimit int64 = 512 << 20
	// LinkTTL is how long a finished export stays downloadable.
	LinkTTL = 24 * time.Hour
	// staleAfter requeues jobs whose worker disappeared while running: it is
	// the lease of a running job, renewed every staleAfter/4 while it builds.
	staleAfter = time.Hour
	// DefaultWorkers is how many archives are built in parallel (setting exports.workers).
	DefaultWorkers = 2
	// DefaultMaxActivePerUser bounds the queued and running jobs of one user,
	// and separately the direct streams one user has open on an API node
	// (setting exports.max_active_per_user).
	DefaultMaxActivePerUser = 3
	// jobsPerWorker bounds the jobs one worker builds per ProcessPending call,
	// so expired archives are retired between rounds even with a long queue.
	jobsPerWorker = 4
	// reuseMinValidity is how long a ready archive must still be downloadable
	// for a new request on the unchanged vault to get it instead of a new one.
	reuseMinValidity = time.Hour
	// supersededGrace is how long older archives of a vault stay downloadable
	// once a new one is ready: enough to finish a download in progress,
	// short enough that repeated requests cannot fill the exports bucket.
	supersededGrace = time.Hour
)

// Messages stored in the error of a failed job. The client sees them, so they
// never carry the internal error (storage endpoints, node paths, SQL): that
// goes to the log, with the job id.
const (
	failedBuild     = "the archive could not be built"
	failedMissing   = "a file of the vault is missing from the storage"
	failedVaultGone = "the vault was deleted"
)

// errVaultGone stops the build of a vault deleted after the job was queued.
var errVaultGone = errors.New("export: the vault was deleted")

// failure is the message stored for a build error.
func failure(err error) string {
	switch {
	case errors.Is(err, errVaultGone):
		return failedVaultGone
	case errors.Is(err, storage.ErrNotFound):
		return failedMissing
	default:
		return failedBuild
	}
}

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

	// streams counts the direct streams (Stream) open per user on this node.
	streamsMu stdsync.Mutex
	streams   map[uuid.UUID]int
}

// NewService wires the module. exports holds the finished archives (a separate bucket in
// production); blobs is the content store.
func NewService(d *db.DB, blobs, exports storage.BlobStore, a access.Authorizer, log zerolog.Logger) *Service {
	return &Service{db: d, blobs: blobs, exports: exports, authz: a, log: log, now: time.Now}
}

// SetClock replaces the time source (tests).
func (s *Service) SetClock(now func() time.Time) { s.now = now }

// vault authorizes the caller as owner of a live, non-encrypted vault.
func (s *Service) vault(ctx context.Context, user, vaultID uuid.UUID) (vaults.Vault, error) {
	acc, err := s.authz.Authorize(ctx, user, vaultID, "", access.Owner)
	if err != nil {
		return vaults.Vault{}, err
	}
	if acc.Vault.Kind == "private" {
		return vaults.Vault{}, httpproblem.Errorf(syncproto.CodeVaultEncrypted, "a private vault is exported by the client, after decryption")
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
	files, err := sync.ListExportFiles(ctx, s.db.Pool, vaultID)
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
// read error (and a truncated, invalid ZIP for the client). A user has at most
// exports.max_active_per_user streams open on this node (RATE_LIMITED beyond),
// and every stream is audited before it starts.
func (s *Service) Stream(ctx context.Context, user, vaultID uuid.UUID) (io.ReadCloser, string, error) {
	v, err := s.vault(ctx, user, vaultID)
	if err != nil {
		return nil, "", err
	}
	if v.TotalBytes > DirectLimit {
		return nil, "", httpproblem.Errorf(syncproto.CodeInvalidState, "the vault is larger than %d MB: start an export job instead", DirectLimit>>20)
	}
	release, err := s.acquireStream(user, s.maxActive(ctx))
	if err != nil {
		return nil, "", err
	}
	err = s.db.WithTx(ctx, func(ctx context.Context, tx pgx.Tx) error {
		return audit.Record(ctx, tx, user, "vault.export", "vault", v.ID.String(), map[string]string{"mode": "stream"})
	})
	if err != nil {
		release()
		return nil, "", err
	}
	pr, pw := io.Pipe()
	go func() {
		defer release()
		// Ends when the archive is complete, the request is cancelled or
		// the response stops reading (the server closes pr).
		pw.CloseWithError(s.writeZip(ctx, pw, vaultID))
	}()
	return pr, s.filename(v), nil
}

// maxActive is the setting exports.max_active_per_user.
func (s *Service) maxActive(ctx context.Context) int {
	limit := int(settings.Int(ctx, s.db.Pool, "exports.max_active_per_user", DefaultMaxActivePerUser))
	if limit <= 0 {
		return DefaultMaxActivePerUser
	}
	return limit
}

// acquireStream reserves one of the limit direct streams of a user on this
// node; release gives it back (once, however many times it is called).
func (s *Service) acquireStream(user uuid.UUID, limit int) (release func(), err error) {
	s.streamsMu.Lock()
	defer s.streamsMu.Unlock()
	if s.streams == nil {
		s.streams = map[uuid.UUID]int{}
	}
	if n := s.streams[user]; n >= limit {
		return nil, &httpproblem.Error{
			Code:   syncproto.CodeRateLimited,
			Detail: fmt.Sprintf("%d exports are already being downloaded: wait for one to finish", n),
			Extra:  map[string]any{"active_streams": n, "limit": limit},
		}
	}
	s.streams[user]++
	var once stdsync.Once
	return func() {
		once.Do(func() {
			s.streamsMu.Lock()
			defer s.streamsMu.Unlock()
			if s.streams[user]--; s.streams[user] <= 0 {
				delete(s.streams, user)
			}
		})
	}, nil
}

func (s *Service) filename(v vaults.Vault) string {
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

// Create queues an export job for a vault of any size. A vault has at most
// one job queued or running: a new request returns that job. A ready archive
// built at the vault's current changelog position, and valid for at least
// another reuseMinValidity, is returned too instead of building a copy. A user
// has at most exports.max_active_per_user jobs queued or running
// (RATE_LIMITED beyond). Once a new archive is ready, the older ones of the
// vault expire within supersededGrace (build), so the exports bucket holds
// few per vault however often they are requested.
func (s *Service) Create(ctx context.Context, user, vaultID uuid.UUID) (exportdb.ExportJob, error) {
	v, err := s.vault(ctx, user, vaultID)
	if err != nil {
		return exportdb.ExportJob{}, err
	}
	limit := s.maxActive(ctx)
	now := s.now()
	var j exportdb.ExportJob
	err = s.db.WithTx(ctx, func(ctx context.Context, tx pgx.Tx) error {
		q := exportdb.New(tx)
		// The name of 1.x first, then the current one (db.AdvisoryLockKeys): a pod of 1.4 only knows the first.
		for _, key := range db.AdvisoryLockKeys("exports", user.String()) {
			if err := q.LockExportRequests(ctx, key); err != nil {
				return err
			}
		}
		var err error
		j, err = q.GetActiveExportJobOfVault(ctx, v.ID)
		if err == nil {
			return nil // the archive being built will be this request's too
		}
		if !errors.Is(err, pgx.ErrNoRows) {
			return err
		}
		j, err = q.GetReusableExportJobOfVault(ctx, exportdb.GetReusableExportJobOfVaultParams{
			VaultID: v.ID, LastSeq: v.LastSeq, ValidAfter: now.Add(reuseMinValidity),
		})
		if err == nil {
			// Nothing changed since that archive was built.
			return audit.Record(ctx, tx, user, "vault.export", "vault", v.ID.String(), map[string]any{"mode": "job", "job": j.ID.String(), "reused": true})
		}
		if !errors.Is(err, pgx.ErrNoRows) {
			return err
		}
		active, err := q.CountActiveExportJobsOfUser(ctx, user)
		if err != nil {
			return err
		}
		if int(active) >= limit {
			return &httpproblem.Error{
				Code:   syncproto.CodeRateLimited,
				Detail: fmt.Sprintf("%d export jobs are already queued or running: wait for one to finish", active),
				Extra:  map[string]any{"active_exports": active, "limit": limit},
			}
		}
		if j, err = q.CreateExportJob(ctx, exportdb.CreateExportJobParams{ID: uuid.Must(uuid.NewV7()), VaultID: v.ID, RequestedBy: user}); err != nil {
			return err
		}
		return audit.Record(ctx, tx, user, "vault.export", "vault", v.ID.String(), map[string]string{"mode": "job", "job": j.ID.String()})
	})
	return j, err
}

// Job returns a job of a vault the caller owns.
func (s *Service) Job(ctx context.Context, user, vaultID, jobID uuid.UUID) (exportdb.ExportJob, error) {
	if _, err := s.vault(ctx, user, vaultID); err != nil {
		return exportdb.ExportJob{}, err
	}
	j, err := exportdb.New(s.db.Pool).GetExportJob(ctx, exportdb.GetExportJobParams{ID: jobID, VaultID: vaultID})
	if errors.Is(err, pgx.ErrNoRows) {
		return exportdb.ExportJob{}, httpproblem.NotFound("export")
	}
	return j, err
}

func objectKey(id uuid.UUID) string { return "exports/" + id.String() + ".zip" }

// DownloadURL is where a ready job is fetched: a presigned object URL when the store has a
// public endpoint, otherwise the authenticated API path ("").
func (s *Service) DownloadURL(ctx context.Context, j exportdb.ExportJob, name string) string {
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
func (s *Service) Name(ctx context.Context, j exportdb.ExportJob) string {
	v, err := vaults.GetVault(ctx, s.db.Pool, j.VaultID)
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

// workers is how many archives ProcessPending builds in parallel.
func (s *Service) workers(ctx context.Context) int {
	n := int(settings.Int(ctx, s.db.Pool, "exports.workers", DefaultWorkers))
	if n <= 0 {
		return DefaultWorkers
	}
	return min(n, 16)
}

// ProcessPending builds queued jobs with a bounded number of parallel workers,
// each taking at most jobsPerWorker jobs, and returns how many it handled. The
// caller runs it periodically, followed by Expire, so a long queue neither
// monopolizes the worker nor delays the retirement of expired archives.
func (s *Service) ProcessPending(ctx context.Context) (int, error) {
	workers := s.workers(ctx)
	var (
		mu    stdsync.Mutex
		n     int
		first error
		wg    stdsync.WaitGroup
	)
	for range workers {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for range jobsPerWorker {
				done, err := s.processOne(ctx)
				mu.Lock()
				if done {
					n++
				}
				if err != nil && first == nil {
					first = err
				}
				mu.Unlock()
				if !done || err != nil {
					return
				}
			}
		}()
	}
	wg.Wait()
	if first == nil {
		first = ctx.Err()
	}
	return n, first
}

// processOne claims and builds one queued job; done is false when the queue
// is empty or ctx ended. A build interrupted by the end of ctx (the worker
// shutting down) is not a failure: the job goes back to the queue, for this
// worker's successor to build.
func (s *Service) processOne(ctx context.Context) (done bool, err error) {
	if ctx.Err() != nil {
		return false, nil
	}
	j, err := exportdb.New(s.db.Pool).ClaimExportJob(ctx, s.now().Add(staleAfter))
	if errors.Is(err, pgx.ErrNoRows) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	stop := s.keepLease(ctx, j.ID)
	err = s.build(ctx, j)
	stop()
	switch {
	case err == nil:
		return true, nil
	case ctx.Err() != nil:
		s.log.Info().Err(err).Str("job", j.ID.String()).Msg("export job interrupted: queued again")
		if rerr := s.endUnfinished(ctx, j.ID, func(ctx context.Context, q *exportdb.Queries) (int64, error) {
			return q.ReleaseExportJob(ctx, j.ID)
		}); rerr != nil {
			// The lease runs out and RequeueStaleExportJobs queues it again.
			s.log.Warn().Err(rerr).Str("job", j.ID.String()).Msg("export: cannot queue an interrupted job again")
		}
		return false, nil
	}
	msg := failure(err)
	s.log.Error().Err(err).Str("job", j.ID.String()).Str("reported", msg).Msg("export job failed")
	if ferr := s.endUnfinished(ctx, j.ID, func(ctx context.Context, q *exportdb.Queries) (int64, error) {
		return q.FailExportJob(ctx, exportdb.FailExportJobParams{ID: j.ID, Error: &msg})
	}); ferr != nil {
		return true, ferr
	}
	return true, nil
}

// endUnfinished moves a running job that did not become ready out of the
// running state (end) and deletes the archive its build may have uploaded
// before failing or being interrupted: once the job is failed, or queued and
// then cancelled with the account, nothing else would delete it. The row stays
// locked until the archive is gone, so a worker claiming the job again cannot
// see its new archive deleted. A job no longer running is left alone: it may
// be ready after all (a commit whose acknowledgement was lost).
func (s *Service) endUnfinished(ctx context.Context, id uuid.UUID, end func(context.Context, *exportdb.Queries) (int64, error)) error {
	return s.db.WithTx(context.WithoutCancel(ctx), func(ctx context.Context, tx pgx.Tx) error {
		n, err := end(ctx, exportdb.New(tx))
		if err != nil || n == 0 {
			return err
		}
		s.discard(ctx, id, objectKey(id))
		return nil
	})
}

// keepLease renews the lease of a running job until stop is called, so a long
// build is not mistaken for an abandoned one and built twice.
func (s *Service) keepLease(ctx context.Context, id uuid.UUID) (stop func()) {
	done := make(chan struct{})
	finished := make(chan struct{})
	go func() {
		defer close(finished)
		t := time.NewTicker(staleAfter / 4)
		defer t.Stop()
		for {
			select {
			case <-done:
				return
			case <-ctx.Done():
				return
			case <-t.C:
				if err := exportdb.New(s.db.Pool).RenewExportLease(ctx, exportdb.RenewExportLeaseParams{ID: id, LeaseUntil: s.now().Add(staleAfter)}); err != nil {
					s.log.Warn().Err(err).Str("job", id.String()).Msg("export: cannot renew the lease")
				}
			}
		}
	}()
	return func() { close(done); <-finished }
}

// liveVault returns the vault of a job, or errVaultGone once it is deleted:
// nothing is archived after a deletion (of the vault or of the account).
func (s *Service) liveVault(ctx context.Context, id uuid.UUID) (vaults.Vault, error) {
	v, err := vaults.GetVault(ctx, s.db.Pool, id)
	if errors.Is(err, pgx.ErrNoRows) || (err == nil && v.DeletedAt != nil) {
		return vaults.Vault{}, errVaultGone
	}
	return v, err
}

func (s *Service) build(ctx context.Context, j exportdb.ExportJob) error {
	v, err := s.liveVault(ctx, j.VaultID)
	if err != nil {
		return err
	}
	// Read before the files: the archive is at least as recent as seq, so a
	// later request reuses it only if nothing was committed since.
	seq := v.LastSeq
	tmp, err := os.CreateTemp("", "clarae-export-*.zip")
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
	key := objectKey(j.ID)
	if err := s.exports.Put(ctx, key, tmp, size); err != nil {
		return err
	}
	// The vault may have been deleted while the archive was built.
	if _, err := s.liveVault(ctx, j.VaultID); err != nil {
		s.discard(ctx, j.ID, key)
		return err
	}
	exp := s.now().Add(LinkTTL)
	var finished int64
	err = s.db.WithTx(ctx, func(ctx context.Context, tx pgx.Tx) error {
		q := exportdb.New(tx)
		var err error
		finished, err = q.FinishExportJob(ctx, exportdb.FinishExportJobParams{ID: j.ID, Size: &size, ObjectKey: &key, SourceSeq: &seq, ExpiresAt: &exp})
		if err != nil || finished == 0 {
			return err
		}
		_, err = q.SupersedeReadyExportJobsOfVault(ctx, exportdb.SupersedeReadyExportJobsOfVaultParams{VaultID: j.VaultID, ValidUntil: s.now().Add(supersededGrace), Keep: j.ID})
		return err
	})
	if err != nil {
		return err
	}
	if finished == 0 {
		// Cancelled meanwhile (the account was deleted): the job stays failed
		// and its archive must not outlive the deletion.
		s.log.Info().Str("job", j.ID.String()).Msg("export job cancelled while it was built")
		s.discard(ctx, j.ID, key)
	}
	return nil
}

// discard deletes the archive of a job that will not become ready.
func (s *Service) discard(ctx context.Context, id uuid.UUID, key string) {
	if err := s.exports.Delete(context.WithoutCancel(ctx), key); err != nil && !errors.Is(err, storage.ErrNotFound) {
		s.log.Warn().Err(err).Str("job", id.String()).Str("key", key).Msg("export: cannot delete a discarded archive")
	}
}

// Expire retires finished exports past their 24 hours, deleting the archives, and requeues
// jobs abandoned by a crashed worker.
func (s *Service) Expire(ctx context.Context) error {
	rows, err := exportdb.New(s.db.Pool).ExpireExportJobs(ctx, s.now())
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
	_, err = exportdb.New(s.db.Pool).RequeueStaleExportJobs(ctx, exportdb.RequeueStaleExportJobsParams{Now: s.now(), Before: s.now().Add(-staleAfter)})
	return err
}
