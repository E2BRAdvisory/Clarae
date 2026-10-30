//go:build integration

package integration

import (
	"bytes"
	"context"
	"fmt"
	"net/http"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"memobrain/services/cloud/internal/blobs"
	"memobrain/services/cloud/internal/db/dbgen"
	"memobrain/services/cloud/internal/jobs"
	"memobrain/shared/syncproto"
)

func (e *env) jobs(now time.Time) *jobs.Runner {
	r := e.app.Jobs()
	r.SetClock(func() time.Time { return now })
	return r
}

func (e *env) exec(sql string, args ...any) {
	e.t.Helper()
	if _, err := e.db.Pool.Exec(context.Background(), sql, args...); err != nil {
		e.t.Fatal(err)
	}
}

func TestBlobGarbageCollection(t *testing.T) {
	e := newEnv(t)
	ada := e.user("ada")
	v := ada.createVault("GC", "shared")
	used := ada.putBlob(v, []byte("referenced"))
	orphan := ada.putBlob(v, []byte("uploaded but never committed"))
	mustAccepted(t, ada.commit(v, create(newID(), "a.md", used))[0])

	// Inside the 24 h grace period nothing is collected.
	n, err := e.jobs(time.Now()).CollectBlobs(context.Background())
	if err != nil || n != 0 {
		t.Fatalf("collected %d inside the grace period (%v)", n, err)
	}
	// After it, only the unreferenced blob goes, object and row.
	n, err = e.jobs(time.Now().Add(25 * time.Hour)).CollectBlobs(context.Background())
	if err != nil || n < 1 {
		t.Fatalf("collected %d (%v)", n, err)
	}
	if r := ada.json(http.MethodGet, "/vaults/"+v+"/blobs/"+orphan, nil); r.StatusCode != http.StatusNotFound {
		t.Fatalf("orphan blob still served: %d", r.StatusCode)
	}
	if r := ada.json(http.MethodGet, "/vaults/"+v+"/blobs/"+used, nil); r.StatusCode != http.StatusOK {
		t.Fatalf("referenced blob lost: %d", r.StatusCode)
	}
	// A commit that referenced the collected blob is told to upload it again.
	if res := ada.commit(v, create(newID(), "b.md", orphan)); res[0].code() != "BLOB_MISSING" {
		t.Fatalf("collected blob accepted: %v", res[0])
	}
}

// Regression (D3): the collector deleted the object before the guarded row
// delete, so a commit referencing the blob in between kept the row and lost
// the bytes. Now a commit locks the blob it references, and the collector
// waits for it and then spares the blob.
func TestBlobGCSparesABlobACommitIsReferencing(t *testing.T) {
	e := newEnv(t)
	ada := e.user("ada")
	v := ada.createVault("GC race", "shared")
	h := ada.putBlob(v, []byte("referenced while collected "+newID()))
	vid := uuid.MustParse(v)
	ctx := context.Background()

	// A commit in flight: it has checked the blob but not yet added its reference.
	locked, release := make(chan struct{}), make(chan struct{})
	commitErr := make(chan error, 1)
	go func() {
		commitErr <- e.db.WithTx(ctx, func(ctx context.Context, q *dbgen.Queries, _ pgx.Tx) error {
			_, ok, err := blobs.VaultBlob(ctx, q, vid, h)
			if err != nil || !ok {
				close(locked)
				return fmt.Errorf("blob not found before collection (ok=%v): %v", ok, err)
			}
			close(locked)
			<-release
			return blobs.AddRef(ctx, q, h, 1)
		})
	}()
	<-locked

	gcErr := make(chan error, 1)
	go func() {
		_, err := e.jobs(time.Now().Add(25 * time.Hour)).CollectBlobs(ctx)
		gcErr <- err
	}()
	select {
	case err := <-gcErr:
		t.Fatalf("the collector finished while a commit held the blob (%v)", err)
	case <-time.After(500 * time.Millisecond):
	}
	close(release)
	if err := <-commitErr; err != nil {
		t.Fatal(err)
	}
	if err := <-gcErr; err != nil {
		t.Fatal(err)
	}
	if r := ada.json(http.MethodGet, "/vaults/"+v+"/blobs/"+h, nil); r.StatusCode != http.StatusOK {
		t.Fatalf("referenced blob collected: %d", r.StatusCode)
	}
}

