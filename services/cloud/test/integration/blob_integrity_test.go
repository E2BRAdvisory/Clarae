//go:build integration

package integration

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"net/http"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"clarae/services/cloud/internal/blobs"
	"clarae/services/cloud/internal/storage"
)

// waitFor polls cond until it holds or the deadline passes.
func waitFor(t *testing.T, what string, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(10 * time.Second)
	for !cond() {
		if time.Now().After(deadline) {
			t.Fatalf("timed out waiting for %s", what)
		}
		time.Sleep(20 * time.Millisecond)
	}
}

// chunkKeysOf reads the chunk objects an upload recorded.
func (e *env) chunkKeysOf(id uuid.UUID) []string {
	e.t.Helper()
	var keys []string
	if err := e.db.Pool.QueryRow(ctxBg(), `SELECT chunk_keys FROM uploads WHERE id = $1`, id).Scan(&keys); err != nil {
		e.t.Fatal(err)
	}
	return keys
}

// objectGone fails unless the object store no longer has key.
func (e *env) objectGone(key, what string) {
	e.t.Helper()
	if _, err := e.app.Store.Size(ctxBg(), key); !errors.Is(err, storage.ErrNotFound) {
		e.t.Fatalf("%s: object %s still there (%v)", what, key, err)
	}
}

// Regression (M12-W1, GC order): the collector deleted the object before
// committing the row delete, so a failed commit left a row without its
// object. Now the object goes after the commit, under the per-hash lock an
// upload publishes the row under: an upload of the same content that
// published the blob again between the two steps keeps its object.
func TestBlobGCKeepsAnObjectPublishedAgainBetweenTheSteps(t *testing.T) {
	e := newEnv(t)
	ada := e.user("ada")
	v := ada.createVault("GC order", "shared")
	data := []byte("collected, then published again " + newID())
	h := ada.putBlob(v, data)
	key := storage.BlobKey(h)
	ctx := context.Background()

	// An upload of the same content, about to publish the row: it holds the lock.
	held, release := make(chan struct{}), make(chan struct{})
	uploadErr := make(chan error, 1)
	go func() {
		uploadErr <- e.db.WithTx(ctx, func(ctx context.Context, tx pgx.Tx) error {
			if _, err := blobs.LockObject(ctx, tx, h); err != nil {
				close(held)
				return err
			}
			close(held)
			<-release
			_, err := tx.Exec(ctx, `INSERT INTO blobs (hash, size, storage_key) VALUES ($1, $2, $3)`, h, len(data), key)
			return err
		})
	}()
	<-held

	gcErr := make(chan error, 1)
	go func() {
		_, err := e.jobs(time.Now().Add(25 * time.Hour)).CollectBlobs(ctx)
		gcErr <- err
	}()
	// The row goes at once; the object waits for the lock.
	waitFor(t, "the row delete", func() bool { return e.count(`SELECT COUNT(*) FROM blobs WHERE hash = $1`, h) == 0 })
	select {
	case err := <-gcErr:
		t.Fatalf("the collector finished while an upload held the blob's lock (%v)", err)
	case <-time.After(300 * time.Millisecond):
	}
	close(release)
	if err := <-uploadErr; err != nil {
		t.Fatal(err)
	}
	if err := <-gcErr; err != nil {
		t.Fatal(err)
	}
	if n, err := e.app.Store.Size(ctx, key); err != nil || n != int64(len(data)) {
		t.Fatalf("the object of the blob published again was deleted: %d %v", n, err)
	}

	// Without a new upload the object goes with the row.
	h2 := ada.putBlob(v, []byte("plain collection "+newID()))
	if _, err := e.jobs(time.Now().Add(25 * time.Hour)).CollectBlobs(ctx); err != nil {
		t.Fatal(err)
	}
	e.objectGone(storage.BlobKey(h2), "collected blob")
}

