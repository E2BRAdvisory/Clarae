//go:build integration

package integration

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"

	"memobrain/services/cloud/internal/db"
)

// windowScanPending is PendingUploadBytes as it was before M12-W6.1: every
// blob the owner linked within the upload window is read, which during a
// first sync is every blob uploaded so far. It is the reference the shipped
// query must agree with.
const windowScanPending = `SELECT (
  COALESCE((SELECT sum(b.size) FROM blobs b JOIN vault_blobs vb ON vb.hash = b.hash
            WHERE b.ref_count = 0 AND vb.vault_id = ANY($2::uuid[])
              AND vb.created_at > $1::timestamptz), 0)
  + COALESCE((SELECT sum(u.length) FROM uploads u
              WHERE u.vault_id = ANY($2::uuid[]) AND u.expires_at > now()
                AND u.id <> $3::uuid), 0)
)::bigint AS pending`

// shippedPendingQuery reads the SQL of PendingUploadBytes that sqlc generated,
// so the plan checked here is the one the service runs.
func shippedPendingQuery(t *testing.T) string {
	t.Helper()
	root, err := repoRoot()
	if err != nil {
		t.Fatal(err)
	}
	src, err := os.ReadFile(filepath.Join(root, "services", "cloud", "internal", "blobs", "blobsdb", "blobs.sql.go"))
	if err != nil {
		t.Fatal(err)
	}
	m := regexp.MustCompile("(?s)const pendingUploadBytes = `-- name: PendingUploadBytes :one\n(.*?)`").FindSubmatch(src)
	if m == nil {
		t.Fatal("PendingUploadBytes not found in the generated code")
	}
	q := string(m[1])
	// Parameter order of the generated code: since, vault ids, except upload.
	if !strings.Contains(q, "$1::timestamptz") || !strings.Contains(q, "$2::uuid[]") || !strings.Contains(q, "$3::uuid") {
		t.Fatalf("unexpected parameters in PendingUploadBytes:\n%s", q)
	}
	return q
}

// planNode is a node of EXPLAIN (ANALYZE, FORMAT JSON).
type planNode struct {
	NodeType     string     `json:"Node Type"`
	RelationName string     `json:"Relation Name"`
	IndexName    string     `json:"Index Name"`
	ActualRows   float64    `json:"Actual Rows"`
	ActualLoops  float64    `json:"Actual Loops"`
	Plans        []planNode `json:"Plans"`
}

// rowsOf sums the rows the plan read from a table, over all loops: its scans,
// and the index-only scans of its indexes (a bitmap index scan is counted by
// the heap scan above it).
func (n planNode) rowsOf(table string) float64 {
	sum := 0.0
	if n.RelationName == table && !strings.HasPrefix(n.NodeType, "Bitmap Index") {
		sum += n.ActualRows * n.ActualLoops
	}
	for _, c := range n.Plans {
		sum += c.rowsOf(table)
	}
	return sum
}

