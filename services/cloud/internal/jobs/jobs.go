// Package jobs runs the background maintenance of the cloud service in the
// worker role (M2-WP7): blob garbage collection, expired uploads, revision
// retention, changelog compaction, purge of deleted vaults and nightly
// reconciliation of usage counters and blob reference counts. Every job is
// idempotent and guarded by a Postgres advisory lock, so several replicas can
// run the worker without doing the work twice.
package jobs

import (
	"context"
	"errors"
	"fmt"
	"sync/atomic"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/rs/zerolog"

	"memobrain/services/cloud/internal/admin"
	"memobrain/services/cloud/internal/blobs"
	"memobrain/services/cloud/internal/db"
	"memobrain/services/cloud/internal/jobs/jobsdb"
	"memobrain/services/cloud/internal/observability"
	"memobrain/services/cloud/internal/quota"
	"memobrain/services/cloud/internal/revisions"
	"memobrain/services/cloud/internal/settings"
	"memobrain/services/cloud/internal/storage"
)

// Runner schedules the jobs.
type Runner struct {
	db        *db.DB
	store     storage.BlobStore
	blobs     *blobs.Service
	revisions *revisions.Service
	log       zerolog.Logger
	now       func() time.Time

	exports ExportWorker

	// Intervals (zero values use the defaults).
	GCInterval          time.Duration
	UploadsInterval     time.Duration
	RetentionInterval   time.Duration
	MaintenanceInterval time.Duration // compaction, purge, reconciliation
	ExportsInterval     time.Duration

	// First runs: loop i starts after FirstRunDelay + i*Stagger (zero values:
	// 30 s and 5 s; a negative Stagger starts every loop together).
	FirstRunDelay time.Duration
	Stagger       time.Duration

	// HeartbeatInterval is how often the scheduler records that it is alive
	// (zero value: DefaultHeartbeat); see LastTick.
	HeartbeatInterval time.Duration
	lastTick          atomic.Int64 // unix nanoseconds, 0 when not running
}

// DefaultHeartbeat is the default HeartbeatInterval.
const DefaultHeartbeat = 10 * time.Second

// LastTick is when the scheduler last recorded that it is alive: zero before
// Run started the job loops (or when the lock pool could not be opened) and
// after it returned. The worker's health endpoint compares it with the
// heartbeat interval.
func (r *Runner) LastTick() time.Time {
	if n := r.lastTick.Load(); n != 0 {
		return time.Unix(0, n)
	}
	return time.Time{}
}

// Heartbeat returns the effective HeartbeatInterval.
func (r *Runner) Heartbeat() time.Duration {
	if r.HeartbeatInterval > 0 {
		return r.HeartbeatInterval
	}
	return DefaultHeartbeat
}

// New creates a runner.
func New(d *db.DB, store storage.BlobStore, b *blobs.Service, r *revisions.Service, log zerolog.Logger) *Runner {
	return &Runner{db: d, store: store, blobs: b, revisions: r, log: log, now: time.Now}
}

// ExportWorker builds queued export archives and retires expired ones (export.Service).
type ExportWorker interface {
	ProcessPending(ctx context.Context) (int, error)
	Expire(ctx context.Context) error
}

// WithExports enables the export loop.
func (r *Runner) WithExports(e ExportWorker) *Runner {
	r.exports = e
	return r
}

// SetClock replaces the time source (tests move time forward instead of waiting days).
func (r *Runner) SetClock(now func() time.Time) { r.now = now }

// advisory lock keys, one per job.
const (
	lockGC = iota + 7_400_000
	lockUploads
	lockRetention
	lockMaintenance
	lockExports
)

func (r *Runner) setting(ctx context.Context, key string, def int) int {
	return int(settings.Int(ctx, r.db.Pool, key, int64(def)))
}

