//go:build integration

package integration

// Process lifecycle of the API role: the listener answers the probes before
// the migrations (which may wait for another replica's lock), and the gRPC
// notification stream drains like HTTP at SIGTERM.

import (
	"context"
	"net"
	"net/http"
	"strings"
	"sync"
	"testing"
	"time"

	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials/insecure"
	"google.golang.org/grpc/metadata"

	"memobrain/services/cloud/internal/auth/authtest"
	"memobrain/shared/notifyv1"
)

// migrationLockID mirrors db.migrationLockID.
const migrationLockID = 7_300_001

// While another replica holds the migration lock the process is alive for the
// orchestrator (/healthz 200, so the startup probe does not kill it) but not
// ready (/readyz 503, the API answers 503); it becomes ready once the lock is
// released.
func TestStartupAnswersProbesWhileMigrationWaits(t *testing.T) {
	dbURL := freshDatabase(t, "startup_lock")
	unlock := holdMigrationLock(t, dbURL)

	iss := authtest.New(t)
	p := launchCloud(t, iss.URL(), dbURL, t.TempDir())
	waitStatus(t, p, "/healthz", http.StatusOK, 30*time.Second)
	// The lock is still held: the startup cannot have completed. Probe for a
	// while to prove the process neither exits nor reports ready.
	for end := time.Now().Add(3 * time.Second); time.Now().Before(end); time.Sleep(250 * time.Millisecond) {
		if st, _ := p.get("/healthz", ""); st != http.StatusOK {
			t.Fatalf("/healthz while migrating = %d\n%s", st, p.log())
		}
		st, b := p.get("/readyz", "")
		if st != http.StatusServiceUnavailable || !strings.Contains(string(b), `"startup"`) {
			t.Fatalf("/readyz while migrating = %d %s", st, b)
		}
	}
	if st, b := p.get("/me", "any-token"); st != http.StatusServiceUnavailable || !strings.Contains(string(b), "starting") {
		t.Fatalf("API while starting = %d %s", st, b)
	}
	select {
	case <-p.exited:
		t.Fatalf("cloud exited while waiting for the migration lock:\n%s", p.log())
	default:
	}

	unlock()
	waitStatus(t, p, "/readyz", http.StatusOK, 30*time.Second)
	u := p.user(iss, "startup")
	if st, b := p.get("/me", u.token); st != http.StatusOK {
		t.Fatalf("GET /me once ready: %d %s", st, b)
	}
}

// A SIGTERM while the startup waits for the migration lock (a rollout replaced
// the pod meanwhile) stops the process promptly and with status 0.
func TestSIGTERMDuringStartupExitsCleanly(t *testing.T) {
	dbURL := freshDatabase(t, "startup_term")
	holdMigrationLock(t, dbURL)

	p := launchCloud(t, authtest.New(t).URL(), dbURL, t.TempDir(), "LOG_LEVEL=info")
	waitStatus(t, p, "/healthz", http.StatusOK, 30*time.Second)
	if _, ok := p.term(15 * time.Second); !ok {
		t.Fatalf("process did not exit after SIGTERM during the startup:\n%s", p.log())
	}
	if code := p.state.ExitCode(); code != 0 {
		t.Fatalf("exit status %d after SIGTERM during the startup:\n%s", code, p.log())
	}
	if !strings.Contains(p.log(), "stopped during startup") {
		t.Fatalf("log does not report the interrupted startup:\n%s", p.log())
	}
}

// The listener opens before the database: when its port is taken the process
// exits with that error, not with the cancellation it caused downstream.
func TestStartupReportsBusyListener(t *testing.T) {
	busy, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = busy.Close() }()
	p := launchCloud(t, authtest.New(t).URL(), databaseURL, t.TempDir(), "LISTEN_ADDR="+busy.Addr().String())
	select {
	case <-p.exited:
	case <-time.After(30 * time.Second):
		t.Fatalf("process still running with its HTTP port taken:\n%s", p.log())
	}
	if code := p.state.ExitCode(); code == 0 {
		t.Fatalf("exit status 0 with the HTTP port taken:\n%s", p.log())
	}
	if log := p.log(); !strings.Contains(log, "http: listen") || !strings.Contains(log, "address already in use") {
		t.Fatalf("exit error is not the listener's:\n%s", log)
	}
}