// The upload quota sums, at every upload and under the owner's lock, the
// bytes uploaded but not committed (PendingUploadBytes). During the first
// sync of a large vault every blob is linked within the upload window, so a
// plan that walks the window reads each blob uploaded so far again for every
// upload: O(N^2) over the sync. The query must read only the blobs nobody
// references, and still agree with the window scan.
func TestPendingUploadBytesDoesNotScanTheWindow(t *testing.T) {
	ctx := context.Background()
	d, err := db.Open(ctx, freshDatabase(t, "pending_plan"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(d.Close)
	if err := d.Migrate(ctx); err != nil {
		t.Fatal(err)
	}
	const committed, pending, size = 50000, 100, 1000
	owner, vault, second := uuid.New(), uuid.New(), uuid.New()
	other, otherVault := uuid.New(), uuid.New()
	finalizing := uuid.New()
	for _, q := range []struct {
		sql  string
		args []any
	}{
		{`INSERT INTO users (id, keycloak_sub, username, email) VALUES ($1, $3, 'owner', 'owner@example.test'), ($2, $4, 'other', 'other@example.test')`,
			[]any{owner, other, owner.String(), other.String()}},
		{`INSERT INTO vaults (id, owner_id, name, kind) VALUES ($1, $2, 'v', 'shared'), ($3, $2, 'w', 'shared'), ($4, $5, 'o', 'shared')`,
			[]any{vault, owner, second, otherVault, other}},
		// The owner's first sync so far: committed blobs (referenced) and the
		// blobs of the batch in flight (not yet), all linked within the window.
		{`INSERT INTO blobs (hash, size, storage_key, ref_count, unreferenced_since)
		  SELECT md5('a'||i)||md5('b'||i), $1::bigint, 'k', CASE WHEN i <= $2::int THEN 1 ELSE 0 END, CASE WHEN i <= $2::int THEN NULL ELSE now() END
		  FROM generate_series(1, $2::int + $3::int) i`, []any{size, committed, pending}},
		{`INSERT INTO vault_blobs (vault_id, hash) SELECT $1, md5('a'||i)||md5('b'||i) FROM generate_series(1, $2::int) i`, []any{vault, committed + pending}},
		// A pending blob linked to the owner's second vault too: counted once per link, as before.
		{`INSERT INTO vault_blobs (vault_id, hash) VALUES ($1, md5('a'||$2::int)||md5('b'||$2::int))`, []any{second, committed + 1}},
		// A blob unreferenced since before the window that the owner linked
		// then: outside the window, not pending.
		{`INSERT INTO blobs (hash, size, storage_key, ref_count, unreferenced_since) VALUES (md5('old')||md5('old'), $1::bigint, 'k', 0, now() - interval '3 days')`, []any{size}},
		{`INSERT INTO vault_blobs (vault_id, hash, created_at) VALUES ($1, md5('old')||md5('old'), now() - interval '3 days')`, []any{vault}},
		// Another user: older blobs, a few of them unreferenced within the GC grace.
		{`INSERT INTO blobs (hash, size, storage_key, ref_count, unreferenced_since, created_at)
		  SELECT md5('c'||i)||md5('d'||i), $1::bigint, 'k', CASE WHEN i <= 95000 THEN 1 ELSE 0 END,
		         CASE WHEN i <= 95000 THEN NULL ELSE now() - interval '3 days' END, now() - interval '10 days'
		  FROM generate_series(1, 100000) i`, []any{size}},
		{`INSERT INTO vault_blobs (vault_id, hash, created_at) SELECT $1, md5('c'||i)||md5('d'||i), now() - interval '10 days' FROM generate_series(1, 100000) i`, []any{otherVault}},
		// A resumable upload in progress, and the one being finalized (not counted).
		{`INSERT INTO uploads (id, vault_id, user_id, expected_hash, length, expires_at) VALUES ($1, $2, $3, md5('u')||md5('u'), 5000, now() + interval '1 day'),
		  ($4, $2, $3, md5('f')||md5('f'), 7000, now() + interval '1 day')`, []any{uuid.New(), vault, owner, finalizing}},
		{`ANALYZE`, nil},
	} {
		if _, err := d.Pool.Exec(ctx, q.sql, q.args...); err != nil {
			t.Fatalf("%s: %v", q.sql, err)
		}
	}

	shipped := shippedPendingQuery(t)
	args := []any{time.Now().Add(-24 * time.Hour), []uuid.UUID{vault, second}, finalizing}
	var got, want int64
	if err := d.Pool.QueryRow(ctx, shipped, args...).Scan(&got); err != nil {
		t.Fatal(err)
	}
	if err := d.Pool.QueryRow(ctx, windowScanPending, args...).Scan(&want); err != nil {
		t.Fatal(err)
	}
	if wantBytes := int64((pending+1)*size + 5000); want != wantBytes || got != want {
		t.Fatalf("pending bytes: shipped query %d, window scan %d, want %d", got, want, wantBytes)
	}

	read := func(q string) float64 {
		var raw []byte
		if err := d.Pool.QueryRow(ctx, "EXPLAIN (ANALYZE, FORMAT JSON) "+q, args...).Scan(&raw); err != nil {
			t.Fatal(err)
		}
		var plans []struct{ Plan planNode }
		if err := json.Unmarshal(raw, &plans); err != nil || len(plans) != 1 {
			t.Fatalf("explain output: %v\n%s", err, raw)
		}
		return plans[0].Plan.rowsOf("vault_blobs")
	}
	before, after := read(windowScanPending), read(shipped)
	t.Logf("vault_blobs rows read per upload check: window scan %.0f, shipped query %.0f", before, after)
	if after > 10*pending {
		t.Fatalf("PendingUploadBytes reads %.0f rows of vault_blobs for %d pending blobs (the window holds %d): it scans the window", after, pending, committed+pending)
	}
}
