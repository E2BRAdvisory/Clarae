//go:build integration

package integration

import (
	"bytes"
	"context"
	"fmt"
	"io"
	"net/http"
	"path"
	"testing"
	"time"

	"github.com/google/uuid"
)

// uniq returns n bytes no other test uploads: blobs are deduplicated across
// vaults, and a blob another test committed is referenced, hence not pending.
func uniq(c byte, n int) []byte {
	b := bytes.Repeat([]byte{c}, n)
	copy(b, uuid.NewString()[:min(n, 36)])
	return b
}

func (e *env) setQuota(c *client, n int64) {
	e.t.Helper()
	if _, err := e.db.Pool.Exec(context.Background(), `UPDATE users SET quota_bytes_override = $2 WHERE id = $1`, c.userID, n); err != nil {
		e.t.Fatal(err)
	}
}

func (c *client) putProblem(vault string, data []byte) (int, string) {
	c.e.t.Helper()
	resp := c.raw(http.MethodPut, "/vaults/"+vault+"/blobs/"+hashOf(data), "application/octet-stream", data, nil)
	if resp.StatusCode == http.StatusNoContent {
		return resp.StatusCode, ""
	}
	return resp.StatusCode, string(respProblem(c.e.t, resp).Code)
}

// unquoted-blob-uploads: uploaded but uncommitted bytes count against the
// owner's quota (D-03 still charges only committed files), so uploads cannot
// be used as free storage; a commit releases the pending bytes into used_bytes.
func TestUploadQuotaCountsPendingBytes(t *testing.T) {
	e := newEnv(t)
	ada, bob := e.user("ada"), e.user("bob")
	v := ada.createVault("Q", "shared")
	e.setQuota(ada, 100)

	// An upload that alone exceeds the quota is refused before reaching the store.
	if st, code := ada.putProblem(v, uniq('x', 101)); st != http.StatusRequestEntityTooLarge || code != "QUOTA_EXCEEDED" {
		t.Fatalf("too large alone: %d %s", st, code)
	}
	a40 := uniq('a', 40)
	h40 := ada.putBlob(v, a40)
	h50 := ada.putBlob(v, uniq('b', 50))
	// 40 + 50 pending: 20 more do not fit, 10 do.
	if _, code := ada.putProblem(v, uniq('c', 20)); code != "QUOTA_EXCEEDED" {
		t.Fatalf("pending bytes not counted: %s", code)
	}
	h10 := ada.putBlob(v, uniq('d', 10))
	// Uploading a blob the vault already holds adds nothing.
	ada.putBlob(v, a40)

	// Committing moves pending bytes to used_bytes: nothing frees up, nothing is counted twice.
	mustAccepted(t, ada.commit(v, create(newID(), "a.md", h40))[0])
	usage := decode[map[string]any](t, ada.json(http.MethodGet, "/me/usage", nil))
	if usage["used_bytes"].(float64) != 40 {
		t.Fatalf("usage: %v", usage)
	}
	if _, code := ada.putProblem(v, []byte("e")); code != "QUOTA_EXCEEDED" {
		t.Fatalf("40 used + 60 pending = full: %s", code)
	}
	for _, r := range ada.commit(v, create(newID(), "b.md", h50), create(newID(), "d.md", h10)) {
		mustAccepted(t, r)
	}

	// A share recipient with editor rights uploads into the owner's quota.
	sh := ada.share(v, "vault", "", grantTo("user", bob.userID, "editor"))
	bob.accept(sh.id())
	e.setQuota(ada, 120)
	f30 := uniq('f', 30)
	if resp := bob.raw(http.MethodPut, "/vaults/"+v+"/blobs/"+hashOf(f30)+"?scope=share:"+sh.id(), "application/octet-stream", f30, nil); resp.StatusCode != http.StatusRequestEntityTooLarge || respProblem(t, resp).Code != "QUOTA_EXCEEDED" {
		t.Fatalf("recipient upload over the owner's quota: %d", resp.StatusCode)
	}
	bob.scopedPut(t, v, sh.id(), uniq('g', 20))
}

