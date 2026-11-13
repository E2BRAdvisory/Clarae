//go:build integration

package integration

// Fault injection for the cloud service (M7-WP2b, Appendice A "Affidabilita dati"
// and "Disponibilita"). Every test asserts that the fault was really injected
// before it checks the outcome. The cloud runs as a real process (the
// clarae-cloud binary) against the shared PostgreSQL container, except for the
// restart test, which owns a disposable database.

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"clarae/services/cloud/internal/auth/authtest"
)

const chaosBatch = 40 // ops per commit in the kill tests (limit is 50)

// chaosOps builds one commit batch; the op at sleeperAt creates the file the
// injected trigger blocks on, i.e. the middle of the transaction.
func chaosOps(p *cloudProc, u procUser, vault string, sleeperAt int) []map[string]any {
	ops := make([]map[string]any, 0, chaosBatch)
	for i := 0; i < chaosBatch; i++ {
		data := []byte(fmt.Sprintf("chaos file %d %s", i, newID()))
		h := p.putBlob(u, vault, data)
		path := fmt.Sprintf("chaos/f%02d.md", i)
		if i == sleeperAt {
			path = "chaos/sleeper.md"
		}
		ops = append(ops, create(newID(), path, h))
	}
	return ops
}

type vaultCounts struct {
	files, revisions, fileCount, lastSeq int64
}

func countsOf(t *testing.T, pool querier, vault string) vaultCounts {
	t.Helper()
	var c vaultCounts
	err := pool.QueryRow(context.Background(), `SELECT
		(SELECT count(*) FROM files WHERE vault_id = $1),
		(SELECT count(*) FROM file_revisions WHERE vault_id = $1),
		file_count, last_seq FROM vaults WHERE id = $1`, vault).Scan(&c.files, &c.revisions, &c.fileCount, &c.lastSeq)
	if err != nil {
		t.Fatal(err)
	}
	return c
}

func waitNoSleepers(t *testing.T, pool querier) {
	t.Helper()
	deadline := time.Now().Add(30 * time.Second)
	for time.Now().Before(deadline) {
		var n int
		if err := pool.QueryRow(context.Background(), `SELECT count(*) FROM pg_stat_activity WHERE wait_event = 'PgSleep' AND pid <> pg_backend_pid()`).Scan(&n); err == nil && n == 0 {
			return
		}
		time.Sleep(50 * time.Millisecond)
	}
	t.Fatal("a backend is still sleeping")
}

// assertAllOrNothingAndIdempotentRetry is the common tail of the kill tests:
// the interrupted batch left nothing behind, and retrying the SAME op_ids
// applies it exactly once.
func assertAllOrNothingAndIdempotentRetry(t *testing.T, p *cloudProc, u procUser, vault string, ops []map[string]any, before vaultCounts, pool querier) {
	t.Helper()
	after := countsOf(t, pool, vault)
	if after != before {
		t.Fatalf("interrupted commit left partial state: before %+v after %+v", before, after)
	}
	// Retry with the same op_ids (the client never saw an answer).
	first := p.commit(u, vault, ops)
	if first.status != http.StatusOK || len(first.results) != chaosBatch {
		t.Fatalf("retry: %d %s", first.status, first.body)
	}
	seen := map[int64]bool{}
	for i, r := range first.results {
		mustAccepted(t, r)
		if seen[r.seq()] {
			t.Fatalf("duplicate seq %d", r.seq())
		}
		seen[r.seq()] = true
		if r["op_id"] != ops[i]["op_id"] {
			t.Fatalf("result %d does not answer op %v", i, ops[i]["op_id"])
		}
	}
	for s := before.lastSeq + 1; s <= before.lastSeq+chaosBatch; s++ {
		if !seen[s] {
			t.Fatalf("seq %d missing: seqs are not contiguous", s)
		}
	}
	// And once more: the answer must be the same, nothing new is written.
	second := p.commit(u, vault, ops)
	if second.status != http.StatusOK {
		t.Fatalf("second retry: %d %s", second.status, second.body)
	}
	for i := range second.results {
		if second.results[i].seq() != first.results[i].seq() || second.results[i].rev() != first.results[i].rev() || second.results[i].status() != "accepted" {
			t.Fatalf("replay differs for op %d: %v vs %v", i, second.results[i], first.results[i])
		}
	}
	end := countsOf(t, pool, vault)
	if end.files != before.files+chaosBatch || end.revisions != before.revisions+chaosBatch || end.lastSeq != before.lastSeq+chaosBatch || end.fileCount != before.fileCount+chaosBatch {
		t.Fatalf("after retries: %+v (before %+v): duplicates or gaps", end, before)
	}
	items := p.changesAll(u, vault)
	if len(items) != int(end.lastSeq) {
		t.Fatalf("changelog has %d entries, last_seq %d", len(items), end.lastSeq)
	}
	for i, it := range items {
		if int64(it["seq"].(float64)) != int64(i+1) {
			t.Fatalf("changelog seq %v at position %d", it["seq"], i)
		}
	}
}