// SIGTERM: the notification stream stays open during the drain (and still
// delivers events), the gRPC listener still accepts new streams, then the
// streams end and the process exits.
func TestSIGTERMDrainsGRPCStream(t *testing.T) {
	const drainDelay = 2 * time.Second
	iss := authtest.New(t)
	p := startCloud(t, iss.URL(), databaseURL, t.TempDir(), "SHUTDOWN_DRAIN="+drainDelay.String(), "SHUTDOWN_TIMEOUT=10s")
	u := p.user(iss, "grpcdrain")
	vault := p.createVault(u, "grpcdrain-"+newID()[24:])
	h := p.putBlob(u, vault, []byte("drain"))
	mustAccepted(t, p.commit(u, vault, []map[string]any{create(newID(), "one.md", h)}).results[0])

	subscribe := func() (notifyv1.NotifyService_SubscribeClient, func()) {
		t.Helper()
		conn, err := grpc.NewClient(p.grpc, grpc.WithTransportCredentials(insecure.NewCredentials()))
		if err != nil {
			t.Fatal(err)
		}
		ctx, cancel := context.WithTimeout(metadata.AppendToOutgoingContext(context.Background(), "authorization", "Bearer "+u.token), 30*time.Second)
		stream, err := notifyv1.NewNotifyServiceClient(conn).Subscribe(ctx, &notifyv1.SubscribeRequest{DeviceId: u.deviceID, KnownSeq: map[string]int64{vault: 0}})
		if err != nil {
			t.Fatal(err)
		}
		if ev, err := stream.Recv(); err != nil || ev.GetVaultChanged().GetVaultId() != vault {
			t.Fatalf("replay event: %v %v", ev, err)
		}
		return stream, func() { cancel(); _ = conn.Close() }
	}
	stream, closeStream := subscribe()
	defer closeStream()

	start := time.Now()
	exited := make(chan time.Duration, 1)
	go func() {
		d, ok := p.term(30 * time.Second)
		if !ok {
			d = -1
		}
		exited <- d
	}()

	// Collect the stream until it ends.
	type recv struct {
		seq int64
		err error
		at  time.Duration
	}
	events := make(chan recv, 16)
	go func() {
		for {
			ev, err := stream.Recv()
			if err != nil {
				events <- recv{err: err, at: time.Since(start)}
				return
			}
			events <- recv{seq: ev.GetVaultChanged().GetSeq(), at: time.Since(start)}
		}
	}()

	// During the drain a commit still reaches the open stream, and a new
	// stream can still be opened (the listener is not closed yet).
	time.Sleep(300 * time.Millisecond)
	mustAccepted(t, p.commit(u, vault, []map[string]any{create(newID(), "two.md", h)}).results[0])
	_, closeLate := subscribe()
	defer closeLate()

	gotLive := false
	for {
		r := <-events
		if r.err != nil {
			if r.at < drainDelay*3/4 {
				t.Fatalf("stream ended %v after SIGTERM, before the drain delay (%v): %v", r.at, drainDelay, r.err)
			}
			break
		}
		if r.seq >= 2 {
			gotLive = true
		}
	}
	if !gotLive {
		t.Fatal("no event delivered on the open stream during the drain")
	}
	if d := <-exited; d < 0 {
		t.Fatalf("process did not exit after SIGTERM:\n%s", p.log())
	}
}

// holdMigrationLock takes the migration lock of the database at url, as a
// replica that is migrating would, until the returned function or the end of
// the test. The database must have pending migrations (freshDatabase): goose
// takes the lock only when there is something to apply.
func holdMigrationLock(t *testing.T, url string) (unlock func()) {
	t.Helper()
	ctx := context.Background()
	holder, err := rawDB(t, url).Acquire(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := holder.Exec(ctx, "SELECT pg_advisory_lock($1)", int64(migrationLockID)); err != nil {
		holder.Release()
		t.Fatal(err)
	}
	var once sync.Once
	unlock = func() {
		once.Do(func() {
			_, _ = holder.Exec(ctx, "SELECT pg_advisory_unlock($1)", int64(migrationLockID))
			holder.Release()
		})
	}
	t.Cleanup(unlock)
	return unlock
}

// waitStatus polls path until it answers want, failing if the process exits.
func waitStatus(t *testing.T, p *cloudProc, path string, want int, timeout time.Duration) {
	t.Helper()
	deadline := time.Now().Add(timeout)
	for {
		st, b := p.get(path, "")
		if st == want {
			return
		}
		if time.Now().After(deadline) {
			t.Fatalf("%s = %d %s, want %d\n%s", path, st, b, want, p.log())
		}
		select {
		case <-p.exited:
			t.Fatalf("cloud exited while waiting for %s:\n%s", path, p.log())
		case <-time.After(200 * time.Millisecond):
		}
	}
}
