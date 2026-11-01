//go:build integration

package integration

import (
	"context"
	"testing"
	"time"

	"github.com/prometheus/client_golang/prometheus"
	"github.com/rs/zerolog"

	"memobrain/services/cloud/internal/app"
	"memobrain/services/cloud/internal/db"
	"memobrain/services/cloud/internal/storage"
)

// jobRuns reads memobrain_jobs_runs_total of one job, every result included.
func jobRuns(t *testing.T, job string) float64 {
	t.Helper()
	families, err := prometheus.DefaultGatherer.Gather()
	if err != nil {
		t.Fatal(err)
	}
	total := 0.0
	for _, mf := range families {
		if mf.GetName() != "memobrain_jobs_runs_total" {
			continue
		}
		for _, m := range mf.GetMetric() {
			for _, l := range m.GetLabel() {
				if l.GetName() == "job" && l.GetValue() == job {
					total += m.GetCounter().GetValue()
				}
			}
		}
	}
	return total
}

// Regression (A4): every loop held a connection of the main pool for its
// advisory lock while its job needed another one; with the loops starting
// together on a small pool, all connections went to locks and every job
// waited forever. The locks now live on a pool of their own.
func TestJobRunnerCompletesOnATinyPool(t *testing.T) {
	ctx := context.Background()
	database, err := db.Open(ctx, databaseURL+"&pool_max_conns=2")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(database.Close)
	if err := database.Migrate(ctx); err != nil {
		t.Fatal(err)
	}
	store, err := storage.NewFS(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	r := app.New(database, store, zerolog.Nop()).Jobs()
	every := 50 * time.Millisecond
	r.GCInterval, r.UploadsInterval, r.RetentionInterval, r.MaintenanceInterval, r.ExportsInterval = every, every, every, every, every
	r.FirstRunDelay, r.Stagger = 10*time.Millisecond, -1 // every loop at once: the worst case

	names := []string{"blob-gc", "uploads", "retention", "maintenance", "exports"}
	before := map[string]float64{}
	for _, n := range names {
		before[n] = jobRuns(t, n)
	}
	runCtx, cancel := context.WithCancel(ctx)
	defer cancel()
	stopped := make(chan struct{})
	go func() { r.Run(runCtx); close(stopped) }()

	deadline := time.Now().Add(60 * time.Second)
	for {
		pending := ""
		for _, n := range names {
			if jobRuns(t, n) < before[n]+2 {
				pending = n
				break
			}
		}
		if pending == "" {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("job %s did not complete twice on a pool of 2 connections (deadlock?)", pending)
		}
		time.Sleep(50 * time.Millisecond)
	}
	cancel()
	select {
	case <-stopped:
	case <-time.After(30 * time.Second):
		t.Fatal("the runner did not stop")
	}
}