func setupKillTest(t *testing.T) (*authtest.Issuer, procUser, string, *cloudProc, *pgxpool.Pool, string) {
	t.Helper()
	iss := authtest.New(t)
	storeDir := t.TempDir()
	p := startCloud(t, iss.URL(), databaseURL, storeDir)
	u := p.user(iss, "chaos")
	vault := p.createVault(u, "chaos-"+newID()[24:])
	pool := rawDB(t, databaseURL)
	return iss, u, vault, p, pool, storeDir
}

// SIGKILL of the cloud process while a 40-operation batch is inside its
// transaction (blocked in pg_sleep by the injected trigger).
func TestCommitSIGKILLMidTransaction(t *testing.T) {
	iss, u, vault, p, pool, storeDir := setupKillTest(t)
	installSleeper(t, pool, "chaos/sleeper.md", 6*time.Second)
	ops := chaosOps(p, u, vault, 25)
	before := countsOf(t, pool, vault)

	done := make(chan commitOutcome, 1)
	go func() { done <- p.commit(u, vault, ops) }()
	waitSleeping(t, pool) // the transaction holds 25 inserted files and is blocked
	p.kill()
	out := <-done
	if out.status != 0 {
		t.Fatalf("the client got an answer (%d) although the process was killed", out.status)
	}
	waitNoSleepers(t, pool) // the orphaned backend notices the dead socket and aborts
	removeSleeper(pool)

	// A new process (what the orchestrator would start) takes over.
	p2 := startCloud(t, iss.URL(), databaseURL, storeDir)
	assertAllOrNothingAndIdempotentRetry(t, p2, u, vault, ops, before, pool)
}

// The database connection of the commit is terminated (pg_terminate_backend)
// while the transaction is open: the service must answer with a problem and the
// batch must leave no trace.
func TestCommitBackendTerminatedMidTransaction(t *testing.T) {
	_, u, vault, p, pool, _ := setupKillTest(t)
	installSleeper(t, pool, "chaos/sleeper.md", 20*time.Second)
	ops := chaosOps(p, u, vault, 10)
	before := countsOf(t, pool, vault)

	done := make(chan commitOutcome, 1)
	go func() { done <- p.commit(u, vault, ops) }()
	pid := waitSleeping(t, pool)
	var terminated bool
	if err := pool.QueryRow(context.Background(), `SELECT pg_terminate_backend($1)`, pid).Scan(&terminated); err != nil || !terminated {
		t.Fatalf("pg_terminate_backend(%d) = %v, %v: fault not injected", pid, terminated, err)
	}
	out := <-done
	if out.status == http.StatusOK {
		t.Fatalf("commit reported success although its connection was terminated: %s", out.body)
	}
	if out.status < 500 {
		t.Fatalf("infrastructure failure must be a 5xx, got %d %s", out.status, out.body)
	}
	if pr := problemOf(t, out.body); pr["code"] == nil || pr["code"] == "" {
		t.Fatalf("problem document without code: %s", out.body)
	}
	removeSleeper(pool)
	assertAllOrNothingAndIdempotentRetry(t, p, u, vault, ops, before, pool)
}