// withLock runs fn only if no other replica holds the job's lock. The lock is
// a session lock held on a connection of locks, a pool of its own with one
// connection per loop: holding it for the whole job (which spans many
// transactions) never takes a connection from the main pool the job works on.
// When both came from the same pool, loops starting together could take every
// connection for their locks and then wait forever for one to work with.
func (r *Runner) withLock(ctx context.Context, locks *pgxpool.Pool, key int64, name string, fn func(context.Context) error) {
	conn, err := locks.Acquire(ctx)
	if err != nil {
		if ctx.Err() == nil {
			r.log.Error().Err(err).Str("job", name).Msg("job: acquire lock connection")
		}
		return
	}
	defer conn.Release()
	var got bool
	if err := conn.QueryRow(ctx, "SELECT pg_try_advisory_lock($1)", key).Scan(&got); err != nil || !got {
		return
	}
	defer func() { _, _ = conn.Exec(context.WithoutCancel(ctx), "SELECT pg_advisory_unlock($1)", key) }()
	start := time.Now()
	if err := fn(ctx); err != nil && ctx.Err() == nil {
		observability.JobRun(name, time.Since(start), err)
		r.log.Error().Err(err).Str("job", name).Msg("job failed")
		return
	}
	observability.JobRun(name, time.Since(start), nil)
	r.log.Debug().Str("job", name).Dur("took", time.Since(start)).Msg("job done")
}

// openLocks opens the pool of the advisory locks (see withLock): the main
// pool's settings with one connection per job loop.
func (r *Runner) openLocks(ctx context.Context, loops int) (*pgxpool.Pool, error) {
	cfg := r.db.Pool.Config()
	cfg.MaxConns = int32(loops) //nolint:gosec // a handful of job loops
	cfg.MinConns = 0
	return pgxpool.NewWithConfig(ctx, cfg)
}

// Run starts every job loop and blocks until ctx ends.
func (r *Runner) Run(ctx context.Context) {
	loops := []struct {
		name  string
		every time.Duration
		def   time.Duration
		lock  int64
		run   func(context.Context) error
	}{
		{"blob-gc", r.GCInterval, time.Hour, lockGC, func(c context.Context) error { _, err := r.CollectBlobs(c); return err }},
		{"uploads", r.UploadsInterval, 15 * time.Minute, lockUploads, func(c context.Context) error { _, err := r.blobs.CleanupExpired(c); return err }},
		{"retention", r.RetentionInterval, 6 * time.Hour, lockRetention, func(c context.Context) error { _, err := r.PruneRevisions(c); return err }},
		{"maintenance", r.MaintenanceInterval, 24 * time.Hour, lockMaintenance, r.Maintain},
	}
	if r.exports != nil {
		loops = append(loops, struct {
			name  string
			every time.Duration
			def   time.Duration
			lock  int64
			run   func(context.Context) error
		}{"exports", r.ExportsInterval, 15 * time.Second, lockExports, func(c context.Context) error {
			if _, err := r.exports.ProcessPending(c); err != nil {
				return err
			}
			return r.exports.Expire(c)
		}})
	}
	locks, err := r.openLocks(ctx, len(loops))
	if err != nil {
		// pgxpool connects lazily: this is a configuration error, not an outage.
		r.log.Error().Err(err).Msg("jobs: open the lock pool; background jobs disabled")
		<-ctx.Done()
		return
	}
	defer locks.Close()
	first, stagger := r.FirstRunDelay, r.Stagger
	if first <= 0 {
		first = 30 * time.Second
	}
	if stagger < 0 {
		stagger = 0
	} else if stagger == 0 {
		stagger = 5 * time.Second
	}
	done := make(chan struct{})
	// The heartbeat runs beside the loops: a job can take hours, while the
	// scheduler itself must show it is alive every few seconds.
	r.lastTick.Store(time.Now().UnixNano())
	defer r.lastTick.Store(0)
	go func() {
		t := time.NewTicker(r.Heartbeat())
		defer t.Stop()
		for {
			select {
			case <-ctx.Done():
				done <- struct{}{}
				return
			case <-t.C:
				r.lastTick.Store(time.Now().UnixNano())
			}
		}
	}()
	for i, l := range loops {
		every := l.every
		if every <= 0 {
			every = l.def
		}
		go func() {
			// The first run is delayed so a restarting fleet does not stampede,
			// and the loops start one after the other rather than all at once.
			t := time.NewTimer(first + time.Duration(i)*stagger)
			defer t.Stop()
			for {
				select {
				case <-ctx.Done():
					done <- struct{}{}
					return
				case <-t.C:
					r.withLock(ctx, locks, l.lock, l.name, l.run)
					t.Reset(every)
				}
			}
		}()
	}
	for range len(loops) + 1 { // the loops and the heartbeat
		<-done
	}
}