// Pending bytes stop counting when the uploads window (uploads.expiry_hours)
// ends: the garbage collector owns the blob from then on.
func TestPendingUploadsExpireWithTheUploadWindow(t *testing.T) {
	e := newEnv(t)
	ada := e.user("ada")
	v := ada.createVault("Q", "shared")
	e.setQuota(ada, 100)
	ada.putBlob(v, uniq('a', 90))
	if _, code := ada.putProblem(v, uniq('b', 20)); code != "QUOTA_EXCEEDED" {
		t.Fatalf("pending: %s", code)
	}
	if _, err := e.db.Pool.Exec(context.Background(), `UPDATE vault_blobs SET created_at = now() - interval '25 hours' WHERE vault_id = $1`, v); err != nil {
		t.Fatal(err)
	}
	ada.putBlob(v, uniq('b', 20))
}

func uploadID(t *testing.T, loc string) uuid.UUID {
	t.Helper()
	id, err := uuid.Parse(path.Base(loc))
	if err != nil {
		t.Fatalf("location %q: %v", loc, err)
	}
	return id
}

// A resumable upload reserves its announced length at creation.
func TestTusUploadQuota(t *testing.T) {
	e := newEnv(t)
	ada := e.user("ada")
	v := ada.createVault("Big", "shared")
	e.setQuota(ada, 100)
	data := uniq('0', 60)

	x101 := uniq('x', 101)
	if r := ada.tusCreate(v, x101, hashOf(x101)); r.StatusCode != http.StatusRequestEntityTooLarge || respProblem(t, r).Code != "QUOTA_EXCEEDED" {
		t.Fatalf("create over the quota: %d", r.StatusCode)
	}
	r := ada.tusCreate(v, data, hashOf(data))
	expect(t, r, http.StatusCreated)
	loc := r.Header.Get("Location")
	// The 60 announced bytes are reserved: another 60 do not fit, neither as tus nor as PUT.
	other := uniq('1', 60)
	if r := ada.tusCreate(v, other, hashOf(other)); r.StatusCode != http.StatusRequestEntityTooLarge {
		t.Fatalf("second create: %d", r.StatusCode)
	}
	if _, code := ada.putProblem(v, other); code != "QUOTA_EXCEEDED" {
		t.Fatalf("PUT next to a reservation: %s", code)
	}
	// Completing the upload turns the reservation into a pending blob (not counted twice).
	if r := ada.tusPatch(loc, 0, data); r.StatusCode != http.StatusNoContent {
		b, _ := io.ReadAll(r.Body)
		t.Fatalf("patch: %d %s", r.StatusCode, b)
	}
	mustAccepted(t, ada.commit(v, create(newID(), "big.bin", hashOf(data)))[0])
	ada.putBlob(v, uniq('z', 40))
}

// tus-patch-holds-tx: a slow PATCH holds no transaction or row lock while its
// body streams in, so a concurrent PATCH of the same upload is answered at
// once, and the loser of the race is told the new offset.
func TestTusPatchHoldsNoLockWhileStreaming(t *testing.T) {
	e := newEnv(t)
	ada := e.user("ada")
	v := ada.createVault("Big", "shared")
	data := bytes.Repeat([]byte("0123456789"), 10)
	r := ada.tusCreate(v, data, hashOf(data))
	expect(t, r, http.StatusCreated)
	loc := e.server.URL + r.Header.Get("Location")

	pr, pw := io.Pipe()
	slow, err := http.NewRequestWithContext(context.Background(), http.MethodPatch, loc, pr)
	if err != nil {
		t.Fatal(err)
	}
	slow.ContentLength = 40
	slow.Header.Set("Authorization", "Bearer "+ada.token)
	slow.Header.Set("Tus-Resumable", "1.0.0")
	slow.Header.Set("Upload-Offset", "0")
	slow.Header.Set("Content-Type", "application/offset+octet-stream")
	slowDone := make(chan int, 1)
	go func() {
		resp, err := http.DefaultClient.Do(slow)
		if err != nil {
			slowDone <- 0
			return
		}
		_ = resp.Body.Close()
		slowDone <- resp.StatusCode
	}()
	if _, err := pw.Write(data[:10]); err != nil { // the slow client sent a quarter of its chunk
		t.Fatal(err)
	}

	start := time.Now()
	if r := ada.tusPatch(loc, 0, data[:60]); r.StatusCode != http.StatusNoContent || r.Header.Get("Upload-Offset") != "60" {
		t.Fatalf("concurrent patch: %d %v", r.StatusCode, r.Header)
	}
	if d := time.Since(start); d > 5*time.Second {
		t.Fatalf("the concurrent PATCH waited %v for the slow one", d)
	}
	// The slow client finishes: its offset is stale now, it is told the server offset.
	if _, err := pw.Write(data[10:40]); err != nil {
		t.Fatal(err)
	}
	_ = pw.Close()
	if st := <-slowDone; st != http.StatusBadRequest {
		t.Fatalf("stale PATCH: %d", st)
	}
	if r := ada.tusPatch(loc, 60, data[60:]); r.StatusCode != http.StatusNoContent {
		t.Fatalf("last patch: %d", r.StatusCode)
	}
	mustAccepted(t, ada.commit(v, create(newID(), "big.bin", hashOf(data)))[0])
}