// The request context is cancelled (client gives up) while the transaction is
// open: same guarantees.
func TestCommitClientAbortMidTransaction(t *testing.T) {
	_, u, vault, p, pool, _ := setupKillTest(t)
	installSleeper(t, pool, "chaos/sleeper.md", 4*time.Second)
	ops := chaosOps(p, u, vault, 30)
	before := countsOf(t, pool, vault)

	ctx, cancel := context.WithCancel(context.Background())
	body, _ := jsonBody(map[string]any{"device_id": u.deviceID, "ops": ops})
	req, _ := http.NewRequestWithContext(ctx, http.MethodPost, p.baseURL+"/vaults/"+vault+"/commit", bytes.NewReader(body))
	req.Header.Set("Authorization", "Bearer "+u.token)
	req.Header.Set("Content-Type", "application/json")
	errc := make(chan error, 1)
	go func() {
		resp, err := plainHTTP.Do(req)
		if err == nil {
			_ = resp.Body.Close()
		}
		errc <- err
	}()
	waitSleeping(t, pool)
	cancel()
	if err := <-errc; err == nil {
		t.Fatal("request was not aborted")
	}
	waitNoSleepers(t, pool)
	removeSleeper(pool)
	// Whatever the server did with the cancelled context, it is all or nothing.
	got := countsOf(t, pool, vault)
	switch {
	case got == before:
		assertAllOrNothingAndIdempotentRetry(t, p, u, vault, ops, before, pool)
	case got.revisions == before.revisions+chaosBatch && got.files == before.files+chaosBatch:
		// The batch committed before the cancellation took effect: replaying must be a no-op.
		out := p.commit(u, vault, ops)
		if out.status != http.StatusOK {
			t.Fatalf("replay: %d %s", out.status, out.body)
		}
		if after := countsOf(t, pool, vault); after != got {
			t.Fatalf("replay of an applied batch changed state: %+v -> %+v", got, after)
		}
	default:
		t.Fatalf("partial batch after client abort: before %+v after %+v", before, got)
	}
}

// A blob upload whose connection is cut halfway is not published; retrying
// completes it.
func TestBlobUploadInterruptedThenRetried(t *testing.T) {
	iss := authtest.New(t)
	p := startCloud(t, iss.URL(), databaseURL, t.TempDir())
	u := p.user(iss, "blobchaos")
	vault := p.createVault(u, "blobs-"+newID()[24:])
	data := bytes.Repeat([]byte("0123456789abcdef"), 64<<10) // 1 MiB
	h := hashOf(data)

	proxy := newCutProxy(t, strings.TrimPrefix(p.root, "http://"))
	proxy.cutAfter.Store(300 << 10) // cut after 300 KiB, well inside the body
	req, _ := http.NewRequest(http.MethodPut, "http://"+proxy.Addr+"/api/v1/vaults/"+vault+"/blobs/"+h, bytes.NewReader(data))
	req.Header.Set("Authorization", "Bearer "+u.token)
	req.Header.Set("Content-Type", "application/octet-stream")
	resp, err := plainHTTP.Do(req)
	if err == nil {
		_ = resp.Body.Close()
		t.Fatalf("upload unexpectedly completed with %d", resp.StatusCode)
	}
	if proxy.Cuts.Load() != 1 {
		t.Fatal("the connection was not cut: fault not injected")
	}
	missing := p.missingBlobs(t, u, vault, h)
	if len(missing) != 1 {
		t.Fatal("a half-received blob is visible to blobs:check")
	}
	var n int
	_ = rawDB(t, databaseURL).QueryRow(context.Background(), `SELECT count(*) FROM blobs WHERE hash = $1`, h).Scan(&n)
	if n != 0 {
		t.Fatal("a blob row exists for the interrupted upload")
	}
	// Retry on a healthy connection.
	if got := p.putBlob(u, vault, data); got != h {
		t.Fatal("hash")
	}
	if len(p.missingBlobs(t, u, vault, h)) != 0 {
		t.Fatal("blob missing after the retry")
	}
	out := p.commit(u, vault, []map[string]any{create(newID(), "big.bin", h)})
	if out.status != http.StatusOK {
		t.Fatalf("commit: %d %s", out.status, out.body)
	}
	mustAccepted(t, out.results[0])
}