func TestRevisionRetention(t *testing.T) {
	e := newEnv(t)
	ada := e.user("ada")
	v := ada.createVault("Retention", "shared")
	f := newID()
	var hs []string
	for i := 0; i < 6; i++ {
		hs = append(hs, ada.putBlob(v, bytes.Repeat([]byte{byte('a' + i)}, 10+i)))
	}
	mustAccepted(t, ada.commit(v, create(f, "n.md", hs[0]))[0])
	for i := 1; i < 6; i++ {
		mustAccepted(t, ada.commit(v, modify(f, i, hs[i]))[0])
	}
	// Place the six revisions in time: two on day -40, two on day -50, one on day -100, the current one now.
	now := time.Now().UTC()
	times := []time.Time{now.AddDate(0, 0, -100), now.AddDate(0, 0, -50).Add(time.Hour), now.AddDate(0, 0, -50).Add(2 * time.Hour), now.AddDate(0, 0, -40).Add(time.Hour), now.AddDate(0, 0, -40).Add(2 * time.Hour), now}
	for i, ts := range times {
		e.exec(`UPDATE file_revisions SET server_time = $1 WHERE file_id = $2 AND rev_no = $3`, ts, f, i+1)
	}
	n, err := e.jobs(now).PruneRevisions(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	// Day -100 is beyond 90 days (deleted); on days -50 and -40 only the last revision of each day survives; recent one stays.
	resp := ada.json(http.MethodGet, "/vaults/"+v+"/files/"+f+"/revisions", nil)
	var revs []float64
	for _, it := range decode[struct{ Items []map[string]any }](t, resp).Items {
		revs = append(revs, it["rev"].(float64))
	}
	if n != 3 || len(revs) != 3 || revs[0] != 6 || revs[1] != 5 || revs[2] != 3 {
		t.Fatalf("pruned %d, remaining %v, want [6 5 3]", n, revs)
	}
	// Blob references of the deleted revisions were released.
	var refs int
	if err := e.db.Pool.QueryRow(ctxBg(), `SELECT ref_count FROM blobs WHERE hash=$1`, hs[0]).Scan(&refs); err != nil || refs != 0 {
		t.Fatalf("ref_count of a pruned blob = %d (%v)", refs, err)
	}
	// The current revision is never pruned even when ancient.
	e.exec(`UPDATE file_revisions SET server_time = $1 WHERE file_id = $2`, now.AddDate(-1, 0, 0), f)
	if _, err := e.jobs(now).PruneRevisions(context.Background()); err != nil {
		t.Fatal(err)
	}
	var cur int
	if err := e.db.Pool.QueryRow(ctxBg(), `SELECT count(*) FROM file_revisions WHERE file_id=$1`, f).Scan(&cur); err != nil || cur != 1 {
		t.Fatalf("revisions left: %d (%v)", cur, err)
	}
}

func TestChangelogCompactionExpiresOldCursors(t *testing.T) {
	e := newEnv(t)
	ada := e.user("ada")
	v := ada.createVault("Compaction", "shared")
	h := ada.putBlob(v, []byte("x"))
	for i := 0; i < 3; i++ {
		mustAccepted(t, ada.commit(v, create(newID(), "f"+string(rune('a'+i))+".md", h))[0])
	}
	e.exec(`UPDATE file_revisions SET server_time = now() - interval '100 days' WHERE vault_id = $1 AND seq <= 2`, v)
	if err := e.jobs(time.Now()).CompactChangelogs(context.Background()); err != nil {
		t.Fatal(err)
	}
	// A client at cursor 0 is behind the window: it must bootstrap.
	resp := ada.json(http.MethodGet, "/vaults/"+v+"/changes?since=0", nil)
	expect(t, resp, http.StatusGone)
	if p := decode[syncproto.Problem](t, resp); p.Code != syncproto.CodeCursorExpired {
		t.Fatalf("code %s", p.Code)
	}
	// A client at the compaction point (or later) continues normally.
	items, _, _ := ada.changes(v, 2)
	if len(items) != 1 {
		t.Fatalf("items after compaction point: %d", len(items))
	}
	// Bootstrap path: the manifest and then changes since as_of_seq.
	tree, asOf := ada.tree(v)
	if len(tree) != 3 || asOf != 3 {
		t.Fatalf("tree %d as_of %d", len(tree), asOf)
	}
}

func TestPurgeDeletedVaultsReleasesQuotaAndBlobs(t *testing.T) {
	e := newEnv(t)
	ada := e.user("ada")
	v := ada.createVault("Doomed", "shared")
	h := ada.putBlob(v, bytes.Repeat([]byte{'q'}, 1000))
	mustAccepted(t, ada.commit(v, create(newID(), "big.md", h))[0])
	keep := ada.createVault("Keep", "shared")
	hk := ada.putBlob(keep, []byte("kept"))
	mustAccepted(t, ada.commit(keep, create(newID(), "k.md", hk))[0])
	expect(t, ada.json(http.MethodDelete, "/vaults/"+v, nil), http.StatusNoContent)

	// Within the retention period the data is still there (and still counted).
	n, err := e.jobs(time.Now()).PurgeDeletedVaults(context.Background())
	if err != nil || n != 0 {
		t.Fatalf("purged %d too early (%v)", n, err)
	}
	usage := decode[map[string]any](t, ada.json(http.MethodGet, "/me/usage", nil))
	if usage["used_bytes"].(float64) != 1004 {
		t.Fatalf("usage while restorable: %v", usage)
	}
	n, err = e.jobs(time.Now().Add(31 * 24 * time.Hour)).PurgeDeletedVaults(context.Background())
	if err != nil || n < 1 {
		t.Fatalf("purged %d (%v)", n, err)
	}
	usage = decode[map[string]any](t, ada.json(http.MethodGet, "/me/usage", nil))
	if usage["used_bytes"].(float64) != 4 {
		t.Fatalf("usage after purge: %v", usage)
	}
	var refs int
	if err := e.db.Pool.QueryRow(ctxBg(), `SELECT ref_count FROM blobs WHERE hash=$1`, h).Scan(&refs); err != nil || refs != 0 {
		t.Fatalf("purged blob ref_count = %d (%v)", refs, err)
	}
	expect(t, ada.json(http.MethodPost, "/vaults/"+v+":restore", nil), http.StatusNotFound)
}

func TestReconciliationRepairsDrift(t *testing.T) {
	e := newEnv(t)
	ada := e.user("ada")
	v := ada.createVault("Drift", "shared")
	content := []byte("12345" + newID())
	h := ada.putBlob(v, content)
	size := float64(len(content))
	mustAccepted(t, ada.commit(v, create(newID(), "d.md", h))[0])

	e.exec(`UPDATE vaults SET total_bytes = 999, file_count = 7 WHERE id = $1`, v)
	e.exec(`UPDATE users SET used_bytes = 12345 WHERE id = $1`, ada.userID)
	e.exec(`UPDATE blobs SET ref_count = 5 WHERE hash = $1`, h)
	if err := e.jobs(time.Now()).Maintain(context.Background()); err != nil {
		t.Fatal(err)
	}
	vault := decode[map[string]any](t, ada.json(http.MethodGet, "/vaults/"+v, nil))
	if vault["total_bytes"].(float64) != size || vault["file_count"].(float64) != 1 {
		t.Fatalf("vault counters not repaired: %v", vault)
	}
	usage := decode[map[string]any](t, ada.json(http.MethodGet, "/me/usage", nil))
	if usage["used_bytes"].(float64) != size {
		t.Fatalf("user usage not repaired: %v", usage)
	}
	var refs int
	if err := e.db.Pool.QueryRow(ctxBg(), `SELECT ref_count FROM blobs WHERE hash=$1`, h).Scan(&refs); err != nil || refs != 1 {
		t.Fatalf("blob ref_count = %d (%v)", refs, err)
	}
}

func TestExpiredUploadsAreCleanedUp(t *testing.T) {
	e := newEnv(t)
	ada := e.user("ada")
	v := ada.createVault("Uploads", "shared")
	data := bytes.Repeat([]byte{'u'}, 20)
	resp := ada.tusCreate(v, data, hashOf(data))
	loc := resp.Header.Get("Location")
	if r := ada.tusPatch(loc, 0, data[:10]); r.StatusCode != http.StatusNoContent {
		t.Fatalf("patch: %d", r.StatusCode)
	}
	e.exec(`UPDATE uploads SET expires_at = now() - interval '1 minute'`)
	n, err := e.app.Blobs.CleanupExpired(context.Background())
	if err != nil || n < 1 {
		t.Fatalf("cleaned %d (%v)", n, err)
	}
	if r := ada.tus(http.MethodHead, loc, nil, nil); r.StatusCode != http.StatusNotFound {
		t.Fatalf("expired upload still there: %d", r.StatusCode)
	}
}
