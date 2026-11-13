//go:build integration

package integration

import (
	"context"
	"io"
	"net/http"
	"strings"
	stdsync "sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/rs/zerolog"

	"clarae/services/cloud/internal/export"
	"clarae/services/cloud/internal/storage"
)

// A POST /vaults retried with its Idempotency-Key (the response was lost)
// gets the vault the first attempt created, not NAME_IN_USE.
func TestCreateVaultIsIdempotent(t *testing.T) {
	e := newEnv(t)
	ada := e.user("ada-idem")
	hdr := map[string]string{"Idempotency-Key": "create-notes-1"}
	body := []byte(`{"name":"Notes","kind":"shared"}`)

	first := ada.raw(http.MethodPost, "/vaults", "application/json", body, hdr)
	expect(t, first, http.StatusCreated)
	a := decode[map[string]any](t, first)
	retry := ada.raw(http.MethodPost, "/vaults", "application/json", body, hdr)
	expect(t, retry, http.StatusCreated)
	if b := decode[map[string]any](t, retry); b["id"] != a["id"] || b["name"] != "Notes" {
		t.Fatalf("retry created another vault: %v vs %v", b, a)
	}
	if n := e.count("SELECT COUNT(*) FROM vaults WHERE owner_id=$1", ada.uid()); n != 1 {
		t.Fatalf("%d vaults, want 1", n)
	}
	// Without the key (or with another one) the name is taken.
	resp := ada.raw(http.MethodPost, "/vaults", "application/json", body, map[string]string{"Idempotency-Key": "create-notes-2"})
	expect(t, resp, http.StatusConflict)
	if code := problemCode(t, resp); code != "NAME_IN_USE" {
		t.Fatalf("code %s", code)
	}
	// The same key for a vault of the other kind is a client error.
	resp = ada.raw(http.MethodPost, "/vaults", "application/json", []byte(`{"name":"Other","kind":"private"}`), hdr)
	expect(t, resp, http.StatusBadRequest)
	// Keys belong to their user: bob's vault with ada's key is a new vault.
	bob := e.user("bob-idem")
	resp = bob.raw(http.MethodPost, "/vaults", "application/json", body, hdr)
	expect(t, resp, http.StatusCreated)
	if b := decode[map[string]any](t, resp); b["id"] == a["id"] {
		t.Fatal("bob got ada's vault")
	}
	// Too long a key is refused.
	long := map[string]string{"Idempotency-Key": strings.Repeat("k", 129)}
	expect(t, ada.raw(http.MethodPost, "/vaults", "application/json", []byte(`{"name":"Long","kind":"shared"}`), long), http.StatusBadRequest)
}

// A POST /me/devices retried with its Idempotency-Key registers one device.
func TestRegisterDeviceIsIdempotent(t *testing.T) {
	e := newEnv(t)
	ada := e.user("ada-dev-idem")
	hdr := map[string]string{"Idempotency-Key": "register-1"}
	body := []byte(`{"name":"Studio","platform":"macos","app_version":"1.0.0"}`)
	first := ada.raw(http.MethodPost, "/me/devices", "application/json", body, hdr)
	expect(t, first, http.StatusCreated)
	a := decode[map[string]any](t, first)
	retry := ada.raw(http.MethodPost, "/me/devices", "application/json", body, hdr)
	expect(t, retry, http.StatusCreated)
	if b := decode[map[string]any](t, retry); b["id"] != a["id"] {
		t.Fatalf("retry registered another device: %v vs %v", b, a)
	}
	// ada.user() registered one device already; the retry added none.
	if n := e.count("SELECT COUNT(*) FROM devices WHERE user_id=$1", ada.uid()); n != 2 {
		t.Fatalf("%d devices, want 2", n)
	}
	resp := ada.raw(http.MethodPost, "/me/devices", "application/json", []byte(`{"name":"Studio","platform":"linux"}`), hdr)
	expect(t, resp, http.StatusBadRequest)
}