// Regression (M12-W1): a deduplicated upload trusted a row the collector was
// deleting. It now locks the row under the per-hash lock before linking, and
// when the collector won it publishes the blob again (object first) instead
// of failing on the foreign key or linking a blob without its object.
func TestDeduplicatedUploadRacingTheCollectorPublishesAgain(t *testing.T) {
	e := newEnv(t)
	ada := e.user("ada")
	a, b := ada.createVault("Race A", "shared"), ada.createVault("Race B", "shared")
	data := []byte("deduplicated while collected " + newID())
	h := ada.putBlob(a, data)
	key := storage.BlobKey(h)
	ctx := context.Background()

	// The collector's row delete, not committed yet.
	gc, err := e.db.Pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = gc.Rollback(ctx) }()
	if _, err := gc.Exec(ctx, `DELETE FROM blobs WHERE hash = $1`, h); err != nil {
		t.Fatal(err)
	}
	status := make(chan int, 1)
	go func() {
		r := ada.raw(http.MethodPut, "/vaults/"+b+"/blobs/"+h, "application/octet-stream", data, nil)
		_ = r.Body.Close()
		status <- r.StatusCode
	}()
	// The upload found the row and the object, and waits for the row lock.
	waitFor(t, "the upload to wait for the blob row", func() bool {
		return e.count(`SELECT COUNT(*) FROM pg_stat_activity
			WHERE datname = current_database() AND wait_event_type = 'Lock' AND query LIKE '%FOR KEY SHARE%'`) > 0
	})
	// The collector's object delete, then its commit.
	if err := e.app.Store.Delete(ctx, key); err != nil {
		t.Fatal(err)
	}
	if err := gc.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	if s := <-status; s != http.StatusNoContent {
		t.Fatalf("upload racing the collector: %d", s)
	}
	if n, err := e.app.Store.Size(ctx, key); err != nil || n != int64(len(data)) {
		t.Fatalf("the blob row is back without its object: %d %v", n, err)
	}
	if n := e.count(`SELECT COUNT(*) FROM vault_blobs WHERE vault_id = $1 AND hash = $2`, b, h); n != 1 {
		t.Fatal("the vault of the upload is not linked to the blob")
	}
	mustAccepted(t, ada.commit(b, create(newID(), "raced.bin", h))[0])
	expect(t, ada.json(http.MethodGet, "/vaults/"+b+"/blobs/"+h, nil), http.StatusOK)
}

// Regression (M12-W1): a blob the collector failed on stopped every run at
// the same place (oldest first). It is now skipped and reported.
func TestBlobGCSkipsABlobItCannotCollect(t *testing.T) {
	e := newEnv(t)
	ada := e.user("ada")
	v := ada.createVault("GC skip", "shared")
	stuck := ada.putBlob(v, []byte("referenced, counted as unreferenced "+newID()))
	mustAccepted(t, ada.commit(v, create(newID(), "stuck.md", stuck))[0])
	// A drifted ref count: the oldest candidate, whose delete violates the
	// revisions' foreign key at every run.
	e.exec(`UPDATE blobs SET ref_count = 0, unreferenced_since = now() - interval '48 hours' WHERE hash = $1`, stuck)
	t.Cleanup(func() { e.exec(`UPDATE blobs SET ref_count = 1, unreferenced_since = NULL WHERE hash = $1`, stuck) })

	for run := range 2 {
		orphan := ada.putBlob(v, []byte(fmt.Sprintf("orphan %d %s", run, newID())))
		_, err := e.jobs(time.Now().Add(25 * time.Hour)).CollectBlobs(context.Background())
		if err == nil {
			t.Fatalf("run %d: the failure was not reported", run)
		}
		if n := e.count(`SELECT COUNT(*) FROM blobs WHERE hash = $1`, orphan); n != 0 {
			t.Fatalf("run %d: the blob behind the failing one was not collected (%v)", run, err)
		}
		e.objectGone(storage.BlobKey(orphan), "orphan")
		if n := e.count(`SELECT COUNT(*) FROM blobs WHERE hash = $1`, stuck); n != 1 {
			t.Fatalf("run %d: the referenced blob was deleted", run)
		}
	}
	expect(t, ada.json(http.MethodGet, "/vaults/"+v+"/blobs/"+stuck, nil), http.StatusOK)
}

