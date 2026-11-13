package observability

import (
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promauto"
)

// Domain collectors live on the default registry next to the HTTP ones. They are
// package-level so modules record events with one call and no wiring; every label
// has a small closed value set (cardinality stays bounded).
var (
	syncCommits = promauto.NewCounterVec(prometheus.CounterOpts{
		Namespace: namespace, Subsystem: "sync", Name: "commits_total",
		Help: "Sync commit requests by outcome (ok = processed, error = failed as a whole).",
	}, []string{"outcome"})
	syncOps = promauto.NewCounterVec(prometheus.CounterOpts{
		Namespace: namespace, Subsystem: "sync", Name: "ops_total",
		Help: "Sync operations by result status (accepted, conflict, rejected).",
	}, []string{"status"})
	syncCommitFallbacks = promauto.NewCounterVec(prometheus.CounterOpts{
		Namespace: namespace, Subsystem: "sync", Name: "commit_fallbacks_total",
		Help: "Commit batches replayed one operation per transaction after losing a race, by reason (unique, quota, serialization, deadlock, other).",
	}, []string{"reason"})
	streams = promauto.NewGauge(prometheus.GaugeOpts{
		Namespace: namespace, Subsystem: "notify", Name: "streams_active",
		Help: "Open notification streams (gRPC and SSE) on this process.",
	})
	jobRuns = promauto.NewCounterVec(prometheus.CounterOpts{
		Namespace: namespace, Subsystem: "jobs", Name: "runs_total",
		Help: "Background job runs by job and result (ok, error).",
	}, []string{"job", "result"})
	jobDuration = promauto.NewHistogramVec(prometheus.HistogramOpts{
		Namespace: namespace, Subsystem: "jobs", Name: "run_duration_seconds",
		Help:    "Background job run time by job.",
		Buckets: []float64{.1, .5, 1, 5, 15, 60, 300, 900, 3600},
	}, []string{"job"})
	jobItemFailures = promauto.NewCounterVec(prometheus.CounterOpts{
		Namespace: namespace, Subsystem: "jobs", Name: "item_failures_total",
		Help: "Items a background job skipped after an error (it went on with the others), by job.",
	}, []string{"job"})
	jobLastSuccess = promauto.NewGaugeVec(prometheus.GaugeOpts{
		Namespace: namespace, Subsystem: "jobs", Name: "last_success_timestamp_seconds",
		Help: "Unix time of the last successful run of each job.",
	}, []string{"job"})
)

// SyncCommit records one commit request: err is a whole-request failure, otherwise
// statuses lists the result status of each operation.
func SyncCommit(err error, statuses []string) {
	if err != nil {
		syncCommits.WithLabelValues("error").Inc()
		return
	}
	syncCommits.WithLabelValues("ok").Inc()
	for _, s := range statuses {
		syncOps.WithLabelValues(s).Inc()
	}
}

// SyncCommitFallback records a commit batch that fell back to the slow path.
func SyncCommitFallback(reason string) { syncCommitFallbacks.WithLabelValues(reason).Inc() }

// StreamOpened tracks an active notification stream.
func StreamOpened() { streams.Inc() }

// StreamClosed is the counterpart of StreamOpened.
func StreamClosed() { streams.Dec() }

// JobRun records one run of a background job.
func JobRun(job string, took time.Duration, err error) {
	result := "ok"
	if err != nil {
		result = "error"
	} else {
		jobLastSuccess.WithLabelValues(job).SetToCurrentTime()
	}
	jobRuns.WithLabelValues(job, result).Inc()
	jobDuration.WithLabelValues(job).Observe(took.Seconds())
}

// JobItemFailed records one item a job could not process and skipped.
func JobItemFailed(job string) { jobItemFailures.WithLabelValues(job).Inc() }

// RegisterPool exposes the pgx pool statistics (clarae_db_pool_*).
func RegisterPool(reg prometheus.Registerer, pool *pgxpool.Pool) {
	reg.MustRegister(poolCollector{pool})
}

type poolCollector struct{ pool *pgxpool.Pool }

var (
	descConns = prometheus.NewDesc("clarae_db_pool_connections", "Pool connections by state (acquired, idle, total, max).", []string{"state"}, nil)
	descWait  = prometheus.NewDesc("clarae_db_pool_acquire_wait_seconds_total", "Total time callers waited for a connection.", nil, nil)
	descAcq   = prometheus.NewDesc("clarae_db_pool_acquires_total", "Completed connection acquisitions.", nil, nil)
	descEmpty = prometheus.NewDesc("clarae_db_pool_empty_acquires_total", "Acquisitions that had to wait because the pool was exhausted.", nil, nil)
)

func (poolCollector) Describe(ch chan<- *prometheus.Desc) {
	ch <- descConns
	ch <- descWait
	ch <- descAcq
	ch <- descEmpty
}

func (c poolCollector) Collect(ch chan<- prometheus.Metric) {
	s := c.pool.Stat()
	for state, v := range map[string]int32{"acquired": s.AcquiredConns(), "idle": s.IdleConns(), "total": s.TotalConns(), "max": s.MaxConns()} {
		ch <- prometheus.MustNewConstMetric(descConns, prometheus.GaugeValue, float64(v), state)
	}
	ch <- prometheus.MustNewConstMetric(descWait, prometheus.CounterValue, s.AcquireDuration().Seconds())
	ch <- prometheus.MustNewConstMetric(descAcq, prometheus.CounterValue, float64(s.AcquireCount()))
	ch <- prometheus.MustNewConstMetric(descEmpty, prometheus.CounterValue, float64(s.EmptyAcquireCount()))
}