// CollectBlobs deletes blobs that no revision references and that stayed
// unreferenced for the grace period (default 24 h).
//
// Each blob goes in its own transaction: the guarded row delete first, then
// the object, then the commit. The row lock orders the collector against a
// concurrent commit, which locks the blob FOR SHARE before referencing it:
// either the commit wins and the guard keeps the row (and the object), or the
// collector wins and the commit finds no blob and answers BLOB_MISSING. If
// the object delete fails the row is restored by the rollback and the blob is
// retried on the next run.
func (r *Runner) CollectBlobs(ctx context.Context) (int, error) {
	grace := time.Duration(r.setting(ctx, "blobs.gc_grace_hours", 24)) * time.Hour
	cutoff := ptrTime(r.now().Add(-grace))
	total := 0
	for {
		rows, err := jobsdb.New(r.db.Pool).ListUnreferencedBlobs(ctx, jobsdb.ListUnreferencedBlobsParams{UnreferencedSince: cutoff, Limit: 500})
		if err != nil {
			return total, err
		}
		if len(rows) == 0 {
			return total, nil
		}
		collected := 0
		for _, b := range rows {
			ok, err := r.collectBlob(ctx, b.Hash, cutoff)
			if err != nil {
				return total, err
			}
			if ok {
				collected++
			}
		}
		total += collected
		if collected == 0 {
			// Every candidate was referenced meanwhile: nothing left to do now.
			return total, nil
		}
	}
}

// collectBlob deletes one blob, row and object, unless it was referenced
// since it was listed.
func (r *Runner) collectBlob(ctx context.Context, hash string, cutoff *time.Time) (bool, error) {
	deleted := false
	err := r.db.WithTx(ctx, func(ctx context.Context, tx pgx.Tx) error {
		q := jobsdb.New(tx)
		key, err := q.DeleteCollectableBlob(ctx, jobsdb.DeleteCollectableBlobParams{Hash: hash, UnreferencedSince: cutoff})
		if errors.Is(err, pgx.ErrNoRows) {
			return nil // referenced again (or already collected): keep it
		}
		if err != nil {
			return err
		}
		if err := r.store.Delete(ctx, key); err != nil {
			return fmt.Errorf("delete object %s: %w", key, err)
		}
		deleted = true
		return nil
	})
	return deleted && err == nil, err
}

func ptrTime(t time.Time) *time.Time { return &t }

// PruneRevisions applies the retention policy and then removes tombstones
// whose history is gone.
func (r *Runner) PruneRevisions(ctx context.Context) (int, error) {
	p := revisions.RetentionPolicy{
		FullDays:  r.setting(ctx, "history.retention_days", 30),
		DailyDays: r.setting(ctx, "history.daily_retention_days", 90),
	}
	n, err := r.revisions.Prune(ctx, p, r.now())
	if err != nil {
		return n, err
	}
	totals, err := jobsdb.New(r.db.Pool).ListVaultTotals(ctx)
	if err != nil {
		return n, err
	}
	for _, v := range totals {
		if _, err := jobsdb.New(r.db.Pool).PurgeDeletedFiles(ctx, v.VaultID); err != nil {
			return n, err
		}
	}
	return n, nil
}

// Maintain runs the daily jobs: changelog compaction, purge of deleted
// vaults and accounts, reconciliation of counters and the storage snapshot.
// The steps are independent: a failing one is logged, counted in its own
// metric and reported, but never stops the others (a broken compaction must
// not leave deleted vaults unpurged for days).
func (r *Runner) Maintain(ctx context.Context) error {
	return r.runSteps(ctx, []step{
		{"compaction", r.CompactChangelogs},
		{"purge-vaults", func(c context.Context) error { _, err := r.PurgeDeletedVaults(c); return err }},
		{"purge-accounts", func(c context.Context) error { _, err := r.PurgeDeletedAccounts(c); return err }},
		{"reconcile-usage", r.ReconcileUsage},
		{"reconcile-blob-refs", r.ReconcileBlobRefs},
		{"storage-snapshot", r.SnapshotStorage},
	})
}

