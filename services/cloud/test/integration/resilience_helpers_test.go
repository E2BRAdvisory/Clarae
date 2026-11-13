//go:build integration

package integration

// Helpers for the fault-injection tests (M7-WP2b): the cloud as a real
// subprocess (so it can be SIGKILLed), a plain HTTP client that does not
// validate against the spec (failures are the point), a TCP proxy that cuts
// connections mid-request and a PostgreSQL container that can be restarted.

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"sync"
	"sync/atomic"
	"syscall"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"clarae/services/cloud/internal/auth/authtest"
)

var (
	cloudBinOnce sync.Once
	cloudBinPath string
	cloudBinErr  error
)

// cloudBinary builds cmd/clarae-cloud once per test run.
func cloudBinary(t *testing.T) string {
	t.Helper()
	cloudBinOnce.Do(func() {
		dir, err := os.MkdirTemp("", "clarae-chaos-bin-")
		if err != nil {
			cloudBinErr = err
			return
		}
		cloudBinPath = filepath.Join(dir, "clarae-cloud")
		out, err := exec.Command("go", "build", "-o", cloudBinPath, "clarae/services/cloud/cmd/clarae-cloud").CombinedOutput() //nolint:gosec // fixed arguments
		if err != nil {
			cloudBinErr = fmt.Errorf("build: %w\n%s", err, out)
		}
	})
	if cloudBinErr != nil {
		t.Fatal(cloudBinErr)
	}
	return cloudBinPath
}

func freeAddr(t *testing.T) string {
	t.Helper()
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = l.Close() }()
	return l.Addr().String()
}

// cloudProc is one running clarae-cloud process.
type cloudProc struct {
	t       *testing.T
	cmd     *exec.Cmd
	baseURL string // http://host:port/api/v1
	root    string // http://host:port
	logPath string
	grpc    string // host:port of the notification stream
	exited  chan struct{}
	state   *os.ProcessState // set before exited is closed
}

// startCloud launches the binary against dbURL and waits for /readyz.
func startCloud(t *testing.T, issuerURL, dbURL, storageDir string, extraEnv ...string) *cloudProc {
	t.Helper()
	p := launchCloud(t, issuerURL, dbURL, storageDir, extraEnv...)
	deadline := time.Now().Add(60 * time.Second)
	for time.Now().Before(deadline) {
		if st, _ := p.get("/readyz", ""); st == http.StatusOK {
			return p
		}
		select {
		case <-p.exited:
			t.Fatalf("cloud exited during startup:\n%s", p.log())
		case <-time.After(200 * time.Millisecond):
		}
	}
	t.Fatalf("cloud not ready:\n%s", p.log())
	return nil
}

// launchCloud starts the binary against dbURL without waiting for it.
func launchCloud(t *testing.T, issuerURL, dbURL, storageDir string, extraEnv ...string) *cloudProc {
	t.Helper()
	addr, grpcAddr := freeAddr(t), freeAddr(t)
	logPath := filepath.Join(t.TempDir(), "cloud.log")
	logFile, err := os.Create(logPath)
	if err != nil {
		t.Fatal(err)
	}
	cmd := exec.Command(cloudBinary(t), "--role=all") //nolint:gosec // binary built by this test
	cmd.Env = append(os.Environ(),
		"LISTEN_ADDR="+addr, "GRPC_LISTEN_ADDR="+grpcAddr, "DATABASE_URL="+dbURL,
		"STORAGE_DIR="+storageDir, "OIDC_ISSUER="+issuerURL, "OIDC_AUDIENCE=clarae-api",
		"OIDC_STATUS_CACHE_TTL=1s", "LOG_LEVEL=warn", "SHUTDOWN_DRAIN=0s",
	)
	cmd.Env = append(cmd.Env, extraEnv...)
	cmd.Stdout, cmd.Stderr = logFile, logFile
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	p := &cloudProc{t: t, cmd: cmd, baseURL: "http://" + addr + "/api/v1", root: "http://" + addr, logPath: logPath, grpc: grpcAddr, exited: make(chan struct{})}
	go func() { p.state, _ = cmd.Process.Wait(); close(p.exited); _ = logFile.Close() }()
	t.Cleanup(func() { p.kill() })
	return p
}

func (p *cloudProc) log() string { b, _ := os.ReadFile(p.logPath); return string(b) }

