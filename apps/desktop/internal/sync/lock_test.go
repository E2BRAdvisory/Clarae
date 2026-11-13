package sync

import (
	"context"
	"errors"
	"path/filepath"
	stdsync "sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/rs/zerolog"

	"clarae/apps/desktop/internal/crypto"
	"clarae/apps/desktop/internal/store"
	"clarae/apps/desktop/internal/vault"
	"clarae/shared/pathrules"
	"clarae/shared/syncproto"
)

const (
	lockCloud = "0194f0a8-0000-7000-8000-00000000bbbb"
	lockLocal = "diary"
)

// lockRemote is an empty server that accepts every commit (or fails them all
// when offline) and records, at each commit, whether the engine still had the
// key and whether the user would see the vault as locked.
type lockRemote struct {
	memRemote
	cm       *crypto.Manager
	offline  atomic.Bool
	onCommit func()

	mu      stdsync.Mutex
	commits []lockCommit
}

type lockCommit struct {
	ops        int
	keyPresent bool
	userLocked bool
}

func (r *lockRemote) Commit(ctx context.Context, req syncproto.CommitRequest) (syncproto.CommitResponse, error) {
	if r.offline.Load() {
		return syncproto.CommitResponse{}, errors.New("dial tcp: connection refused")
	}
	r.mu.Lock()
	r.commits = append(r.commits, lockCommit{ops: len(req.Ops), keyPresent: !r.cm.Cipher(lockCloud).Locked(), userLocked: r.cm.IsLocked(lockCloud)})
	hook := r.onCommit
	r.mu.Unlock()
	if hook != nil {
		hook()
	}
	return r.memRemote.Commit(ctx, req)
}

func (r *lockRemote) snapshot() []lockCommit {
	r.mu.Lock()
	defer r.mu.Unlock()
	return append([]lockCommit(nil), r.commits...)
}

// lockEvents records the EventLocked payloads and the first completed cycle.
type lockEvents struct {
	mu     stdsync.Mutex
	locked []LockedEvent
	synced chan struct{}
	once   stdsync.Once
}

func (l *lockEvents) emit(name string, payload any) {
	switch name {
	case EventLocked.Name():
		l.mu.Lock()
		l.locked = append(l.locked, payload.(LockedEvent))
		l.mu.Unlock()
	case EventStatus.Name():
		if st, ok := payload.(Status); ok && st.Phase == PhaseIdle && !st.LastSync.IsZero() {
			l.once.Do(func() { close(l.synced) })
		}
	}
}

func (l *lockEvents) events() []LockedEvent {
	l.mu.Lock()
	defer l.mu.Unlock()
	return append([]LockedEvent(nil), l.locked...)
}

type lockFixture struct {
	m      *Manager
	cm     *crypto.Manager
	remote *lockRemote
	events *lockEvents
	dir    string
	clock  *atomic.Int64
}

func (f *lockFixture) advance(d time.Duration) { f.clock.Add(int64(d)) }

// newLockFixture attaches an unlocked private vault (idle timeout 10 min)
// whose first cycle is over and whose loop is waiting for its next poll.
func newLockFixture(t *testing.T) *lockFixture {
	t.Helper()
	clock := &atomic.Int64{}
	clock.Store(time.Date(2026, 11, 1, 12, 0, 0, 0, time.UTC).UnixNano())
	cm := crypto.NewManager(crypto.Options{Store: crypto.NewMemoryStore(), Now: func() time.Time { return time.Unix(0, clock.Load()) }, KDFTarget: time.Millisecond})
	mat, err := cm.NewMaterial("correct horse battery staple")
	if err != nil {
		t.Fatal(err)
	}
	if err := cm.Adopt(lockCloud, mat); err != nil {
		t.Fatal(err)
	}
	cm.SetLockTimeout(10 * time.Minute)

	dir := t.TempDir()
	fs, err := vault.NewFS(dir)
	if err != nil {
		t.Fatal(err)
	}
	sdb, err := store.Open(context.Background(), filepath.Join(dir, pathrules.ConfigDir, "sync.db"), store.KindSync)
	if err != nil {
		t.Fatal(err)
	}
	for k, v := range map[string]string{MetaCloudVault: lockCloud, MetaKind: "private"} {
		if err := NewDB(sdb).SetMeta(context.Background(), k, v); err != nil {
			t.Fatal(err)
		}
	}
	_ = sdb.Close()

	ev := &lockEvents{synced: make(chan struct{})}
	rem := &lockRemote{cm: cm}
	m := NewManager(offlineSession{}, cm, zerolog.Nop(), ev.emit)
	m.remoteFor = func(string) Remote { return rem }
	if err := m.Attach(context.Background(), lockLocal, fs); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { m.Detach(lockLocal) })
	select {
	case <-ev.synced:
	case <-time.After(10 * time.Second):
		t.Fatal("the first cycle did not complete")
	}
	return &lockFixture{m: m, cm: cm, remote: rem, events: ev, dir: dir, clock: clock}
}

