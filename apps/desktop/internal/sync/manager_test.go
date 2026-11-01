package sync

import (
	"context"
	"path/filepath"
	stdsync "sync"
	"testing"
	"time"

	"github.com/rs/zerolog"

	"memobrain/apps/desktop/internal/store"
	"memobrain/apps/desktop/internal/sync/transport"
	"memobrain/apps/desktop/internal/vault"
	"memobrain/shared/pathrules"
)

// offlineSession is signed in but has no client: every cycle fails fast with
// errSignedOut, after the engine announced PhaseSyncing.
type offlineSession struct{}

func (offlineSession) Client() *transport.Client { return nil }
func (offlineSession) Info() (SessionInfo, bool) {
	return SessionInfo{DeviceID: "d", UserID: "u", DeviceName: "test"}, true
}

// slowCycle wires a Manager whose first cycle is held inside its status
// callback (holding the engine's cycle lock) for a while.
type slowCycle struct {
	inSync chan struct{}
	once   stdsync.Once
}

func (s *slowCycle) emit(name string, payload any) {
	st, ok := payload.(Status)
	if name != EventStatus || !ok || st.Phase != PhaseSyncing {
		return
	}
	first := false
	s.once.Do(func() { first = true })
	if first {
		close(s.inSync)
		time.Sleep(200 * time.Millisecond) // the cycle is busy
	}
}

// cycleOver reports whether no cycle of eng is running (Sync holds e.run).
func cycleOver(eng *Engine) bool {
	if !eng.run.TryLock() {
		return false
	}
	eng.run.Unlock()
	return true
}

func engineOfVault(t *testing.T, m *Manager, id string) *Engine {
	t.Helper()
	mv, err := m.get(id)
	if err != nil {
		t.Fatal(err)
	}
	eng := m.engineOf(mv)
	if eng == nil {
		t.Fatal("vault not linked")
	}
	return eng
}

func linkedVault(t *testing.T) *vault.FS {
	t.Helper()
	dir := t.TempDir()
	fs, err := vault.NewFS(dir)
	if err != nil {
		t.Fatal(err)
	}
	sdb, err := store.Open(context.Background(), filepath.Join(dir, pathrules.ConfigDir, "sync.db"), store.KindSync)
	if err != nil {
		t.Fatal(err)
	}
	db := NewDB(sdb)
	for k, v := range map[string]string{MetaCloudVault: "cloud-1", MetaKind: "shared"} {
		if err := db.SetMeta(context.Background(), k, v); err != nil {
			t.Fatal(err)
		}
	}
	_ = sdb.Close()
	return fs
}

// Detach returns only after the vault's loop has finished its cycle: the
// database it closes is never used by a cycle still running.
func TestManagerDetachWaitsForLoop(t *testing.T) {
	sc := &slowCycle{inSync: make(chan struct{})}
	m := NewManager(offlineSession{}, nil, zerolog.Nop(), sc.emit)
	if err := m.Attach(context.Background(), "v", linkedVault(t)); err != nil {
		t.Fatal(err)
	}
	<-sc.inSync
	eng := engineOfVault(t, m, "v")
	m.Detach("v")
	if !cycleOver(eng) {
		t.Fatal("Detach returned while the sync cycle was still running")
	}
}

// Unlink waits for the loop before erasing the state, and the loop never sees
// the engine disappear under it.
func TestManagerUnlinkWaitsForLoop(t *testing.T) {
	sc := &slowCycle{inSync: make(chan struct{})}
	m := NewManager(offlineSession{}, nil, zerolog.Nop(), sc.emit)
	if err := m.Attach(context.Background(), "v", linkedVault(t)); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { m.Detach("v") })
	<-sc.inSync
	eng := engineOfVault(t, m, "v")
	var wg stdsync.WaitGroup
	wg.Add(2)
	go func() { defer wg.Done(); _, _ = m.Status(context.Background(), "v") }()
	go func() { defer wg.Done(); _ = m.SyncNow("v") }()
	if err := m.Unlink(context.Background(), "v"); err != nil {
		t.Fatal(err)
	}
	wg.Wait()
	if !cycleOver(eng) {
		t.Fatal("Unlink returned while the sync cycle was still running")
	}
	if _, err := m.linked("v"); err == nil {
		t.Fatal("vault still linked after Unlink")
	}
}

// Re-attaching an open vault (or restarting a mount's engine) never runs two
// loops on one folder: the old one is gone before the new one starts.
func TestManagerReattachStopsOldLoopFirst(t *testing.T) {
	sc := &slowCycle{inSync: make(chan struct{})}
	m := NewManager(offlineSession{}, nil, zerolog.Nop(), sc.emit)
	fs := linkedVault(t)
	if err := m.Attach(context.Background(), "v", fs); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { m.Detach("v") })
	<-sc.inSync
	old := engineOfVault(t, m, "v")
	if err := m.Attach(context.Background(), "v", fs); err != nil {
		t.Fatal(err)
	}
	if !cycleOver(old) {
		t.Fatal("a new engine started while the old loop was still in its cycle")
	}
}
