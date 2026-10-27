// Package jobs runs the background maintenance of the cloud service in the
// worker role (M2-WP7): blob garbage collection, expired uploads, revision
// retention, changelog compaction, purge of deleted vaults and nightly
// reconciliation of usage counters and blob reference counts. Every job is
// idempotent and guarded by a Postgres advisory lock, so several replicas can
// run the worker without doing the work twice.
package jobs

import (
	"context"
	"encoding/json"
	"fmt"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/rs/zerolog"

	"nodus/services/cloud/internal/blobs"
	"nodus/services/cloud/internal/db"
	"nodus/services/cloud/internal/db/dbgen"
	"nodus/services/cloud/internal/observability"
	"nodus/services/cloud/internal/revisions"
	"nodus/services/cloud/internal/storage"
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
	raw, err := r.db.Queries().GetSetting(ctx, key)
	if err != nil {
		return def
	}
	var n int
	if json.Unmarshal(raw, &n) != nil || n <= 0 {
		return def
	}
	return n
}

// withLock runs fn only if no other replica holds the job's lock.
func (r *Runner) withLock(ctx context.Context, key int64, name string, fn func(context.Context) error) {
	conn, err := r.db.Pool.Acquire(ctx)
	if err != nil {
		r.log.Error().Err(err).Str("job", name).Msg("job: acquire connection")
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
	done := make(chan struct{})
	for _, l := range loops {
		every := l.every
		if every <= 0 {
			every = l.def
		}
		go func() {
			// The first run is delayed so a restarting fleet does not stampede.
			t := time.NewTimer(30 * time.Second)
			defer t.Stop()
			for {
				select {
				case <-ctx.Done():
					done <- struct{}{}
					return
				case <-t.C:
					r.withLock(ctx, l.lock, l.name, l.run)
					t.Reset(every)
				}
			}
		}()
	}
	for range loops {
		<-done
	}
}

// CollectBlobs deletes blobs that no revision references and that stayed
// unreferenced for the grace period (default 24 h), objects first.
func (r *Runner) CollectBlobs(ctx context.Context) (int, error) {
	grace := time.Duration(r.setting(ctx, "blobs.gc_grace_hours", 24)) * time.Hour
	q := r.db.Queries()
	total := 0
	for {
		rows, err := q.ListUnreferencedBlobs(ctx, dbgen.ListUnreferencedBlobsParams{UnreferencedSince: ptrTime(r.now().Add(-grace)), Limit: 500})
		if err != nil {
			return total, err
		}
		if len(rows) == 0 {
			return total, nil
		}
		for _, b := range rows {
			if err := r.store.Delete(ctx, b.StorageKey); err != nil {
				return total, fmt.Errorf("delete object %s: %w", b.StorageKey, err)
			}
			if err := q.DeleteBlobRow(ctx, b.Hash); err != nil {
				return total, err
			}
			total++
		}
	}
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
	totals, err := r.db.Queries().ListVaultTotals(ctx)
	if err != nil {
		return n, err
	}
	for _, v := range totals {
		if _, err := r.db.Queries().PurgeDeletedFiles(ctx, v.VaultID); err != nil {
			return n, err
		}
	}
	return n, nil
}

// Maintain runs the daily jobs: changelog compaction, purge of deleted
// vaults and reconciliation of counters.
func (r *Runner) Maintain(ctx context.Context) error {
	if err := r.CompactChangelogs(ctx); err != nil {
		return fmt.Errorf("compaction: %w", err)
	}
	if _, err := r.PurgeDeletedVaults(ctx); err != nil {
		return fmt.Errorf("purge vaults: %w", err)
	}
	if _, err := r.PurgeDeletedAccounts(ctx); err != nil {
		return fmt.Errorf("purge accounts: %w", err)
	}
	if err := r.ReconcileUsage(ctx); err != nil {
		return fmt.Errorf("reconcile usage: %w", err)
	}
	if err := r.ReconcileBlobRefs(ctx); err != nil {
		return fmt.Errorf("reconcile blob refs: %w", err)
	}
	if err := r.SnapshotStorage(ctx); err != nil {
		return fmt.Errorf("storage snapshot: %w", err)
	}
	return nil
}

// SnapshotStorage records today's total usage for the trend of the admin dashboard.
func (r *Runner) SnapshotStorage(ctx context.Context) error {
	q := r.db.Queries()
	totals, err := q.StorageTotals(ctx)
	if err != nil {
		return err
	}
	return q.UpsertStorageSnapshot(ctx, totals.TotalUsed)
}

// CompactChangelogs advances compaction_seq so entries older than the window
// (sync.changelog_window_days) are no longer served: clients that far behind
// bootstrap from the manifest.
func (r *Runner) CompactChangelogs(ctx context.Context) error {
	window := time.Duration(r.setting(ctx, "sync.changelog_window_days", 90)) * 24 * time.Hour
	cut := r.now().Add(-window)
	q := r.db.Queries()
	vaults, err := q.ListVaultTotals(ctx)
	if err != nil {
		return err
	}
	for _, v := range vaults {
		seq, err := q.MaxSeqBefore(ctx, dbgen.MaxSeqBeforeParams{VaultID: v.VaultID, ServerTime: cut})
		if err != nil {
			return err
		}
		if seq > 0 {
			if err := q.SetVaultCompaction(ctx, dbgen.SetVaultCompactionParams{ID: v.VaultID, CompactionSeq: seq}); err != nil {
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
	q := r.db.Queries()
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
	return r.db.WithTx(ctx, func(ctx context.Context, q *dbgen.Queries, _ pgx.Tx) error {
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
			if err := blobs.AddRef(ctx, q, h, -n); err != nil {
				return err
			}
		}
		if v.TotalBytes > 0 {
			if _, err := q.ChargeUser(ctx, dbgen.ChargeUserParams{ID: v.OwnerID, Delta: -v.TotalBytes, Quota: -1}); err != nil {
				return err
			}
		}
		return q.DeleteVault(ctx, id)
	})
}

// ReconcileUsage recomputes per-vault and per-user counters from the files
// table and corrects any drift (e.g. after a crash between steps).
func (r *Runner) ReconcileUsage(ctx context.Context) error {
	q := r.db.Queries()
	totals, err := q.ListVaultTotals(ctx)
	if err != nil {
		return err
	}
	perOwner := map[uuid.UUID]int64{}
	for _, v := range totals {
		perOwner[v.OwnerID] += v.Bytes
		cur, err := q.GetVault(ctx, v.VaultID)
		if err != nil {
			return err
		}
		if cur.TotalBytes != v.Bytes || int(cur.FileCount) != int(v.Files) {
			r.log.Warn().Str("vault", v.VaultID.String()).Int64("stored", cur.TotalBytes).Int64("actual", v.Bytes).Msg("usage drift corrected")
			if err := q.SetVaultTotals(ctx, dbgen.SetVaultTotalsParams{ID: v.VaultID, TotalBytes: v.Bytes, FileCount: v.Files}); err != nil {
				return err
			}
		}
	}
	users, err := q.ListUsersWithUsage(ctx)
	if err != nil {
		return err
	}
	for _, u := range users {
		if want := perOwner[u.ID]; u.UsedBytes != want {
			r.log.Warn().Str("user", u.ID.String()).Int64("stored", u.UsedBytes).Int64("actual", want).Msg("user usage drift corrected")
			if err := q.SetUserUsed(ctx, dbgen.SetUserUsedParams{ID: u.ID, UsedBytes: want}); err != nil {
				return err
			}
		}
	}
	return nil
}

// ReconcileBlobRefs recomputes blob reference counts from the revisions.
func (r *Runner) ReconcileBlobRefs(ctx context.Context) error {
	q := r.db.Queries()
	rows, err := q.ListBlobRefCounts(ctx)
	if err != nil {
		return err
	}
	for _, b := range rows {
		r.log.Warn().Str("blob", b.Hash).Int32("stored", b.RefCount).Int32("actual", b.Actual).Msg("blob ref count corrected")
		if err := q.SetBlobRef(ctx, dbgen.SetBlobRefParams{Hash: b.Hash, RefCount: b.Actual}); err != nil {
			return err
		}
	}
	return nil
}
