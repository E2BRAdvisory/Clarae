// Package jobs runs the background maintenance of the cloud service in the
// worker role (M2-WP7): blob garbage collection, expired uploads, revision
// retention, changelog compaction, purge of deleted vaults and nightly
// reconciliation of usage counters and blob reference counts. Every job is
// idempotent and guarded by a Postgres advisory lock, so several replicas can
// run the worker without doing the work twice.
package jobs

import (
	"cmp"
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
	"memobrain/services/cloud/internal/vaults"
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
	kc      IdentityDisabler // nil: the account purge cannot disable Keycloak accounts

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

	// PurgeBatch is the page size of the vault and tombstone purges (zero:
	// maintenanceBatch); tests lower it to cross page boundaries.
	PurgeBatch int

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
//
// A lock that cannot be taken because of an error (not because another
// replica holds it) counts as a failed run, so a broken lock connection shows
// up in the logs and the job metrics instead of silently stopping the job. A
// run interrupted by the end of ctx is not recorded at all: it is neither a
// failure nor a success that would refresh the job's last success.
func (r *Runner) withLock(ctx context.Context, locks *pgxpool.Pool, key int64, name string, fn func(context.Context) error) {
	conn, err := locks.Acquire(ctx)
	if err != nil {
		if ctx.Err() == nil {
			observability.JobRun(name, 0, err)
			r.log.Error().Err(err).Str("job", name).Msg("job: acquire lock connection")
		}
		return
	}
	defer conn.Release()
	var got bool
	if err := conn.QueryRow(ctx, "SELECT pg_try_advisory_lock($1)", key).Scan(&got); err != nil {
		if ctx.Err() == nil {
			observability.JobRun(name, 0, err)
			r.log.Warn().Err(err).Str("job", name).Msg("job: take the advisory lock")
		}
		return
	}
	if !got {
		return // another replica runs it
	}
	defer func() { _, _ = conn.Exec(context.WithoutCancel(ctx), "SELECT pg_advisory_unlock($1)", key) }()
	start := time.Now()
	err = fn(ctx)
	switch runOutcome(err, ctx.Err()) {
	case runFailed:
		observability.JobRun(name, time.Since(start), err)
		r.log.Error().Err(err).Str("job", name).Msg("job failed")
	case runInterrupted:
		r.log.Debug().Err(err).Str("job", name).Dur("took", time.Since(start)).Msg("job interrupted")
	default:
		observability.JobRun(name, time.Since(start), nil)
		r.log.Debug().Str("job", name).Dur("took", time.Since(start)).Msg("job done")
	}
}

// Outcomes of a job run (runOutcome).
const (
	runSucceeded = iota
	runFailed
	runInterrupted
)

// runOutcome classifies a run from the error of the job and of its context:
// once the context has ended, neither the error nor its absence says
// anything about the job's health.
func runOutcome(err, ctxErr error) int {
	switch {
	case ctxErr != nil:
		return runInterrupted
	case err != nil:
		return runFailed
	default:
		return runSucceeded
	}
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
		{"uploads", r.UploadsInterval, 15 * time.Minute, lockUploads, r.CleanupUploads},
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

// gcBatch is the page size of the blob garbage collector.
const gcBatch = 500

// objectDeleteTimeout bounds the deletion of the object of a collected blob,
// which goes on when the run is stopped (see collectBlob).
const objectDeleteTimeout = 30 * time.Second

// CollectBlobs deletes blobs that no revision references and that stayed
// unreferenced for the grace period (default 24 h).
//
// Each blob goes in two steps. First the guarded row delete, in a transaction
// of its own: the row lock orders the collector against a concurrent commit,
// which locks the blob FOR KEY SHARE before referencing it, and against an
// upload linking it, which locks it the same way and restarts its grace
// period. Either they win and the guard keeps the row (and the object), or
// the collector wins and the commit finds no blob (BLOB_MISSING) while the
// upload publishes it again. Then, only once that delete is committed, the
// object, under the per-hash lock an upload publishes a row under
// (blobs.LockObject) and only if none did meanwhile. A failure between the
// two steps leaves an orphan object, harmless garbage that the next upload of
// the same content overwrites; the opposite order left a row without its
// object when the commit failed after the object was gone.
//
// The candidates are walked in keyset order: a blob that cannot be collected
// is logged, counted (memobrain_jobs_item_failures_total) and skipped, and the
// run reports the failures at the end instead of stopping at the first one.
func (r *Runner) CollectBlobs(ctx context.Context) (int, error) {
	grace := time.Duration(r.setting(ctx, "blobs.gc_grace_hours", 24)) * time.Hour
	cutoff := r.now().Add(-grace)
	q := jobsdb.New(r.db.Pool)
	total, failed := 0, 0
	var errs []error
	report := func(err error) error {
		if failed > 0 {
			err = errors.Join(err, fmt.Errorf("%d blobs not collected: %w", failed, errors.Join(errs...)))
		}
		return err
	}
	afterSince, afterHash := time.Time{}, ""
	for {
		rows, err := q.ListUnreferencedBlobs(ctx, jobsdb.ListUnreferencedBlobsParams{Cutoff: cutoff, AfterSince: afterSince, AfterHash: afterHash, MaxRows: gcBatch})
		if err != nil {
			return total, report(err)
		}
		for _, b := range rows {
			collected, err := r.collectBlob(ctx, b.Hash, cutoff)
			if collected {
				total++
			}
			if err == nil {
				continue
			}
			if ctx.Err() != nil {
				return total, report(ctx.Err())
			}
			failed++
			if len(errs) < 5 {
				errs = append(errs, err)
			}
			observability.JobItemFailed("blob-gc")
			r.log.Warn().Err(err).Str("blob", b.Hash).Msg("blob gc: blob skipped")
		}
		if len(rows) < gcBatch {
			return total, report(nil)
		}
		last := rows[len(rows)-1]
		afterSince, afterHash = last.UnreferencedSince, last.Hash
	}
}

// collectBlob deletes one blob, row then object, unless it was referenced or
// linked again since it was listed. collected reports that the row is gone;
// an error with collected set means its object stayed behind.
func (r *Runner) collectBlob(ctx context.Context, hash string, cutoff time.Time) (collected bool, err error) {
	var key string
	err = r.db.WithTx(ctx, func(ctx context.Context, tx pgx.Tx) error {
		k, err := jobsdb.New(tx).DeleteCollectableBlob(ctx, jobsdb.DeleteCollectableBlobParams{Hash: hash, UnreferencedSince: &cutoff})
		if errors.Is(err, pgx.ErrNoRows) {
			return nil // referenced again (or already collected): keep it
		}
		key = k
		return err
	})
	if err != nil || key == "" {
		return false, err
	}
	// The row is gone for good: delete the object even when the run is being
	// stopped (one short step), or it would stay behind.
	dctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), objectDeleteTimeout)
	defer cancel()
	err = r.db.WithTx(dctx, func(ctx context.Context, tx pgx.Tx) error {
		exists, err := blobs.LockObject(ctx, tx, hash)
		if err != nil || exists {
			return err // published again meanwhile: the object is the new row's
		}
		return r.store.Delete(ctx, key)
	})
	if err != nil {
		return true, fmt.Errorf("delete object %s of a collected blob: %w", key, err)
	}
	return true, nil
}