// Concurrent attempts with one Idempotency-Key (a retry sent while the first
// attempt is still running) all get the one resource: the attempts that lose
// the race on the unique index replay the winner's.
func TestIdempotentCreateUnderConcurrentRetries(t *testing.T) {
	e := newEnv(t)
	ada := e.user("ada-idem-race")
	ctx := context.Background()
	const attempts = 8
	var (
		wg     stdsync.WaitGroup
		vaults [attempts]uuid.UUID
		devs   [attempts]uuid.UUID
		errs   [2 * attempts]error
	)
	for i := range attempts {
		wg.Add(2)
		go func() {
			defer wg.Done()
			v, err := e.app.Vaults.Create(ctx, ada.uid(), "race-vault", "Race", "shared", nil)
			vaults[i], errs[i] = v.ID, err
		}()
		go func() {
			defer wg.Done()
			d, err := e.app.Users.RegisterDevice(ctx, ada.uid(), "race-device", "Studio", "macos", nil)
			devs[i], errs[attempts+i] = d.ID, err
		}()
	}
	wg.Wait()
	for i, err := range errs {
		if err != nil {
			t.Fatalf("attempt %d: %v", i, err)
		}
	}
	for i := range attempts {
		if vaults[i] != vaults[0] || devs[i] != devs[0] {
			t.Fatalf("attempt %d got vault %s device %s, want %s %s", i, vaults[i], devs[i], vaults[0], devs[0])
		}
	}
	if n := e.count("SELECT COUNT(*) FROM vaults WHERE owner_id=$1", ada.uid()); n != 1 {
		t.Fatalf("%d vaults, want 1", n)
	}
	if n := e.count("SELECT COUNT(*) FROM devices WHERE user_id=$1 AND idempotency_key='race-device'", ada.uid()); n != 1 {
		t.Fatalf("%d devices, want 1", n)
	}
}

// exportJob reads the state of a job from the database (the API hides the
// jobs of deleted vaults and accounts).
func (e *env) exportJob(id string) (status, errText string, expires *time.Time) {
	e.t.Helper()
	var msg *string
	if err := e.db.Pool.QueryRow(context.Background(), "SELECT status, error, expires_at FROM export_jobs WHERE id=$1", id).Scan(&status, &msg, &expires); err != nil {
		e.t.Fatal(err)
	}
	if msg != nil {
		errText = *msg
	}
	return status, errText, expires
}

func (c *client) startExport(vault string) map[string]any {
	c.e.t.Helper()
	resp := c.json(http.MethodPost, "/vaults/"+vault+"/exports", nil)
	expect(c.e.t, resp, http.StatusAccepted)
	return decode[map[string]any](c.e.t, resp)
}

// A request on an unchanged vault gets its ready archive back; once the
// vault changes a new archive is built and the old one expires within the hour.
func TestExportReusesTheReadyArchiveOfAnUnchangedVault(t *testing.T) {
	e, ada, v, _ := exportFixture(t)
	ctx := context.Background()
	first := ada.startExport(v)["id"].(string)
	if _, err := e.app.Exports.ProcessPending(ctx); err != nil {
		t.Fatal(err)
	}
	again := ada.startExport(v)
	if again["id"] != first || again["status"] != "ready" {
		t.Fatalf("unchanged vault: %v, want the ready job %s", again, first)
	}

	ada.seed(v, map[string]string{"New.md": "new"})
	second := ada.startExport(v)
	if second["id"] == first || second["status"] != "queued" {
		t.Fatalf("changed vault: %v", second)
	}
	if _, err := e.app.Exports.ProcessPending(ctx); err != nil {
		t.Fatal(err)
	}
	status, _, expires := e.exportJob(first)
	if status != "ready" || expires == nil || expires.After(time.Now().Add(time.Hour+time.Minute)) {
		t.Fatalf("superseded archive: %s until %v, want ready for at most an hour", status, expires)
	}
	if status, _, expires := e.exportJob(second["id"].(string)); status != "ready" || expires == nil || expires.Before(time.Now().Add(23*time.Hour)) {
		t.Fatalf("new archive: %s until %v", status, expires)
	}
}

// cancellingStore ends the worker's context at the first read of a blob,
// as a SIGTERM would in the middle of a build.
type cancellingStore struct {
	storage.BlobStore
	cancel context.CancelFunc
	gets   atomic.Int32
}

func (s *cancellingStore) Get(ctx context.Context, key string, off, n int64) (io.ReadCloser, error) {
	s.gets.Add(1)
	s.cancel()
	return nil, context.Canceled
}

