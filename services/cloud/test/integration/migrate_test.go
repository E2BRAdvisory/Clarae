//go:build integration

package integration

import (
	"context"
	"errors"
	"fmt"
	"net/url"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"

	"memobrain/services/cloud/internal/db"
)

// freshDatabase creates an empty database next to the shared one and returns its URL.
func freshDatabase(t *testing.T, name string) string {
	t.Helper()
	ctx := context.Background()
	conn, err := pgx.Connect(ctx, databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = conn.Close(ctx) }()
	name = fmt.Sprintf("%s_%d", name, time.Now().UnixNano())
	if _, err := conn.Exec(ctx, "CREATE DATABASE "+pgx.Identifier{name}.Sanitize()); err != nil {
		t.Fatal(err)
	}
	u, err := url.Parse(databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	u.Path = "/" + name
	return u.String()
}

// Helm runs two or more API replicas and each migrates at start: on a fresh
// database they must not race each other into duplicate-object errors. The
// goose session lock serialises them.
func TestConcurrentMigrationsOnAFreshDatabase(t *testing.T) {
	ctx := context.Background()
	url := freshDatabase(t, "migrate_race")
	const replicas = 4
	var wg sync.WaitGroup
	errs := make([]error, replicas)
	dbs := make([]*db.DB, replicas)
	for i := range replicas {
		d, err := db.Open(ctx, url)
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(d.Close)
		dbs[i] = d
	}
	for i := range replicas {
		wg.Go(func() { errs[i] = dbs[i].Migrate(ctx) })
	}
	wg.Wait()
	for i, err := range errs {
		if err != nil {
			t.Errorf("replica %d: %v", i, err)
		}
	}
	if err := dbs[0].CheckSchema(ctx); err != nil {
		t.Fatalf("schema after the migrations: %v", err)
	}
	current, expected, err := dbs[0].SchemaVersion(ctx)
	if err != nil || current != expected {
		t.Fatalf("schema version %d, want %d (%v)", current, expected, err)
	}
	// Each migration ran exactly once: without the lock, replicas racing on
	// idempotent statements apply the same version several times.
	var applied, distinct int64
	if err := dbs[0].Pool.QueryRow(ctx, "SELECT count(*), count(DISTINCT version_id) FROM goose_db_version WHERE version_id > 0").Scan(&applied, &distinct); err != nil {
		t.Fatal(err)
	}
	if applied != distinct || distinct != expected {
		t.Fatalf("goose_db_version: %d rows for %d versions, want %d", applied, distinct, expected)
	}
}

// The worker never migrates: it waits until the API brought the schema to
// the version the binary expects.
func TestWorkerWaitsForTheSchema(t *testing.T) {
	ctx := context.Background()
	url := freshDatabase(t, "schema_wait")
	worker, err := db.Open(ctx, url)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(worker.Close)
	if err := worker.CheckSchema(ctx); !errors.Is(err, db.ErrSchemaBehind) {
		t.Fatalf("empty database: %v, want ErrSchemaBehind", err)
	}
	current, expected, err := worker.SchemaVersion(ctx)
	if err != nil || current != 0 || expected < 1 {
		t.Fatalf("empty database: version %d of %d (%v)", current, expected, err)
	}

	retries := 0
	done := make(chan error, 1)
	waitCtx, cancel := context.WithTimeout(ctx, time.Minute)
	defer cancel()
	go func() {
		done <- worker.WaitForSchema(waitCtx, 20*time.Millisecond, 100*time.Millisecond, func(err error, _ time.Duration) {
			if !errors.Is(err, db.ErrSchemaBehind) {
				t.Errorf("retry reason: %v", err)
			}
			retries++
		})
	}()
	time.Sleep(200 * time.Millisecond)
	select {
	case err := <-done:
		t.Fatalf("WaitForSchema returned before the migration: %v", err)
	default:
	}

	api, err := db.Open(ctx, url)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(api.Close)
	if err := api.Migrate(ctx); err != nil {
		t.Fatal(err)
	}
	if err := <-done; err != nil {
		t.Fatalf("WaitForSchema: %v", err)
	}
	if retries == 0 {
		t.Fatal("no retry reported")
	}

	// A cancelled wait reports why it gave up.
	cctx, ccancel := context.WithCancel(ctx)
	ccancel()
	empty, err := db.Open(ctx, freshDatabase(t, "schema_cancel"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(empty.Close)
	if err := empty.WaitForSchema(cctx, time.Millisecond, time.Millisecond, nil); err == nil || !strings.Contains(err.Error(), "schema") {
		t.Fatalf("cancelled wait: %v", err)
	}
}