// Regression (M12-W1): a deduplicated upload linked a blob near the end of
// its grace period without renewing it, so the collector took it right after.
func TestDeduplicatedUploadRenewsTheGracePeriod(t *testing.T) {
	e := newEnv(t)
	ada := e.user("ada")
	a, b := ada.createVault("Dedup A", "shared"), ada.createVault("Dedup B", "shared")
	data := []byte("deduplicated near the end of its grace " + newID())
	h := ada.putBlob(a, data)
	e.exec(`UPDATE blobs SET unreferenced_since = now() - interval '23 hours' WHERE hash = $1`, h)
	ada.putBlob(b, data) // deduplicated: nothing is written, the vault is linked

	// Two hours on, the first upload is past the 24 h grace, the second is not.
	if _, err := e.jobs(time.Now().Add(2 * time.Hour)).CollectBlobs(context.Background()); err != nil {
		t.Fatal(err)
	}
	if n := e.count(`SELECT COUNT(*) FROM blobs WHERE hash = $1`, h); n != 1 {
		t.Fatal("the blob just linked to a vault was collected")
	}
	mustAccepted(t, ada.commit(b, create(newID(), "dedup.bin", h))[0])
	expect(t, ada.json(http.MethodGet, "/vaults/"+b+"/blobs/"+h, nil), http.StatusOK)
}

// Regression (M12-W1): an upload created before chunk_keys (migration 0009)
// and resumed after the upgrade lost its numbered chunks: the finalization
// told the client to start again and left them in the store.
func TestTusLegacyUploadResumedAfterUpgrade(t *testing.T) {
	e := newEnv(t)
	ada := e.user("ada")
	v := ada.createVault("Legacy tus", "shared")
	ctx := context.Background()
	data := bytes.Repeat([]byte("0123456789"), 10)
	r := ada.tusCreate(v, data, hashOf(data))
	expect(t, r, http.StatusCreated)
	loc := r.Header.Get("Location")
	id := uploadID(t, loc)

	// The first 40 bytes arrived before the upgrade: a numbered chunk that
	// chunks counts and chunk_keys does not list.
	legacy := fmt.Sprintf("uploads/%s/%08d", id, 0)
	if err := e.app.Store.Put(ctx, legacy, bytes.NewReader(data[:40]), 40); err != nil {
		t.Fatal(err)
	}
	e.exec(`UPDATE uploads SET received = 40, chunks = 1, chunk_keys = '{}' WHERE id = $1`, id)

	if r := ada.tusPatch(loc, 40, data[40:70]); r.StatusCode != http.StatusNoContent || r.Header.Get("Upload-Offset") != "70" {
		t.Fatalf("patch after the upgrade: %d %v", r.StatusCode, r.Header)
	}
	if r := ada.tusPatch(loc, 70, data[70:]); r.StatusCode != http.StatusNoContent || r.Header.Get("Upload-Offset") != "100" {
		t.Fatalf("last patch: %d %v", r.StatusCode, r.Header)
	}
	mustAccepted(t, ada.commit(v, create(newID(), "legacy.bin", hashOf(data)))[0])
	e.objectGone(legacy, "legacy chunk of a finished upload")
}