// The idle sweep pushes the pending change while the engine still has the
// key (the vault already looks locked to the user, and the idle check does not
// take the key away mid-drain), then forgets the key and reports nothing left.
func TestIdleLockDrainsBeforeForgettingTheKey(t *testing.T) {
	f := newLockFixture(t)
	writeFile(t, f.dir, "note.md", []byte("written just before going idle"))
	f.advance(11 * time.Minute)

	f.m.lockIdleVaults()

	commits := f.remote.snapshot()
	if len(commits) == 0 || commits[len(commits)-1].ops == 0 {
		t.Fatalf("the pending change was not pushed before the lock: %+v", commits)
	}
	last := commits[len(commits)-1]
	if !last.keyPresent || !last.userLocked {
		t.Fatalf("drain commit: key present %v (want true), user sees locked %v (want true)", last.keyPresent, last.userLocked)
	}
	if !f.cm.Cipher(lockCloud).Locked() {
		t.Fatal("the key is still in memory after the idle lock")
	}
	want := LockedEvent{VaultID: lockLocal, Reason: LockReasonIdle, Pending: 0, Conflicts: 0}
	if got := f.events.events(); len(got) != 1 || got[0] != want {
		t.Fatalf("vault:locked = %+v, want [%+v]", got, want)
	}
	if st := engineOfVault(t, f.m, lockLocal).Status(); st.Phase != PhaseLocked || st.Pending != 0 {
		t.Fatalf("status after the lock: %+v", st)
	}
}

// Offline, the drain fails but the vault is locked anyway: the change stays in
// the outbox and the event says so, so the clear-text copy is kept.
func TestIdleLockOfflineReportsPending(t *testing.T) {
	f := newLockFixture(t)
	f.remote.offline.Store(true)
	writeFile(t, f.dir, "note.md", []byte("cannot leave"))
	f.advance(11 * time.Minute)

	f.m.lockIdleVaults()

	if !f.cm.Cipher(lockCloud).Locked() {
		t.Fatal("the key is still in memory after the idle lock")
	}
	want := LockedEvent{VaultID: lockLocal, Reason: LockReasonIdle, Pending: 1, Conflicts: 0}
	if got := f.events.events(); len(got) != 1 || got[0] != want {
		t.Fatalf("vault:locked = %+v, want [%+v]", got, want)
	}
}

// A change no cycle has scanned yet (the vault is paused) is still counted.
func TestLockCountsUnscannedChanges(t *testing.T) {
	f := newLockFixture(t)
	if err := f.m.SetPaused(context.Background(), lockLocal, true); err != nil {
		t.Fatal(err)
	}
	writeFile(t, f.dir, "note.md", []byte("paused"))
	if err := f.m.LockVault(context.Background(), lockLocal); err != nil {
		t.Fatal(err)
	}
	want := LockedEvent{VaultID: lockLocal, Reason: LockReasonManual, Pending: 1, Conflicts: 0}
	if got := f.events.events(); len(got) != 1 || got[0] != want {
		t.Fatalf("vault:locked = %+v, want [%+v]", got, want)
	}
}

// Locking by hand pushes first too.
func TestLockVaultDrains(t *testing.T) {
	f := newLockFixture(t)
	writeFile(t, f.dir, "note.md", []byte("locked by hand"))

	if err := f.m.LockVault(context.Background(), lockLocal); err != nil {
		t.Fatal(err)
	}

	commits := f.remote.snapshot()
	if len(commits) == 0 || commits[len(commits)-1].ops == 0 || !commits[len(commits)-1].keyPresent {
		t.Fatalf("the pending change was not pushed before the lock: %+v", commits)
	}
	if !f.cm.Cipher(lockCloud).Locked() {
		t.Fatal("the key is still in memory after LockVault")
	}
	want := LockedEvent{VaultID: lockLocal, Reason: LockReasonManual, Pending: 0, Conflicts: 0}
	if got := f.events.events(); len(got) != 1 || got[0] != want {
		t.Fatalf("vault:locked = %+v, want [%+v]", got, want)
	}
}

// A vault the user unlocks again while it drains stays unlocked, silently.
func TestIdleLockSkipsVaultUnlockedDuringDrain(t *testing.T) {
	f := newLockFixture(t)
	mat, err := f.cm.NewMaterial("another correct horse battery")
	if err != nil {
		t.Fatal(err)
	}
	f.remote.mu.Lock()
	f.remote.onCommit = func() { _ = f.cm.Adopt(lockCloud, mat) }
	f.remote.mu.Unlock()
	writeFile(t, f.dir, "note.md", []byte("x"))
	f.advance(11 * time.Minute)

	f.m.lockIdleVaults()

	if f.cm.IsLocked(lockCloud) {
		t.Fatal("the vault unlocked during the drain was locked")
	}
	if got := f.events.events(); len(got) != 0 {
		t.Fatalf("vault:locked sent for a vault left open: %+v", got)
	}
}

// Activity restarts the idle timer: nothing is locked.
func TestActivityPostponesIdleLock(t *testing.T) {
	f := newLockFixture(t)
	f.advance(9 * time.Minute)
	f.m.Activity()
	f.advance(9 * time.Minute)

	f.m.lockIdleVaults()

	if f.cm.IsLocked(lockCloud) || len(f.events.events()) != 0 {
		t.Fatal("an active vault was locked")
	}
}