// CleanupUploads removes the expired upload sessions with their chunks, then
// the chunk objects no upload row accounts for any more (see
// blobs.SweepOrphanChunks). The two steps are independent.
func (r *Runner) CleanupUploads(ctx context.Context) error {
	_, err := r.blobs.CleanupExpired(ctx)
	if ctx.Err() != nil {
		return err
	}
	_, serr := r.blobs.SweepOrphanChunks(ctx, r.now())
	return errors.Join(err, serr)
}

func ptrTime(t time.Time) *time.Time { return &t }

// PruneRevisions applies the retention policy and then purges the expired
// tombstones (PurgeDeletedFiles).
func (r *Runner) PruneRevisions(ctx context.Context) (int, error) {
	p := revisions.RetentionPolicy{
		FullDays:  r.setting(ctx, "history.retention_days", 30),
		DailyDays: r.setting(ctx, "history.daily_retention_days", 90),
	}
	n, err := r.revisions.Prune(ctx, p, r.now())
	if err != nil {
		return n, err
	}
	_, err = r.PurgeDeletedFiles(ctx)
	return n, err
}

// PurgeDeletedFiles removes the tombstones of files deleted longer ago than
// both the daily history (history.daily_retention_days) and the changelog
// window (sync.changelog_window_days), together with their delete revision.
//
// Retention never prunes the current revision of a file, and the current
// revision of a tombstone is its delete: without this step tombstones (and
// the path of the deleted file, in clear in shared vaults) lived forever.
// Past both limits the history has nothing older to show and the changelog
// window no longer serves the delete; like any other pruned structural
// operation (ADR-0038), the vault's compaction point moves past it, so a
// cursor from before the delete gets CURSOR_EXPIRED and bootstraps instead of
// never hearing of the deletion. A tombstone a file share points at stays.
// A vault that fails is logged and reported, and the purge goes on with the
// next one, like PurgeDeletedVaults.
func (r *Runner) PurgeDeletedFiles(ctx context.Context) (int, error) {
	days := max(r.setting(ctx, "history.daily_retention_days", 90), r.setting(ctx, "sync.changelog_window_days", 90))
	cutoff := r.now().AddDate(0, 0, -days)
	q, batch := jobsdb.New(r.db.Pool), r.purgeBatch()
	total := 0
	var errs []error
	var after jobsdb.ListExpiredTombstonesRow // keyset (vault, id): the zero value sorts first
	for {
		rows, err := q.ListExpiredTombstones(ctx, jobsdb.ListExpiredTombstonesParams{
			AfterVault: after.VaultID, AfterID: after.ID, Cutoff: cutoff, MaxRows: batch,
		})
		if err != nil {
			return total, errors.Join(append(errs, err)...)
		}
		// The page is ordered by vault: one short transaction per vault.
		for start := 0; start < len(rows); {
			end := start + 1
			for end < len(rows) && rows[end].VaultID == rows[start].VaultID {
				end++
			}
			ids := make([]uuid.UUID, 0, end-start)
			for _, t := range rows[start:end] {
				ids = append(ids, t.ID)
			}
			n, err := r.purgeTombstones(ctx, rows[start].VaultID, ids, cutoff)
			if ctx.Err() != nil {
				return total, ctx.Err()
			}
			if err != nil {
				r.log.Error().Err(err).Str("vault", rows[start].VaultID.String()).Msg("purge of expired tombstones failed")
				errs = append(errs, fmt.Errorf("vault %s: %w", rows[start].VaultID, err))
			}
			total += n
			start = end
		}
		if len(rows) < int(batch) || ctx.Err() != nil {
			return total, cmp.Or(ctx.Err(), errors.Join(errs...))
		}
		after = rows[len(rows)-1]
	}
}