// Regression (M12-W1): two finalizations of the same upload (a HEAD while the
// PATCH that completed it still assembles) both read every chunk, and the
// second told the client to start again. The finalization is now claimed:
// the second request waits and reports the outcome of the first.
func TestTusConcurrentFinalizationIsClaimed(t *testing.T) {
	e := newEnv(t)
	ada := e.user("ada")
	v := ada.createVault("Tus claim", "shared")
	ctx := context.Background()

	// complete builds an upload whose every byte arrived and whose finalization did not run.
	complete := func(data []byte) (string, uuid.UUID) {
		t.Helper()
		r := ada.tusCreate(v, data, hashOf(data))
		expect(t, r, http.StatusCreated)
		loc := r.Header.Get("Location")
		if r := ada.tusPatch(loc, 0, data[:40]); r.StatusCode != http.StatusNoContent {
			t.Fatalf("patch: %d", r.StatusCode)
		}
		id := uploadID(t, loc)
		key := fmt.Sprintf("uploads/%s/last", id)
		if err := e.app.Store.Put(ctx, key, bytes.NewReader(data[40:]), int64(len(data)-40)); err != nil {
			t.Fatal(err)
		}
		e.exec(`UPDATE uploads SET received = length, chunks = chunks + 1, chunk_keys = array_append(chunk_keys, $2) WHERE id = $1`, id, key)
		return loc, id
	}
	head := func(loc string) <-chan *http.Response {
		out := make(chan *http.Response, 1)
		go func() { out <- ada.tus(http.MethodHead, loc, nil, nil) }()
		return out
	}
	stillWaiting := func(res <-chan *http.Response) {
		t.Helper()
		select {
		case r := <-res:
			t.Fatalf("answered while another request held the finalization: %d", r.StatusCode)
		case <-time.After(500 * time.Millisecond):
		}
	}
	answer := func(res <-chan *http.Response) *http.Response {
		t.Helper()
		select {
		case r := <-res:
			return r
		case <-time.After(10 * time.Second):
			t.Fatal("no answer once the other finalization ended")
			return nil
		}
	}

	// Another request finalizes and publishes the blob: the waiting HEAD reports completion.
	a := bytes.Repeat([]byte("claimed-a!"), 10)
	loc, id := complete(a)
	e.exec(`UPDATE uploads SET finalizing_until = now() + interval '1 hour' WHERE id = $1`, id)
	res := head(loc)
	stillWaiting(res)
	ada.putBlob(v, a) // what the other finalization does
	if r := answer(res); r.StatusCode != http.StatusOK || r.Header.Get("Upload-Offset") != "100" {
		t.Fatalf("HEAD after the other finalization: %d %v", r.StatusCode, r.Header)
	}
	mustAccepted(t, ada.commit(v, create(newID(), "a.bin", hashOf(a)))[0])

	// The other one fails and discards the upload: the waiting HEAD says start again.
	b := bytes.Repeat([]byte("claimed-b!"), 10)
	loc, id = complete(b)
	e.exec(`UPDATE uploads SET finalizing_until = now() + interval '1 hour' WHERE id = $1`, id)
	res = head(loc)
	stillWaiting(res)
	e.exec(`DELETE FROM uploads WHERE id = $1`, id)
	if r := answer(res); r.StatusCode != http.StatusBadRequest {
		t.Fatalf("HEAD after the other finalization failed: %d", r.StatusCode)
	}

	// The claim of a finalizer that died runs out: the next request takes over.
	c := bytes.Repeat([]byte("claimed-c!"), 10)
	loc, id = complete(c)
	e.exec(`UPDATE uploads SET finalizing_until = now() - interval '1 minute' WHERE id = $1`, id)
	if r := ada.tus(http.MethodHead, loc, nil, nil); r.StatusCode != http.StatusOK || r.Header.Get("Upload-Offset") != "100" {
		t.Fatalf("HEAD after an expired claim: %d %v", r.StatusCode, r.Header)
	}
	mustAccepted(t, ada.commit(v, create(newID(), "c.bin", hashOf(c)))[0])

	// A finalizer that died after publishing the blob and deleting a chunk:
	// the retry finds chunks missing but the blob there, and reports completion.
	d := bytes.Repeat([]byte("claimed-d!"), 10)
	loc, id = complete(d)
	keys := e.chunkKeysOf(id)
	ada.putBlob(v, d)
	if err := e.app.Store.Delete(ctx, keys[0]); err != nil {
		t.Fatal(err)
	}
	if r := ada.tus(http.MethodHead, loc, nil, nil); r.StatusCode != http.StatusOK || r.Header.Get("Upload-Offset") != "100" {
		t.Fatalf("HEAD with chunks gone and the blob published: %d %v", r.StatusCode, r.Header)
	}
	if r := ada.tus(http.MethodHead, loc, nil, nil); r.StatusCode != http.StatusNotFound {
		t.Fatalf("the completed upload is still there: %d", r.StatusCode)
	}
	for _, k := range keys {
		e.objectGone(k, "chunk of a completed upload")
	}
}