// kill is SIGKILL: no handler runs, sockets are torn down by the kernel.
func (p *cloudProc) kill() {
	select {
	case <-p.exited:
		return
	default:
	}
	_ = p.cmd.Process.Signal(syscall.SIGKILL)
	<-p.exited
}

// term is SIGTERM and waits for the process to exit.
func (p *cloudProc) term(timeout time.Duration) (time.Duration, bool) {
	start := time.Now()
	_ = p.cmd.Process.Signal(syscall.SIGTERM)
	select {
	case <-p.exited:
		return time.Since(start), true
	case <-time.After(timeout):
		return timeout, false
	}
}

var plainHTTP = &http.Client{Timeout: 30 * time.Second, Transport: &http.Transport{DisableKeepAlives: true}}

func (p *cloudProc) get(path, token string) (int, []byte) {
	return p.call(http.MethodGet, path, token, nil)
}

// call performs a JSON request; transport errors map to status 0.
func (p *cloudProc) call(method, path, token string, body any) (int, []byte) {
	var rd io.Reader
	if body != nil {
		b, _ := json.Marshal(body)
		rd = bytes.NewReader(b)
	}
	req, err := http.NewRequest(method, p.baseURL+path, rd)
	if err != nil {
		p.t.Fatal(err)
	}
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	resp, err := plainHTTP.Do(req)
	if err != nil {
		return 0, []byte(err.Error())
	}
	defer func() { _ = resp.Body.Close() }()
	b, _ := io.ReadAll(resp.Body)
	return resp.StatusCode, b
}

// procUser is a user provisioned through a cloud process.
type procUser struct {
	token, deviceID string
}

func (p *cloudProc) user(iss *authtest.Issuer, name string) procUser {
	p.t.Helper()
	tok := iss.Token(p.t, authtest.TokenOptions{Subject: "sub-" + name + "-" + newID(), Username: name, Email: name + "-" + newID()[24:] + "@clarae.local", ExpiresIn: 2 * time.Hour})
	if st, b := p.get("/me", tok); st != http.StatusOK {
		p.t.Fatalf("GET /me: %d %s\n%s", st, b, p.log())
	}
	st, b := p.call(http.MethodPost, "/me/devices", tok, map[string]any{"name": name + "-laptop", "platform": "linux"})
	if st != http.StatusCreated {
		p.t.Fatalf("register device: %d %s", st, b)
	}
	var dev map[string]any
	_ = json.Unmarshal(b, &dev)
	return procUser{token: tok, deviceID: dev["id"].(string)}
}

func (p *cloudProc) createVault(u procUser, name string) string {
	p.t.Helper()
	st, b := p.call(http.MethodPost, "/vaults", u.token, map[string]any{"name": name, "kind": "shared"})
	if st != http.StatusCreated {
		p.t.Fatalf("create vault: %d %s", st, b)
	}
	var v map[string]any
	_ = json.Unmarshal(b, &v)
	return v["id"].(string)
}

func (p *cloudProc) putBlob(u procUser, vault string, data []byte) string {
	p.t.Helper()
	h := hashOf(data)
	req, _ := http.NewRequest(http.MethodPut, p.baseURL+"/vaults/"+vault+"/blobs/"+h, bytes.NewReader(data))
	req.Header.Set("Authorization", "Bearer "+u.token)
	req.Header.Set("Content-Type", "application/octet-stream")
	resp, err := plainHTTP.Do(req)
	if err != nil {
		p.t.Fatal(err)
	}
	_ = resp.Body.Close()
	if resp.StatusCode != http.StatusNoContent {
		p.t.Fatalf("put blob: %d", resp.StatusCode)
	}
	return h
}

type commitOutcome struct {
	status  int
	body    []byte
	results []result
	lastSeq int64
}

func (p *cloudProc) commit(u procUser, vault string, ops []map[string]any) commitOutcome {
	st, b := p.call(http.MethodPost, "/vaults/"+vault+"/commit", u.token, map[string]any{"device_id": u.deviceID, "ops": ops})
	out := commitOutcome{status: st, body: b}
	if st == http.StatusOK {
		var r struct {
			Results []result `json:"results"`
			LastSeq float64  `json:"last_seq"`
		}
		_ = json.Unmarshal(b, &r)
		out.results, out.lastSeq = r.Results, int64(r.LastSeq)
	}
	return out
}