func (p *cloudProc) missingBlobs(t *testing.T, u procUser, vault string, hashes ...string) []string {
	t.Helper()
	st, b := p.call(http.MethodPost, "/vaults/"+vault+"/blobs:check", u.token, map[string]any{"hashes": hashes})
	if st != http.StatusOK {
		t.Fatalf("blobs:check: %d %s", st, b)
	}
	var r struct{ Missing []string }
	if err := jsonUnmarshal(b, &r); err != nil {
		t.Fatal(err)
	}
	return r.Missing
}

func tusDo(t *testing.T, addr, token, method, path string, headers map[string]string, body []byte) (*http.Response, error) {
	t.Helper()
	req, err := http.NewRequest(method, "http://"+addr+path, bytes.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Tus-Resumable", "1.0.0")
	for k, v := range headers {
		req.Header.Set(k, v)
	}
	return plainHTTP.Do(req)
}

func tusCreateAt(t *testing.T, addr, token, vault string, data []byte) string {
	t.Helper()
	meta := "sha256 " + base64.StdEncoding.EncodeToString([]byte(hashOf(data)))
	resp, err := tusDo(t, addr, token, http.MethodPost, "/api/v1/vaults/"+vault+"/uploads", map[string]string{"Upload-Length": strconv.Itoa(len(data)), "Upload-Metadata": meta}, nil)
	if err != nil {
		t.Fatal(err)
	}
	_ = resp.Body.Close()
	if resp.StatusCode != http.StatusCreated {
		t.Fatalf("tus create: %d", resp.StatusCode)
	}
	return resp.Header.Get("Location")
}

func tusPatchAt(t *testing.T, addr, token, loc string, offset int, chunk []byte) (*http.Response, error) {
	return tusDo(t, addr, token, http.MethodPatch, loc, map[string]string{"Upload-Offset": strconv.Itoa(offset), "Content-Type": "application/offset+octet-stream"}, chunk)
}

func tusOffset(t *testing.T, addr, token, loc string) int {
	t.Helper()
	resp, err := tusDo(t, addr, token, http.MethodHead, loc, nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	_ = resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("tus HEAD: %d", resp.StatusCode)
	}
	n, _ := strconv.Atoi(resp.Header.Get("Upload-Offset"))
	return n
}

// A PATCH cut mid-body is not counted: HEAD reports the last complete offset,
// the upload resumes from it and the published blob matches its digest.
func TestTusInterruptedPatchResumes(t *testing.T) {
	iss := authtest.New(t)
	p := startCloud(t, iss.URL(), databaseURL, t.TempDir())
	u := p.user(iss, "tuschaos")
	vault := p.createVault(u, "tus-"+newID()[24:])
	const chunk = 128 << 10
	data := make([]byte, 3*chunk)
	for i := range data {
		data[i] = byte((i * 31) % 256)
	}
	h := hashOf(data)
	direct := strings.TrimPrefix(p.root, "http://")
	proxy := newCutProxy(t, direct)

	loc := tusCreateAt(t, direct, u.token, vault, data)
	resp, err := tusPatchAt(t, direct, u.token, loc, 0, data[:chunk])
	if err != nil || resp.StatusCode != http.StatusNoContent {
		t.Fatalf("first chunk: %v %v", resp, err)
	}
	_ = resp.Body.Close()

	// Second chunk through the proxy, cut 50 KiB into the body.
	proxy.cutAfter.Store(50 << 10)
	if resp, err := tusPatchAt(t, proxy.Addr, u.token, loc, chunk, data[chunk:2*chunk]); err == nil {
		_ = resp.Body.Close()
		t.Fatalf("cut PATCH completed with %d", resp.StatusCode)
	}
	if proxy.Cuts.Load() != 1 {
		t.Fatal("PATCH was not cut: fault not injected")
	}
	// The server may need a moment to notice the broken connection.
	var off int
	for i := 0; i < 50; i++ {
		off = tusOffset(t, direct, u.token, loc)
		if off == chunk {
			break
		}
		time.Sleep(100 * time.Millisecond)
	}
	if off != chunk {
		t.Fatalf("offset after the cut = %d, want %d (a partial chunk was counted)", off, chunk)
	}
	if len(p.missingBlobs(t, u, vault, h)) != 1 {
		t.Fatal("blob visible before completion")
	}
	// A retry with a stale offset is refused and tells the right one.
	if resp, err := tusPatchAt(t, direct, u.token, loc, 0, data[:chunk]); err != nil || resp.StatusCode == http.StatusNoContent {
		t.Fatalf("stale offset accepted: %v %v", resp, err)
	}
	// Resume from the reported offset with the rest in one request.
	resp, err = tusPatchAt(t, direct, u.token, loc, off, data[off:])
	if err != nil || resp.StatusCode != http.StatusNoContent {
		t.Fatalf("resume: %v %v", resp, err)
	}
	_ = resp.Body.Close()
	req, _ := http.NewRequest(http.MethodGet, p.baseURL+"/vaults/"+vault+"/blobs/"+h, nil)
	req.Header.Set("Authorization", "Bearer "+u.token)
	dl, err := plainHTTP.Do(req)
	if err != nil || dl.StatusCode != http.StatusOK {
		t.Fatalf("download: %v %v", dl, err)
	}
	got, _ := io.ReadAll(dl.Body)
	_ = dl.Body.Close()
	if hashOf(got) != h || !bytes.Equal(got, data) {
		t.Fatal("assembled blob differs from the original")
	}
}

// A corrupted chunk (right length, wrong bytes) is caught by the digest check
// at completion: nothing is published and the session is discarded.
func TestTusCorruptedChunkRejected(t *testing.T) {
	iss := authtest.New(t)
	p := startCloud(t, iss.URL(), databaseURL, t.TempDir())
	u := p.user(iss, "tuscorrupt")
	vault := p.createVault(u, "tusc-"+newID()[24:])
	direct := strings.TrimPrefix(p.root, "http://")
	data := bytes.Repeat([]byte("integrity"), 20000)
	h := hashOf(data)
	loc := tusCreateAt(t, direct, u.token, vault, data)
	half := len(data) / 2

	if resp, err := tusPatchAt(t, direct, u.token, loc, 0, data[:half]); err != nil || resp.StatusCode != http.StatusNoContent {
		t.Fatalf("chunk 1: %v %v", resp, err)
	}
	bad := append([]byte(nil), data[half:]...)
	bad[len(bad)/2] ^= 0xff // one flipped bit-pattern, same length
	resp, err := tusPatchAt(t, direct, u.token, loc, half, bad)
	if err != nil {
		t.Fatal(err)
	}
	b, _ := io.ReadAll(resp.Body)
	_ = resp.Body.Close()
	if resp.StatusCode != http.StatusBadRequest {
		t.Fatalf("corrupted upload accepted: %d %s", resp.StatusCode, b)
	}
	if pr := problemOf(t, b); pr["code"] != "VALIDATION_FAILED" {
		t.Fatalf("problem: %s", b)
	}
	if len(p.missingBlobs(t, u, vault, h)) != 1 {
		t.Fatal("corrupted content was published")
	}
	if resp, err := tusDo(t, direct, u.token, http.MethodHead, loc, nil, nil); err != nil || resp.StatusCode != http.StatusNotFound {
		t.Fatalf("failed upload not discarded: %v %v", resp, err)
	}
	// A fresh attempt with the right bytes works.
	loc = tusCreateAt(t, direct, u.token, vault, data)
	if resp, err := tusPatchAt(t, direct, u.token, loc, 0, data); err != nil || resp.StatusCode != http.StatusNoContent {
		t.Fatalf("clean retry: %v %v", resp, err)
	}
	if len(p.missingBlobs(t, u, vault, h)) != 0 {
		t.Fatal("blob missing after clean retry")
	}
}

func goroutines(t *testing.T, p *cloudProc) int {
	t.Helper()
	resp, err := plainHTTP.Get(p.root + "/metrics")
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = resp.Body.Close() }()
	b, _ := io.ReadAll(resp.Body)
	for _, line := range strings.Split(string(b), "\n") {
		if v, ok := strings.CutPrefix(line, "go_goroutines "); ok {
			f, _ := strconv.ParseFloat(strings.TrimSpace(v), 64)
			return int(f)
		}
	}
	t.Fatal("go_goroutines not exposed")
	return 0
}