// step is one independent part of a job.
type step struct {
	name string
	run  func(context.Context) error
}

// runSteps runs every step in order until ctx ends and joins their errors.
func (r *Runner) runSteps(ctx context.Context, steps []step) error {
	var errs []error
	for _, s := range steps {
		if ctx.Err() != nil {
			break
		}
		start := time.Now()
		err := s.run(ctx)
		observability.JobRun("maintenance:"+s.name, time.Since(start), err)
		if err != nil {
			r.log.Error().Err(err).Str("job", "maintenance").Str("step", s.name).Msg("maintenance step failed")
			errs = append(errs, fmt.Errorf("%s: %w", s.name, err))
		}
	}
	return errors.Join(errs...)
}

// SnapshotStorage records today's total usage for the trend of the admin dashboard.
func (r *Runner) SnapshotStorage(ctx context.Context) error {
	return admin.SnapshotStorage(ctx, r.db.Pool)
}

// CompactChangelogs advances compaction_seq so entries older than the window
// (sync.changelog_window_days) are no longer served: clients that far behind
// bootstrap from the manifest.
func (r *Runner) CompactChangelogs(ctx context.Context) error {
	window := time.Duration(r.setting(ctx, "sync.changelog_window_days", 90)) * 24 * time.Hour
	cut := r.now().Add(-window)
	q := jobsdb.New(r.db.Pool)
	vaults, err := q.ListVaultTotals(ctx)
	if err != nil {
		return err
	}
	for _, v := range vaults {
		seq, err := q.MaxSeqBefore(ctx, jobsdb.MaxSeqBeforeParams{VaultID: v.VaultID, ServerTime: cut})
		if err != nil {
			return err
		}
		if seq > 0 {
			if err := q.SetVaultCompaction(ctx, jobsdb.SetVaultCompactionParams{ID: v.VaultID, CompactionSeq: seq}); err != nil {
				return err
			}
		}
	}
	return nil
}

// PurgeDeletedVaults permanently removes vaults deleted longer ago than
// vaults.deleted_retention_days, releasing blob references and quota.
func (r *Runner) PurgeDeletedVaults(ctx context.Context) (int, error) {
	retention := time.Duration(r.setting(ctx, "vaults.deleted_retention_days", 30)) * 24 * time.Hour
	q := jobsdb.New(r.db.Pool)
	ids, err := q.ListDeletedVaultsBefore(ctx, ptrTime(r.now().Add(-retention)))
	if err != nil {
		return 0, err
	}
	for _, id := range ids {
		if err := r.purgeVault(ctx, id); err != nil {
			return 0, err
		}
	}
	return len(ids), nil
}

func (r *Runner) purgeVault(ctx context.Context, id uuid.UUID) error {
	return r.db.WithTx(ctx, func(ctx context.Context, tx pgx.Tx) error {
		q := jobsdb.New(tx)
		v, err := q.GetVaultForUpdate(ctx, id)
		if err != nil {
			return err
		}
		hashes, err := q.ListRevisionBlobs(ctx, id)
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
			if err := blobs.AddRef(ctx, tx, h, -n); err != nil {
				return err
			}
		}
		if v.TotalBytes > 0 {
			if err := quota.Release(ctx, tx, v.OwnerID, v.TotalBytes); err != nil {
				return err
			}
		}
		return q.DeleteVault(ctx, id)
	})
}