// changesAll pages through /changes from since=0 and returns every item.
func (p *cloudProc) changesAll(u procUser, vault string) []map[string]any {
	p.t.Helper()
	var all []map[string]any
	since := int64(0)
	for {
		st, b := p.get(fmt.Sprintf("/vaults/%s/changes?since=%d&limit=500", vault, since), u.token)
		if st != http.StatusOK {
			p.t.Fatalf("changes: %d %s", st, b)
		}
		var r struct {
			Items   []map[string]any `json:"items"`
			NextSeq float64          `json:"next_seq"`
			HasMore bool             `json:"has_more"`
		}
		_ = json.Unmarshal(b, &r)
		all = append(all, r.Items...)
		since = int64(r.NextSeq)
		if !r.HasMore {
			return all
		}
	}
}

// problemOf decodes an application/problem+json body.
func problemOf(t *testing.T, body []byte) map[string]any {
	t.Helper()
	var m map[string]any
	if err := json.Unmarshal(body, &m); err != nil {
		t.Fatalf("not a JSON problem document: %q", body)
	}
	return m
}

// rawDB opens a direct pool on the database (the test's own, not the service's).
func rawDB(t *testing.T, url string) *pgxpool.Pool {
	t.Helper()
	pool, err := pgxpool.New(context.Background(), url)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	return pool
}

// installSleeper makes the INSERT of the file at path block for d inside its
// transaction: the deterministic "middle of the commit" the faults hit.
//
//nolint:unparam // the path is a parameter for readability at call sites
func installSleeper(t *testing.T, pool *pgxpool.Pool, path string, d time.Duration) {
	t.Helper()
	ctx := context.Background()
	stmts := []string{
		fmt.Sprintf(`CREATE OR REPLACE FUNCTION chaos_sleeper() RETURNS trigger AS $$
BEGIN
  IF NEW.path = '%s' THEN PERFORM pg_sleep(%f); END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql`, path, d.Seconds()),
		`DROP TRIGGER IF EXISTS chaos_sleeper ON files`,
		`CREATE TRIGGER chaos_sleeper BEFORE INSERT ON files FOR EACH ROW EXECUTE FUNCTION chaos_sleeper()`,
	}
	for _, s := range stmts {
		if _, err := pool.Exec(ctx, s); err != nil {
			t.Fatal(err)
		}
	}
	t.Cleanup(func() { removeSleeper(pool) })
}

func removeSleeper(pool *pgxpool.Pool) {
	_, _ = pool.Exec(context.Background(), `DROP TRIGGER IF EXISTS chaos_sleeper ON files`)
}

// waitSleeping waits until a backend is inside the sleeper and returns its pid.
func waitSleeping(t *testing.T, pool *pgxpool.Pool) int {
	t.Helper()
	deadline := time.Now().Add(20 * time.Second)
	for time.Now().Before(deadline) {
		var pid int
		err := pool.QueryRow(context.Background(),
			`SELECT pid FROM pg_stat_activity WHERE wait_event = 'PgSleep' AND pid <> pg_backend_pid() LIMIT 1`).Scan(&pid)
		if err == nil {
			return pid
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatal("no backend reached the injected sleep: the commit never got in the middle of its transaction")
	return 0
}

// cutProxy is a TCP proxy that can cut a connection after a number of bytes
// were sent upstream (client to server), simulating a network drop mid-request.
type cutProxy struct {
	Addr     string
	target   string
	l        net.Listener
	cutAfter atomic.Int64 // >0: cut the next connection after this many upstream bytes (one shot)
	Cuts     atomic.Int32
	Conns    atomic.Int32
}

func newCutProxy(t *testing.T, target string) *cutProxy {
	t.Helper()
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	p := &cutProxy{Addr: l.Addr().String(), target: target, l: l}
	go p.serve()
	t.Cleanup(func() { _ = l.Close() })
	return p
}

func (p *cutProxy) serve() {
	for {
		c, err := p.l.Accept()
		if err != nil {
			return
		}
		p.Conns.Add(1)
		go p.handle(c)
	}
}

func (p *cutProxy) handle(c net.Conn) {
	up, err := net.Dial("tcp", p.target)
	if err != nil {
		_ = c.Close()
		return
	}
	limit := p.cutAfter.Swap(0)
	go func() { _, _ = io.Copy(c, up); _ = c.Close() }()
	if limit > 0 {
		n, _ := io.CopyN(up, c, limit)
		if n == limit {
			p.Cuts.Add(1)
		}
		_ = up.Close()
		_ = c.Close()
		return
	}
	_, _ = io.Copy(up, c)
	_ = up.Close()
}