func pgConns(t *testing.T, url string) int {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	conn, err := pgx.Connect(ctx, url)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = conn.Close(ctx) }()
	var n int
	if err := conn.QueryRow(ctx, `SELECT count(*) FROM pg_stat_activity WHERE datname = 'clarae' AND pid <> pg_backend_pid() AND backend_type = 'client backend'`).Scan(&n); err != nil {
		t.Fatal(err)
	}
	return n
}

// PostgreSQL stops and starts under the running service: readiness goes
// unready and ready again, requests fail with problem documents (never 401,
// liveness stays up), the service recovers without restart and neither
// goroutines nor connections leak across several cycles.
func TestPostgresRestartUnderRunningCloud(t *testing.T) {
	pg := startRestartablePG(t)
	iss := authtest.New(t)
	p := startCloud(t, iss.URL(), pg.URL, t.TempDir())
	u := p.user(iss, "pgchaos")
	vault := p.createVault(u, "pg-"+newID()[24:])
	first := p.commit(u, vault, []map[string]any{create(newID(), "before.md", p.putBlob(u, vault, []byte("before")))})
	if first.status != http.StatusOK {
		t.Fatalf("seed commit: %d %s", first.status, first.body)
	}
	mustAccepted(t, first.results[0])
	baseGo := goroutines(t, p)
	baseConns := pgConns(t, pg.URL)

	for cycle := 1; cycle <= 3; cycle++ {
		pg.stop(t) // injected: the database is gone

		unready := false
		for i := 0; i < 20; i++ {
			start := time.Now()
			st, b := p.get("/readyz", "")
			if d := time.Since(start); d > 6*time.Second {
				t.Fatalf("cycle %d: /readyz took %v during the outage", cycle, d)
			}
			if st == http.StatusServiceUnavailable {
				if !strings.Contains(string(b), "database") {
					t.Fatalf("readyz 503 without the failing check: %s", b)
				}
				unready = true
				break
			}
			time.Sleep(200 * time.Millisecond)
		}
		if !unready {
			t.Fatalf("cycle %d: readiness never went unready with the database down", cycle)
		}
		if st, _ := p.get("/healthz", ""); st != http.StatusOK {
			t.Fatalf("cycle %d: liveness failed during a dependency outage (%d): kubelet would restart healthy pods", cycle, st)
		}
		// Requests during the outage: a problem document, not a hang and not a 401.
		for _, req := range []func() (int, []byte){
			func() (int, []byte) { return p.get("/me", u.token) },
			func() (int, []byte) {
				return p.call(http.MethodPost, "/vaults/"+vault+"/commit", u.token, map[string]any{"device_id": u.deviceID, "ops": []map[string]any{create(newID(), "during.md", hashOf([]byte("x")))}})
			},
		} {
			st, b := req()
			if st < 500 || st > 599 {
				t.Fatalf("cycle %d: request during the outage -> %d %s, want 5xx", cycle, st, b)
			}
			if pr := problemOf(t, b); pr["code"] == nil || pr["status"] == nil {
				t.Fatalf("cycle %d: outage response is not a problem document: %s", cycle, b)
			}
		}

		pg.start(t)
		began := time.Now()
		ready := false
		for time.Since(began) < 60*time.Second {
			if st, _ := p.get("/readyz", ""); st == http.StatusOK {
				ready = true
				break
			}
			time.Sleep(250 * time.Millisecond)
		}
		if !ready {
			t.Fatalf("cycle %d: not ready 60 s after the database came back\n%s", cycle, p.log())
		}
		t.Logf("cycle %d: ready again %v after the database restart", cycle, time.Since(began).Round(100*time.Millisecond))
		// Once ready, requests must work immediately: no stale pooled connection may leak out.
		for i := 0; i < 10; i++ {
			if st, b := p.get("/me", u.token); st != http.StatusOK {
				t.Fatalf("cycle %d: request %d after readiness failed: %d %s", cycle, i, st, b)
			}
		}
		out := p.commit(u, vault, []map[string]any{create(newID(), fmt.Sprintf("after-%d.md", cycle), p.putBlob(u, vault, []byte(fmt.Sprintf("after %d", cycle))))})
		if out.status != http.StatusOK {
			t.Fatalf("cycle %d: commit after recovery: %d %s", cycle, out.status, out.body)
		}
		mustAccepted(t, out.results[0])
	}

	items := p.changesAll(u, vault)
	if len(items) != 4 {
		t.Fatalf("changelog has %d entries, want 4 (before + 3 after)", len(items))
	}
	time.Sleep(2 * time.Second)
	if g := goroutines(t, p); g > baseGo+15 {
		t.Fatalf("goroutines grew from %d to %d over 3 outages: leak", baseGo, g)
	}
	maxConns := runtime.NumCPU()*2 + 8
	if c := pgConns(t, pg.URL); c > maxConns || c > baseConns+maxConns {
		t.Fatalf("server connections: %d (baseline %d, allowed %d): pool leak", c, baseConns, maxConns)
	}
}

