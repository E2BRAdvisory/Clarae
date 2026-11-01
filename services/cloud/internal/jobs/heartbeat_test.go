package jobs

import (
	"context"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/rs/zerolog"

	"memobrain/services/cloud/internal/db"
)

// The scheduler heartbeat advances while Run is active, even though no job
// runs (the first run is an hour away), and drops to zero when Run returns:
// the worker's /healthz relies on it.
func TestRunHeartbeat(t *testing.T) {
	// pgxpool connects lazily: no database is needed while no job runs.
	pool, err := pgxpool.New(context.Background(), "postgres://nobody@127.0.0.1:1/none")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	r := New(&db.DB{Pool: pool}, nil, nil, nil, zerolog.Nop())
	r.FirstRunDelay, r.HeartbeatInterval = time.Hour, 10*time.Millisecond
	if !r.LastTick().IsZero() {
		t.Fatal("LastTick before Run")
	}
	ctx, cancel := context.WithCancel(context.Background())
	stopped := make(chan struct{})
	go func() { r.Run(ctx); close(stopped) }()

	deadline := time.Now().Add(5 * time.Second)
	for r.LastTick().IsZero() {
		if time.Now().After(deadline) {
			t.Fatal("no heartbeat")
		}
		time.Sleep(time.Millisecond)
	}
	first := r.LastTick()
	for !r.LastTick().After(first) {
		if time.Now().After(deadline) {
			t.Fatal("the heartbeat does not advance")
		}
		time.Sleep(5 * time.Millisecond)
	}
	cancel()
	select {
	case <-stopped:
	case <-time.After(5 * time.Second):
		t.Fatal("Run did not return")
	}
	if !r.LastTick().IsZero() {
		t.Fatal("LastTick survives Run")
	}
	if New(nil, nil, nil, nil, zerolog.Nop()).Heartbeat() != DefaultHeartbeat {
		t.Fatal("default heartbeat")
	}
}