// Regression (M12-W1): deleting an account deleted the rows of its uploads
// but not their chunks, which stayed in the store for ever.
func TestDeletedAccountLeavesNoUploadChunks(t *testing.T) {
	e := newEnv(t)
	gone := e.user("chunks-del")
	v := gone.createVault("Half uploaded", "shared")
	data := bytes.Repeat([]byte{'p'}, 30)
	r := gone.tusCreate(v, data, hashOf(data))
	expect(t, r, http.StatusCreated)
	loc := r.Header.Get("Location")
	if r := gone.tusPatch(loc, 0, data[:10]); r.StatusCode != http.StatusNoContent {
		t.Fatalf("patch: %d", r.StatusCode)
	}
	id := uploadID(t, loc)
	keys := e.chunkKeysOf(id)

	expect(t, gone.json(http.MethodDelete, "/me", map[string]any{"confirm": "chunks-del"}), http.StatusNoContent)
	if err := e.jobs(time.Now()).CleanupUploads(context.Background()); err != nil {
		t.Fatal(err)
	}
	if n := e.count(`SELECT COUNT(*) FROM uploads WHERE id = $1`, id); n != 0 {
		t.Fatal("the upload of the deleted account survived the uploads job")
	}
	for _, k := range keys {
		e.objectGone(k, "chunk of a deleted account")
	}
}

// Regression (M12-W1): purging a vault deleted its uploads by cascade and
// left their chunks in the store.
func TestVaultPurgeDeletesUploadChunks(t *testing.T) {
	e := newEnv(t)
	ada := e.user("ada")
	v := ada.createVault("Purged with an upload", "shared")
	data := bytes.Repeat([]byte{'q'}, 30)
	r := ada.tusCreate(v, data, hashOf(data))
	expect(t, r, http.StatusCreated)
	loc := r.Header.Get("Location")
	if r := ada.tusPatch(loc, 0, data[:10]); r.StatusCode != http.StatusNoContent {
		t.Fatalf("patch: %d", r.StatusCode)
	}
	keys := e.chunkKeysOf(uploadID(t, loc))

	expect(t, ada.json(http.MethodDelete, "/vaults/"+v, nil), http.StatusNoContent)
	if _, err := e.jobs(time.Now().Add(31 * 24 * time.Hour)).PurgeDeletedVaults(context.Background()); err != nil {
		t.Fatal(err)
	}
	if n := e.count(`SELECT COUNT(*) FROM vaults WHERE id = $1`, v); n != 0 {
		t.Fatal("the vault was not purged")
	}
	for _, k := range keys {
		e.objectGone(k, "chunk of a purged vault")
	}
}

// The sweep removes chunk objects that no upload accounts for, once they are
// older than the upload expiry, and nothing else.
func TestOrphanUploadChunksAreSwept(t *testing.T) {
	e := newEnv(t)
	ada := e.user("ada")
	v := ada.createVault("Sweep", "shared")
	ctx := context.Background()
	put := func(key string) {
		t.Helper()
		if err := e.app.Store.Put(ctx, key, bytes.NewReader([]byte{1}), 1); err != nil {
			t.Fatal(err)
		}
	}
	orphan := "uploads/" + uuid.NewString() + "/chunk"
	foreign := "uploads/not-an-upload/x"
	put(orphan)
	put(foreign)
	data := bytes.Repeat([]byte{'s'}, 30)
	r := ada.tusCreate(v, data, hashOf(data))
	expect(t, r, http.StatusCreated)
	loc := r.Header.Get("Location")
	if r := ada.tusPatch(loc, 0, data[:10]); r.StatusCode != http.StatusNoContent {
		t.Fatalf("patch: %d", r.StatusCode)
	}
	live := e.chunkKeysOf(uploadID(t, loc))

	// Too recent: a PATCH may still be confirming it.
	if n, err := e.app.Blobs.SweepOrphanChunks(ctx, time.Now()); err != nil || n != 0 {
		t.Fatalf("swept %d recent objects (%v)", n, err)
	}
	if n, err := e.app.Blobs.SweepOrphanChunks(ctx, time.Now().Add(25*time.Hour)); err != nil || n != 1 {
		t.Fatalf("swept %d objects, want the orphan only (%v)", n, err)
	}
	e.objectGone(orphan, "orphan chunk")
	for _, k := range append(live, foreign) {
		if _, err := e.app.Store.Size(ctx, k); err != nil {
			t.Fatalf("%s was swept: %v", k, err)
		}
	}
}