// A build interrupted by the shutdown of the worker goes back to the queue
// instead of failing, and the next worker builds it.
func TestExportInterruptedByShutdownIsQueuedAgain(t *testing.T) {
	e, ada, v, _ := exportFixture(t)
	id := ada.startExport(v)["id"].(string)
	// The archive an earlier, interrupted attempt uploaded before it could
	// finish the job.
	e.staleArchive(id)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	store := &cancellingStore{BlobStore: e.app.Store, cancel: cancel}
	worker := export.NewService(e.db, store, e.app.ExportStore, e.app.Sharing, zerolog.Nop())
	_, _ = worker.ProcessPending(ctx)
	if store.gets.Load() == 0 {
		t.Fatal("no build was interrupted")
	}
	if status, msg, expires := e.exportJob(id); status != "queued" || msg != "" || expires != nil {
		t.Fatalf("interrupted job: %s %q %v, want queued again", status, msg, expires)
	}
	if _, err := e.app.ExportStore.Size(context.Background(), "exports/"+id+".zip"); err == nil {
		t.Fatal("the archive of an interrupted build was kept")
	}
	if _, err := e.app.Exports.ProcessPending(context.Background()); err != nil {
		t.Fatal(err)
	}
	if status, _, _ := e.exportJob(id); status != "ready" {
		t.Fatalf("job after a new worker: %s", status)
	}
}

// hookStore runs hook at the first read of a blob.
type hookStore struct {
	storage.BlobStore
	hook func()
	once atomic.Bool
}

func (s *hookStore) Get(ctx context.Context, key string, off, n int64) (io.ReadCloser, error) {
	if s.once.CompareAndSwap(false, true) {
		s.hook()
	}
	return s.BlobStore.Get(ctx, key, off, n)
}

// Deleting the account fails its queued jobs, and a build running meanwhile
// does not leave its archive behind.
func TestExportJobsEndWithTheAccount(t *testing.T) {
	e := newEnv(t)
	ada := e.user("ada-exp-del")
	v := ada.createVault("Team", "shared")
	ada.seed(v, map[string]string{"a.md": "a"})
	queued := ada.startExport(v)["id"].(string)
	expect(t, ada.json(http.MethodDelete, "/me", map[string]any{"confirm": "ada-exp-del"}), http.StatusNoContent)
	if status, msg, _ := e.exportJob(queued); status != "failed" || msg != "the account was deleted" {
		t.Fatalf("queued job after the deletion: %s %q", status, msg)
	}

	// A build running while the account is deleted: the job is no longer
	// running when the archive is uploaded.
	bob := e.user("bob-exp-del")
	bv := bob.createVault("Team", "shared")
	bob.seed(bv, map[string]string{"b.md": "b"})
	running := bob.startExport(bv)["id"].(string)
	store := &hookStore{BlobStore: e.app.Store, hook: func() {
		e.exec("UPDATE export_jobs SET status='failed', error='the account was deleted' WHERE id=$1", running)
	}}
	worker := export.NewService(e.db, store, e.app.ExportStore, e.app.Sharing, zerolog.Nop())
	if _, err := worker.ProcessPending(context.Background()); err != nil {
		t.Fatal(err)
	}
	if status, _, _ := e.exportJob(running); status != "failed" {
		t.Fatalf("cancelled job: %s", status)
	}
	if _, err := e.app.ExportStore.Size(context.Background(), "exports/"+running+".zip"); err == nil {
		t.Fatal("the archive of a cancelled job was kept")
	}
}

// A vault deleted after the request is not archived.
func TestExportSkipsADeletedVault(t *testing.T) {
	e, ada, v, _ := exportFixture(t)
	id := ada.startExport(v)["id"].(string)
	expect(t, ada.json(http.MethodDelete, "/vaults/"+v, nil), http.StatusNoContent)
	if _, err := e.app.Exports.ProcessPending(context.Background()); err != nil {
		t.Fatal(err)
	}
	if status, msg, _ := e.exportJob(id); status != "failed" || msg != "the vault was deleted" {
		t.Fatalf("job of a deleted vault: %s %q", status, msg)
	}
	if _, err := e.app.ExportStore.Size(context.Background(), "exports/"+id+".zip"); err == nil {
		t.Fatal("a deleted vault was archived")
	}
}

