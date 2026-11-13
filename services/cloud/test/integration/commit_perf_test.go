//go:build integration

package integration

import (
	"bytes"
	"context"
	"fmt"
	"sync/atomic"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"clarae/services/cloud/internal/db"
	syncmod "clarae/services/cloud/internal/sync"
	"clarae/shared/syncproto"
)

// queryCounter counts the statements sent to PostgreSQL (each one a round trip).
type queryCounter struct{ n atomic.Int64 }

func (c *queryCounter) TraceQueryStart(ctx context.Context, _ *pgx.Conn, _ pgx.TraceQueryStartData) context.Context {
	c.n.Add(1)
	return ctx
}

func (c *queryCounter) TraceQueryEnd(context.Context, *pgx.Conn, pgx.TraceQueryEndData) {}

// TestCommitRoundTrips measures the statements and the time a 500-operation
// commit costs while it holds the vault lock (commit-roundtrips): the
// per-operation work must stay a handful of statements, the rest is batched.
func TestCommitRoundTrips(t *testing.T) {
	e := newEnv(t)
	ada := e.user("ada")
	v := ada.createVault("Bulk", "shared")
	const n = syncproto.MaxOpsPerCommit
	ctx := context.Background()
	user, vault, device := uuid.MustParse(ada.userID), uuid.MustParse(v), uuid.MustParse(ada.deviceID)
	// Through the service: a thousand PUTs would exhaust the per-address rate limit.
	put := func(data []byte) string {
		h := hashOf(data)
		if err := e.app.Blobs.Put(ctx, user, vault, "", h, bytes.NewReader(data)); err != nil {
			t.Fatal(err)
		}
		return h
	}
	hashes := make([]string, n)
	for i := range hashes {
		hashes[i] = put([]byte(fmt.Sprintf("content %d", i)))
	}
	edited := make([]string, n)
	for i := range edited {
		edited[i] = put([]byte(fmt.Sprintf("edited %d", i)))
	}

	cfg, err := pgxpool.ParseConfig(databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	counter := &queryCounter{}
	cfg.ConnConfig.Tracer = counter
	pool, err := pgxpool.NewWithConfig(ctx, cfg)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	svc := syncmod.NewService(&db.DB{Pool: pool}, e.app.Sharing, e.app.Quota)

	ids := make([]string, n)
	creates := make([]syncproto.Op, n)
	for i := range creates {
		ids[i] = newID()
		creates[i] = syncproto.Op{OpID: newID(), Op: syncproto.OpCreate, FileID: ids[i], Path: fmt.Sprintf("bulk/f%04d.md", i), BlobHash: hashes[i]}
	}
	measure := func(label string, ops []syncproto.Op) (perOp float64) {
		t.Helper()
		before := counter.n.Load()
		start := time.Now()
		resp, err := svc.Commit(ctx, user, vault, "", device, ops)
		if err != nil {
			t.Fatal(err)
		}
		elapsed := time.Since(start)
		for _, r := range resp.Results {
			if r.Status != syncproto.StatusAccepted {
				t.Fatalf("%s: %+v", label, r)
			}
		}
		stmts := counter.n.Load() - before
		perOp = float64(stmts) / float64(len(ops))
		t.Logf("%s: %d ops, %d statements (%.2f per op), %v (%.0f µs per op)", label, len(ops), stmts, perOp, elapsed, float64(elapsed.Microseconds())/float64(len(ops)))
		return perOp
	}
	createCost := measure("create", creates)

	modifies := make([]syncproto.Op, n)
	for i := range modifies {
		base := 1
		modifies[i] = syncproto.Op{OpID: newID(), Op: syncproto.OpModify, FileID: ids[i], BaseRev: &base, BlobHash: edited[i]}
	}
	modifyCost := measure("modify", modifies)

	// A retried batch is answered from the operation ids.
	retryCost := measure("retry", modifies)

	// Before this batching (M11 HEAD 8d508a6): 10.0 statements per create, 9.0 per
	// modify, 1.0 per retried operation; a 500-op batch held the vault lock 2.5x longer.
	if createCost > 4.1 || modifyCost > 3.1 || retryCost > 0.1 {
		t.Errorf("statements per operation: create %.2f (max 4.1), modify %.2f (max 3.1), retry %.2f (max 0.1)", createCost, modifyCost, retryCost)
	}
}