// purgeTombstones deletes the candidates of one vault that are still expired
// tombstones. Locks are taken in the order of a commit: the vault row, the
// file rows, then the blob rows of the references the cascade releases.
func (r *Runner) purgeTombstones(ctx context.Context, vaultID uuid.UUID, ids []uuid.UUID, cutoff time.Time) (int, error) {
	n := 0
	err := r.db.WithTx(ctx, func(ctx context.Context, tx pgx.Tx) error {
		if err := vaults.LockVault(ctx, tx, vaultID); err != nil {
			if errors.Is(err, pgx.ErrNoRows) {
				return nil // the vault was purged meanwhile
			}
			return err
		}
		q := jobsdb.New(tx)
		locked, err := q.LockExpiredTombstones(ctx, jobsdb.LockExpiredTombstonesParams{VaultID: vaultID, Ids: ids, Cutoff: cutoff})
		if err != nil || len(locked) == 0 {
			return err
		}
		// Retention normally left only the delete revision, but whatever
		// history is still there goes with the file: release its references.
		refs, err := q.ListFileBlobRefs(ctx, locked)
		if err != nil {
			return err
		}
		seq, err := q.DeleteTombstones(ctx, locked)
		if err != nil {
			return err
		}
		if seq > 0 {
			if err := vaults.AdvanceCompaction(ctx, tx, vaults.AdvanceCompactionParams{ID: vaultID, Seq: seq}); err != nil {
				return err
			}
		}
		hashes := make([]string, len(refs))
		deltas := make([]int32, len(refs))
		for i, ref := range refs {
			hashes[i], deltas[i] = ref.Hash, -ref.Refs
		}
		if err := blobs.AddRefs(ctx, tx, hashes, deltas); err != nil {
			return err
		}
		n = len(locked)
		return nil
	})
	if err != nil {
		return 0, err // rolled back, commit included
	}
	return n, nil
}