// The internal error of a failed build stays in the log: the client gets a
// generic message.
func TestExportFailureHidesTheInternalError(t *testing.T) {
	e, ada, v, _ := exportFixture(t)
	id := ada.startExport(v)["id"].(string)
	var hash string
	if err := e.db.Pool.QueryRow(context.Background(), "SELECT blob_hash FROM files WHERE vault_id=$1 AND path='Home.md'", v).Scan(&hash); err != nil {
		t.Fatal(err)
	}
	if err := e.app.Store.Delete(context.Background(), "blobs/"+hash[:2]+"/"+hash); err != nil {
		t.Fatal(err)
	}
	e.staleArchive(id)
	if _, err := e.app.Exports.ProcessPending(context.Background()); err != nil {
		t.Fatal(err)
	}
	got := decode[map[string]any](t, ada.json(http.MethodGet, "/vaults/"+v+"/exports/"+id, nil))
	if got["status"] != "failed" || got["error"] != "a file of the vault is missing from the storage" {
		t.Fatalf("failed job: %v", got)
	}
	// Nothing deletes the archive of a failed job later: it goes now.
	if _, err := e.app.ExportStore.Size(context.Background(), "exports/"+id+".zip"); err == nil {
		t.Fatal("the archive of a failed build was kept")
	}
}

// staleArchive stores an archive for a job, as a build that uploaded it and
// then failed or was interrupted before finishing the job leaves it.
func (e *env) staleArchive(job string) {
	e.t.Helper()
	if err := e.app.ExportStore.Put(context.Background(), "exports/"+job+".zip", strings.NewReader("PK"), 2); err != nil {
		e.t.Fatal(err)
	}
}

// The account export holds the whole audit trail, past any page size.
func TestAccountExportHoldsTheWholeAuditLog(t *testing.T) {
	e := newEnv(t)
	ada := e.user("ada-audit-all")
	e.exec(`INSERT INTO audit_log (actor_id, action, target_type, target_id)
		SELECT $1::uuid, 'test.bulk', 'user', $1::uuid::text FROM generate_series(1, 2345)`, ada.uid())
	resp := ada.json(http.MethodGet, "/me/export", nil)
	expect(t, resp, http.StatusOK)
	got := decodeString[map[string]any](t, readAllString(t, resp))
	entries := got["audit_log"].([]any)
	bulk, last := 0, 0.0
	for _, a := range entries {
		m := a.(map[string]any)
		if m["action"] == "test.bulk" {
			bulk++
		}
		if id := m["id"].(float64); id <= last {
			t.Fatalf("audit log out of order at %v", id)
		} else {
			last = id
		}
	}
	if bulk != 2345 {
		t.Fatalf("%d bulk entries in the export, want 2345", bulk)
	}
	if got["profile"] == nil || got["notice"] == "" {
		t.Fatalf("export: %v", got)
	}
}

// config.assignments.set records an object the audit console can show.
func TestConfigAssignmentsAuditIsAnObject(t *testing.T) {
	e := newEnv(t)
	admin := e.admin("root-assign")
	ctx := context.Background()
	g := e.group("assign-audit", admin)
	p := decode[map[string]any](t, admin.json(http.MethodPost, "/admin/config-profiles", map[string]any{"name": "Audit " + newID()[:8], "config": map[string]any{}}))
	expect(t, admin.json(http.MethodPut, "/admin/groups/"+g.String()+"/config-profiles", map[string]any{"items": []map[string]any{{"profile_id": p["id"], "priority": 7}}}), http.StatusNoContent)
	var kind, profile string
	var priority int
	err := e.db.Pool.QueryRow(ctx, `SELECT jsonb_typeof(details), details->'assignments'->0->>'profile_id', (details->'assignments'->0->>'priority')::int
		FROM audit_log WHERE action='config.assignments.set' AND target_id=$1 ORDER BY id DESC LIMIT 1`, g.String()).Scan(&kind, &profile, &priority)
	if err != nil {
		t.Fatal(err)
	}
	if kind != "object" || profile != p["id"] || priority != 7 {
		t.Fatalf("details: %s %s %d", kind, profile, priority)
	}
}
