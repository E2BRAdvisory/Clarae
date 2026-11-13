package sync

import (
	"context"
	"errors"
	"net/http"
	"os"
	"path/filepath"
	"slices"
	stdsync "sync"
	"testing"
	"time"

	"github.com/rs/zerolog"

	"clarae/apps/desktop/internal/sync/transport"
	"clarae/shared/syncproto"
)

// switchSession is a signed-in account whose device can be revoked and replaced.
type switchSession struct {
	mu       stdsync.Mutex
	deviceID string
	revoked  bool
}

func (*switchSession) Client() *transport.Client { return nil }

func (s *switchSession) Info() (SessionInfo, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	info := SessionInfo{DeviceID: s.deviceID, UserID: "u", DeviceName: "test"}
	if s.revoked {
		info.DeviceRevoked = true
		return info, false
	}
	return info, true
}

func (s *switchSession) set(id string, revoked bool) {
	s.mu.Lock()
	s.deviceID, s.revoked = id, revoked
	s.mu.Unlock()
}

// revokingServer refuses the commits of revoked devices as the cloud does.
type revokingServer struct {
	*folderServer
	mu      stdsync.Mutex
	revoked map[string]bool
	refused int
}

func (s *revokingServer) revoke(id string) {
	s.mu.Lock()
	s.revoked[id] = true
	s.mu.Unlock()
}

func (s *revokingServer) Commit(ctx context.Context, req syncproto.CommitRequest) (syncproto.CommitResponse, error) {
	s.mu.Lock()
	refused := s.revoked[req.DeviceID]
	if refused {
		s.refused++
	}
	s.mu.Unlock()
	if refused {
		return syncproto.CommitResponse{}, &transport.ProblemError{StatusCode: http.StatusForbidden, Problem: syncproto.Problem{
			Status: http.StatusForbidden, Code: syncproto.CodeForbidden, Detail: "device revoked",
			Extra: map[string]any{"reason": syncproto.ReasonDeviceRevoked},
		}}
	}
	return s.folderServer.Commit(ctx, req)
}

func waitTill(t *testing.T, what string, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(15 * time.Second)
	for !cond() {
		if time.Now().After(deadline) {
			t.Fatalf("timed out waiting: %s", what)
		}
		time.Sleep(10 * time.Millisecond)
	}
}