// maintenanceBatch is the number of rows (vaults, blobs, tombstones) one
// maintenance statement handles: the jobs walk the tables in keyset pages
// instead of one round trip per vault or one statement over everything.
const maintenanceBatch = 500

func (r *Runner) purgeBatch() int32 {
	if r.PurgeBatch > 0 {
		return int32(r.PurgeBatch) //nolint:gosec // a page size
	}
	return maintenanceBatch
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
	after := uuid.Nil
	for {
		ids, err := q.ListVaultIDsAfter(ctx, jobsdb.ListVaultIDsAfterParams{After: after, MaxRows: maintenanceBatch})
		if err != nil || len(ids) == 0 {
			return err
		}
		if _, err := q.CompactVaults(ctx, jobsdb.CompactVaultsParams{Ids: ids, Before: cut}); err != nil {
			return err
		}
		if len(ids) < maintenanceBatch {
			return nil
		}
		after = ids[len(ids)-1]
	}
}

// restoreSkew is how long after its retention a deleted vault is purged.
// Restore checks the retention with the clock of the API and the purge with
// the one of the worker: the margin keeps a restore that a slightly late API
// clock still accepts from landing in the middle of a purge, which deletes in
// many transactions and cannot be undone half way.
const restoreSkew = time.Hour

// PurgeDeletedVaults permanently removes vaults deleted longer ago than
// vaults.deleted_retention_days, releasing blob references and quota. A vault
// that fails is logged and reported, and the purge goes on with the next one:
// a deadlock victim or a broken row must not hold back every other vault.
func (r *Runner) PurgeDeletedVaults(ctx context.Context) (int, error) {
	retention := time.Duration(r.setting(ctx, "vaults.deleted_retention_days", 30)) * 24 * time.Hour
	deletedBefore := r.now().Add(-retention - restoreSkew)
	ids, err := jobsdb.New(r.db.Pool).ListDeletedVaultsBefore(ctx, &deletedBefore)
	if err != nil {
		return 0, err
	}
	purged := 0
	var errs []error
	for _, id := range ids {
		gone, err := r.purgeVault(ctx, id, &deletedBefore)
		if ctx.Err() != nil {
			return purged, ctx.Err()
		}
		if err != nil {
			r.log.Error().Err(err).Str("vault", id.String()).Msg("purge of a deleted vault failed")
			errs = append(errs, fmt.Errorf("vault %s: %w", id, err))
			continue
		}
		if gone {
			purged++
		}
	}
	return purged, errors.Join(errs...)
}

// errPurgeBusy stops the purge of a vault whose remaining revisions another
// transaction holds (retention deleting them): the next run continues.
var errPurgeBusy = errors.New("the remaining revisions are held by another transaction")