// SIGTERM: readiness flips first, the process keeps serving during the drain,
// a request in flight completes, then the process exits by itself.
func TestSIGTERMDrainsAndCompletesInflight(t *testing.T) {
	iss := authtest.New(t)
	p := startCloud(t, iss.URL(), databaseURL, t.TempDir(), "SHUTDOWN_DRAIN=2s", "SHUTDOWN_TIMEOUT=10s")
	u := p.user(iss, "drain")
	vault := p.createVault(u, "drain-"+newID()[24:])
	pool := rawDB(t, databaseURL)
	installSleeper(t, pool, "chaos/sleeper.md", 3*time.Second)
	h := p.putBlob(u, vault, []byte("in flight"))

	done := make(chan commitOutcome, 1)
	go func() {
		done <- p.commit(u, vault, []map[string]any{create(newID(), "chaos/sleeper.md", h)})
	}()
	waitSleeping(t, pool)

	start := time.Now()
	var once sync.Once
	exited := make(chan time.Duration, 1)
	go once.Do(func() {
		d, ok := p.term(30 * time.Second)
		if !ok {
			d = -1
		}
		exited <- d
	})

	sawUnready, servedWhileDraining := false, false
	for time.Since(start) < 1800*time.Millisecond {
		st, b := p.get("/readyz", "")
		if st == http.StatusServiceUnavailable && strings.Contains(string(b), "shutdown") {
			sawUnready = true
			if hz, _ := p.get("/healthz", ""); hz == http.StatusOK {
				servedWhileDraining = true
			}
		}
		time.Sleep(100 * time.Millisecond)
	}
	if !sawUnready {
		t.Fatal("readiness did not flip to unavailable right after SIGTERM")
	}
	if !servedWhileDraining {
		t.Fatal("the server stopped answering during the drain window")
	}
	out := <-done
	if out.status != http.StatusOK {
		t.Fatalf("request in flight at SIGTERM failed: %d %s (log: %s)", out.status, out.body, p.log())
	}
	mustAccepted(t, out.results[0])
	select {
	case d := <-exited:
		if d < 0 {
			t.Fatal("process did not exit after SIGTERM")
		}
		if d < 2*time.Second {
			t.Fatalf("process exited after %v: drain delay not honoured", d)
		}
	case <-time.After(30 * time.Second):
		t.Fatal("process did not exit")
	}
}

type querier interface {
	QueryRow(context.Context, string, ...any) pgx.Row
}

func jsonBody(v any) ([]byte, error) { return json.Marshal(v) }

func jsonUnmarshal(b []byte, v any) error { return json.Unmarshal(b, v) }