// A revoked device stops every engine, keeps the local files and the pending
// changes, says so in the status, refuses SyncNow; once the account registers a
// new device the engines restart with it and push what waited.
func TestManagerDeviceRevokedStopsAndResumes(t *testing.T) {
	srv := &revokingServer{folderServer: newFolderServer(), revoked: map[string]bool{}}
	sess := &switchSession{deviceID: "dev-1"}
	var mu stdsync.Mutex
	var hooked []string
	var events []Status
	m := NewManager(sess, nil, zerolog.Nop(), func(name string, payload any) {
		if st, ok := payload.(Status); ok && name == EventStatus.Name() {
			mu.Lock()
			events = append(events, st)
			mu.Unlock()
		}
	})
	m.remoteFor = func(string) Remote { return srv }
	m.SetHooks(Hooks{DeviceRevoked: func(id string) {
		mu.Lock()
		hooked = append(hooked, id)
		mu.Unlock()
		sess.set(id, true) // what the application does: the session becomes device_revoked
		m.SessionChanged()
	}})
	fs := linkedVault(t)
	if err := m.Attach(context.Background(), "v", fs); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { m.Detach("v") })
	// Linked with dev-1, as saveLink records it.
	if mv, _ := m.get("v"); mv != nil {
		_ = mv.db.SetMeta(context.Background(), MetaDeviceID, "dev-1")
		_ = mv.db.SetMeta(context.Background(), MetaUserID, "u")
	}
	write := func(name, content string) {
		t.Helper()
		if err := os.WriteFile(filepath.Join(fs.Root(), name), []byte(content), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	status := func() Status {
		st, err := m.Status(context.Background(), "v")
		if err != nil {
			t.Fatal(err)
		}
		return st
	}

	write("a.md", "before\n")
	if err := m.SyncNow("v"); err != nil {
		t.Fatal(err)
	}
	waitTill(t, "a.md uploaded", func() bool { return slices.Contains(srv.paths(), "a.md") })

	srv.revoke("dev-1")
	write("b.md", "after the revocation\n")
	if err := m.SyncNow("v"); err != nil {
		t.Fatal(err)
	}
	waitTill(t, "the revocation is noticed", func() bool {
		mu.Lock()
		defer mu.Unlock()
		return len(hooked) > 0
	})
	mu.Lock()
	if hooked[0] != "dev-1" {
		t.Fatalf("hook called with %v", hooked)
	}
	mu.Unlock()
	mv, _ := m.get("v")
	waitTill(t, "the loop stops", func() bool {
		m.mu.Lock()
		defer m.mu.Unlock()
		return !mv.running
	})
	st := status()
	if st.Phase != PhaseOffline || st.Error != DeviceRevokedMessage || st.Pending == 0 {
		t.Fatalf("status while revoked = %+v", st)
	}
	mu.Lock()
	last := events[len(events)-1]
	mu.Unlock()
	if last.Phase != PhaseOffline || last.Error != DeviceRevokedMessage {
		t.Fatalf("last status event = %+v", last)
	}
	if err := m.SyncNow("v"); !errors.Is(err, ErrDeviceRevoked) {
		t.Fatalf("SyncNow while revoked = %v", err)
	}
	if slices.Contains(srv.paths(), "b.md") {
		t.Fatal("b.md reached the server with a revoked device")
	}
	if _, err := os.Stat(filepath.Join(fs.Root(), "b.md")); err != nil {
		t.Fatalf("the local file is gone: %v", err)
	}
	srv.mu.Lock()
	refused := srv.refused
	srv.mu.Unlock()
	time.Sleep(100 * time.Millisecond)
	srv.mu.Lock()
	if srv.refused != refused {
		t.Fatalf("the engine kept committing after the revocation (%d then %d refusals)", refused, srv.refused)
	}
	srv.mu.Unlock()

	// Registered again: a new device id, a new engine, and the pending file goes out.
	sess.set("dev-2", false)
	m.SessionChanged()
	waitTill(t, "b.md uploaded with the new device", func() bool { return slices.Contains(srv.paths(), "b.md") })
	if got := engineOfVault(t, m, "v").DeviceID(); got != "dev-2" {
		t.Fatalf("engine device = %q", got)
	}
	if id, _ := mv.db.Meta(context.Background(), MetaDeviceID); id != "dev-2" {
		t.Fatalf("recorded device = %q", id)
	}
	_ = m.SyncNow("v")
	waitTill(t, "idle with nothing pending", func() bool {
		st := status()
		return st.Phase == PhaseIdle && st.Pending == 0 && st.Error == ""
	})
}

// SyncNow guarantees a scan that starts after the call: the status is never a
// stale idle in between, and requests made before that scan coalesce.
func TestEngineRequestScan(t *testing.T) {
	srv := newFolderServer()
	sess := &switchSession{deviceID: "dev-1"}
	m := NewManager(sess, nil, zerolog.Nop(), nil)
	m.remoteFor = func(string) Remote { return srv }
	fs := linkedVault(t)
	if err := m.Attach(context.Background(), "v", fs); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { m.Detach("v") })
	eng := engineOfVault(t, m, "v")
	idle := func() bool {
		st, _ := m.Status(context.Background(), "v")
		return st.Phase == PhaseIdle && !eng.ScanDue()
	}
	waitTill(t, "the first cycle ends", idle)

	// Written, then SyncNow: the very next status read is not "idle, nothing pending".
	if err := os.WriteFile(filepath.Join(fs.Root(), "late.md"), []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := m.SyncNow("v"); err != nil {
		t.Fatal(err)
	}
	if st, _ := m.Status(context.Background(), "v"); st.Phase == PhaseIdle {
		t.Fatalf("status right after SyncNow = %+v", st)
	}
	waitTill(t, "late.md uploaded and idle", func() bool { return idle() && slices.Contains(srv.paths(), "late.md") })

	// Many requests while no scan ran yet are one request.
	before := eng.Status().LastSync
	for range 20 {
		eng.RequestScan()
	}
	if !eng.ScanDue() {
		t.Fatal("no scan due after RequestScan")
	}
	if err := eng.Sync(context.Background()); err != nil {
		t.Fatal(err)
	}
	if eng.ScanDue() || eng.Status().Phase != PhaseIdle || !eng.Status().LastSync.After(before) {
		t.Fatalf("after one cycle: due=%v status=%+v", eng.ScanDue(), eng.Status())
	}
}