// purgeVault deletes a vault and everything in it in short transactions: its
// revisions one page at a time with the blob references they held, then its
// files, and last the vault row (with what cascades from it: shares, uploads,
// links to blobs, key envelopes) and the quota it held. Every transaction
// locks the vault row first and, when deletedBefore is set, checks that the
// vault is still deleted and past it: a vault restored meanwhile is left
// alone. The account purge passes nil, its own retention governs. It reports
// whether this call removed the vault.
func (r *Runner) purgeVault(ctx context.Context, id uuid.UUID, deletedBefore *time.Time) (bool, error) {
	pages, batch := 0, r.purgeBatch()
	for {
		var gone, stop bool
		var chunks []string
		err := r.db.WithTx(ctx, func(ctx context.Context, tx pgx.Tx) error {
			q := jobsdb.New(tx)
			v, err := q.GetVaultForUpdate(ctx, id)
			if errors.Is(err, pgx.ErrNoRows) {
				stop = true // purged meanwhile
				return nil
			}
			if err != nil {
				return err
			}
			if deletedBefore != nil && (v.DeletedAt == nil || !v.DeletedAt.Before(*deletedBefore)) {
				stop = true
				if pages > 0 {
					r.log.Warn().Str("vault", id.String()).Int("pages", pages).Msg("vault restored during its purge")
				}
				return nil
			}
			// Revisions first, a page per transaction. The blob rows are
			// locked in hash order after the vault row, like a commit does.
			refs, err := revisions.DeleteVaultRevisionsPage(ctx, tx, id, batch)
			if err != nil {
				return err
			}
			if len(refs) > 0 {
				hashes := make([]string, 0, len(refs))
				deltas := make([]int32, 0, len(refs))
				for _, ref := range refs {
					if ref.BlobHash != nil {
						hashes = append(hashes, *ref.BlobHash)
						deltas = append(deltas, -ref.Refs)
					}
				}
				return blobs.AddRefs(ctx, tx, hashes, deltas)
			}
			// Nothing deleted: none left, or what is left is held elsewhere.
			if left, err := q.VaultHasRevisions(ctx, id); err != nil || left {
				return cmp.Or(err, errPurgeBusy)
			}
			if n, err := q.DeleteVaultFilesPage(ctx, jobsdb.DeleteVaultFilesPageParams{VaultID: id, MaxRows: batch}); err != nil || n > 0 {
				return err
			}
			// Last, the vault row. The quota is released after the vault row
			// and before anything else, in the order of a commit.
			if v.TotalBytes > 0 {
				if err := quota.Release(ctx, tx, v.OwnerID, v.TotalBytes); err != nil {
					return err
				}
			}
			// The uploads in progress go with the vault row; their chunk
			// objects are deleted once that is committed (best effort:
			// SweepOrphanChunks takes what is left).
			if chunks, err = blobs.UploadChunksOfVault(ctx, tx, id); err != nil {
				return err
			}
			if err := q.DeleteVault(ctx, id); err != nil {
				return err
			}
			gone = true
			return nil
		})
		if errors.Is(err, errPurgeBusy) {
			r.log.Info().Err(err).Str("vault", id.String()).Msg("vault purge postponed to the next run")
			return false, nil
		}
		if err != nil || gone || stop {
			for _, k := range chunks {
				if err != nil || !gone {
					break // rolled back: the uploads are still there
				}
				_ = r.store.Delete(context.WithoutCancel(ctx), k)
			}
			return gone, err
		}
		pages++
	}
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
	perOwner := map[uuid.UUID]int64{}
	for after := uuid.Nil; ; {
		totals, err := q.ListVaultTotalsAfter(ctx, jobsdb.ListVaultTotalsAfterParams{After: after, MaxRows: maintenanceBatch})
		if err != nil {
			return err
		}
		for _, v := range totals {
			perOwner[v.OwnerID] += v.Bytes
			if v.StoredBytes != v.Bytes || v.StoredFiles != v.Files {
				if err := r.reconcileVault(ctx, v.VaultID); err != nil {
					return err
				}
			}
		}
		if len(totals) < maintenanceBatch {
			break
		}
		after = totals[len(totals)-1].VaultID
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
	for after := ""; ; {
		rows, err := jobsdb.New(r.db.Pool).ListBlobRefCountsAfter(ctx, jobsdb.ListBlobRefCountsAfterParams{After: after, MaxRows: maintenanceBatch})
		if err != nil {
			return err
		}
		for _, b := range rows {
			if b.RefCount == b.Actual {
				continue
			}
			if err := r.reconcileBlob(ctx, b.Hash); err != nil {
				return err
			}
		}
		if len(rows) < maintenanceBatch {
			return nil
		}
		after = rows[len(rows)-1].Hash
	}
}

// reconcileBlob corrects the reference count of one blob under its row lock.
func (r *Runner) reconcileBlob(ctx context.Context, hash string) error {
	return r.db.WithTx(ctx, func(ctx context.Context, tx pgx.Tx) error {
		q := jobsdb.New(tx)
		stored, err := q.GetBlobRefForUpdate(ctx, hash)
		if errors.Is(err, pgx.ErrNoRows) {
			return nil // collected meanwhile
		}
		if err != nil {
			return err
		}
		actual, err := q.CountBlobRefs(ctx, &hash)
		if err != nil {
			return err
		}
		if stored == actual {
			return nil
		}
		r.log.Warn().Str("blob", hash).Int32("stored", stored).Int32("actual", actual).Msg("blob ref count corrected")
		return q.SetBlobRef(ctx, jobsdb.SetBlobRefParams{Hash: hash, RefCount: actual})
	})
}