// A finalization that did not run (worker died, client gave up) leaves the
// upload with every byte received; a HEAD, or an empty PATCH at the final
// offset, publishes the blob instead of reporting a completion that the
// commit would then answer with BLOB_MISSING.
func TestTusFinalizationIsRetried(t *testing.T) {
	e := newEnv(t)
	ada := e.user("ada")
	v := ada.createVault("Big", "shared")
	ctx := context.Background()

	stuck := func(data []byte) string {
		t.Helper()
		r := ada.tusCreate(v, data, hashOf(data))
		expect(t, r, http.StatusCreated)
		loc := r.Header.Get("Location")
		if r := ada.tusPatch(loc, 0, data[:40]); r.StatusCode != http.StatusNoContent {
			t.Fatalf("patch: %d", r.StatusCode)
		}
		// The last chunk was stored and confirmed, then the process stopped.
		id := uploadID(t, loc)
		key := fmt.Sprintf("uploads/%s/last", id)
		if err := e.app.Store.Put(ctx, key, bytes.NewReader(data[40:]), int64(len(data)-40)); err != nil {
			t.Fatal(err)
		}
		if _, err := e.db.Pool.Exec(ctx, `UPDATE uploads SET received = length, chunks = chunks + 1, chunk_keys = array_append(chunk_keys, $2) WHERE id = $1`, id, key); err != nil {
			t.Fatal(err)
		}
		if res := ada.commit(v, create(newID(), "early-"+id.String()+".bin", hashOf(data))); res[0].code() != "BLOB_MISSING" {
			t.Fatalf("before finalization: %v", res[0])
		}
		return loc
	}

	a := bytes.Repeat([]byte("0123456789"), 10)
	loc := stuck(a)
	r := ada.tus(http.MethodHead, loc, nil, nil)
	if r.StatusCode != http.StatusOK || r.Header.Get("Upload-Offset") != "100" {
		t.Fatalf("HEAD: %d %v", r.StatusCode, r.Header)
	}
	mustAccepted(t, ada.commit(v, create(newID(), "a.bin", hashOf(a)))[0])
	if r := ada.tus(http.MethodHead, loc, nil, nil); r.StatusCode != http.StatusNotFound {
		t.Fatalf("the finalized upload is gone: %d", r.StatusCode)
	}

	b := bytes.Repeat([]byte("abcdefghij"), 10)
	loc = stuck(b)
	if r := ada.tusPatch(loc, 100, nil); r.StatusCode != http.StatusNoContent || r.Header.Get("Upload-Offset") != "100" {
		t.Fatalf("empty PATCH: %d %v", r.StatusCode, r.Header)
	}
	mustAccepted(t, ada.commit(v, create(newID(), "b.bin", hashOf(b)))[0])

	// A corrupted upload (a chunk missing) is discarded, not retried forever.
	c := bytes.Repeat([]byte("ABCDEFGHIJ"), 10)
	r = ada.tusCreate(v, c, hashOf(c))
	expect(t, r, http.StatusCreated)
	loc = r.Header.Get("Location")
	if _, err := e.db.Pool.Exec(ctx, `UPDATE uploads SET received = length, chunks = 1 WHERE id = $1`, uploadID(t, loc)); err != nil {
		t.Fatal(err)
	}
	if r := ada.tus(http.MethodHead, loc, nil, nil); r.StatusCode != http.StatusBadRequest {
		t.Fatalf("corrupted upload: %d", r.StatusCode)
	}
	if r := ada.tus(http.MethodHead, loc, nil, nil); r.StatusCode != http.StatusNotFound {
		t.Fatalf("discarded upload: %d", r.StatusCode)
	}
}