// ReconcileUsage recomputes per-vault and per-user counters from the files
// table and corrects any drift (e.g. after a crash between steps).
//
// The snapshot of all totals only selects the candidates. Each correction
// then locks the counter row and recomputes the actual value afterwards, in
// its own short transaction: every change that moves a counter holds the same
// row lock and applies its delta in the transaction that changes the files,
// so the recomputed value accounts for exactly the deltas already applied,
// and a commit running meanwhile is never overwritten by an older snapshot.
func (r *Runner) ReconcileUsage(ctx context.Context) error {
	q := jobsdb.New(r.db.Pool)
	totals, err := q.ListVaultTotals(ctx)
	if err != nil {
		return err
	}
	perOwner := map[uuid.UUID]int64{}
	for _, v := range totals {
		perOwner[v.OwnerID] += v.Bytes
		if v.StoredBytes != v.Bytes || v.StoredFiles != v.Files {
			if err := r.reconcileVault(ctx, v.VaultID); err != nil {
				return err
			}
		}
	}
	users, err := q.ListUsersWithUsage(ctx)
	if err != nil {
		return err
	}
	for _, u := range users {
		if u.UsedBytes != perOwner[u.ID] {
			if err := r.reconcileUser(ctx, u.ID); err != nil {
				return err
			}
		}
	}
	return nil
}

// reconcileVault corrects the counters of one vault under its row lock, the
// lock a commit takes first (NextVaultSeq).
func (r *Runner) reconcileVault(ctx context.Context, id uuid.UUID) error {
	return r.db.WithTx(ctx, func(ctx context.Context, tx pgx.Tx) error {
		q := jobsdb.New(tx)
		cur, err := q.GetVaultForUpdate(ctx, id)
		if errors.Is(err, pgx.ErrNoRows) {
			return nil // purged meanwhile
		}
		if err != nil {
			return err
		}
		actual, err := q.VaultActualTotals(ctx, id)
		if err != nil {
			return err
		}
		if cur.TotalBytes == actual.Bytes && cur.FileCount == actual.Files {
			return nil
		}
		r.log.Warn().Str("vault", id.String()).Int64("stored", cur.TotalBytes).Int64("actual", actual.Bytes).
			Int32("stored_files", cur.FileCount).Int32("actual_files", actual.Files).Msg("usage drift corrected")
		return q.SetVaultTotals(ctx, jobsdb.SetVaultTotalsParams{ID: id, TotalBytes: actual.Bytes, FileCount: actual.Files})
	})
}

// reconcileUser corrects the used bytes of one user under the row lock that
// every quota charge and release takes.
func (r *Runner) reconcileUser(ctx context.Context, id uuid.UUID) error {
	return r.db.WithTx(ctx, func(ctx context.Context, tx pgx.Tx) error {
		q := jobsdb.New(tx)
		stored, err := q.GetUserUsedForUpdate(ctx, id)
		if errors.Is(err, pgx.ErrNoRows) {
			return nil
		}
		if err != nil {
			return err
		}
		actual, err := q.OwnerActualUsage(ctx, id)
		if err != nil {
			return err
		}
		if stored == actual {
			return nil
		}
		r.log.Warn().Str("user", id.String()).Int64("stored", stored).Int64("actual", actual).Msg("user usage drift corrected")
		return q.SetUserUsed(ctx, jobsdb.SetUserUsedParams{ID: id, UsedBytes: actual})
	})
}

// ReconcileBlobRefs recomputes blob reference counts from the revisions. Like
// ReconcileUsage, the snapshot only selects the candidates: each count is
// taken again after locking the blob row, which every reference change
// (commit, retention, purge) updates in the transaction that adds or removes
// the revisions.
func (r *Runner) ReconcileBlobRefs(ctx context.Context) error {
	rows, err := jobsdb.New(r.db.Pool).ListBlobRefCounts(ctx)
	if err != nil {
		return err
	}
	for _, b := range rows {
		err := r.db.WithTx(ctx, func(ctx context.Context, tx pgx.Tx) error {
			q := jobsdb.New(tx)
			stored, err := q.GetBlobRefForUpdate(ctx, b.Hash)
			if errors.Is(err, pgx.ErrNoRows) {
				return nil // collected meanwhile
			}
			if err != nil {
				return err
			}
			actual, err := q.CountBlobRefs(ctx, &b.Hash)
			if err != nil {
				return err
			}
			if stored == actual {
				return nil
			}
			r.log.Warn().Str("blob", b.Hash).Int32("stored", stored).Int32("actual", actual).Msg("blob ref count corrected")
			return q.SetBlobRef(ctx, jobsdb.SetBlobRefParams{Hash: b.Hash, RefCount: actual})
		})
		if err != nil {
			return err
		}
	}
	return nil
}
